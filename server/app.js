// Puts the server together. Everything it depends on comes in as an option, so a test can run a
// real server on a spare port with its own data directory and close it cleanly.

import http, { STATUS_CODES } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../game/session.js';
import { createDefaultCalibration, sanitizeCalibration } from '../public/js/calibration.js';
import { createCalibrationEditor } from './calibrationEditor.js';
import { createHub } from './hub.js';
import { phoneAddresses, phoneUrl, upgradeRefusal } from './network.js';
import { MIN_HOST_PASSWORD_LENGTH, createGate, loadPairingCode } from './pairing.js';
import { createStore } from './store.js';
import { createWebApp } from './web.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function loadCalibration(store) {
  const saved = await store.load();
  if (saved === undefined) return createDefaultCalibration();
  const clean = sanitizeCalibration(saved);
  if (clean) return clean;
  console.warn('Ignoring unusable calibration.json');
  await store.keepDamaged();
  return createDefaultCalibration();
}

async function loadSession(store) {
  const session = createSession(await store.load());
  if (session.damage === null) return session;
  const dropped = session.damage === 'history' ? 'undo history in game.json' : 'game.json';
  console.warn(`Ignoring unusable ${dropped}`);
  await store.keepDamaged();
  return session;
}

function isTaken(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    probe.listen(port, host, () => probe.close(() => resolve(false)));
  });
}

// The OS lets a 0.0.0.0 listener share its port with a program already on loopback, and loopback
// wins. This computer would quietly get that program while phones got this one.
async function requireFreeLoopback(port) {
  if (!(await isTaken(port, '127.0.0.1')) && !(await isTaken(port, '::1'))) return;
  throw Object.assign(new Error(`Port ${port} is already in use.`), { code: 'EADDRINUSE' });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      server.on('error', (error) => console.error(`Server error: ${error.message}`));
      resolve();
    });
  });
}

function refuseUpgrade(socket, status) {
  const head = `HTTP/1.1 ${status} ${STATUS_CODES[status]}`;
  socket.end(`${head}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

export async function startServer({
  port,
  dataDir,
  host = '0.0.0.0',
  publicDir = PUBLIC_DIR,
  now,
  publicUrl = null,
  hostPassword = null,
}) {
  const isHosted = publicUrl !== null;
  if (isHosted && (hostPassword?.length ?? 0) < MIN_HOST_PASSWORD_LENGTH) {
    throw new Error(`HOST_PASSWORD must be at least ${MIN_HOST_PASSWORD_LENGTH} characters.`);
  }
  const publicOrigin = isHosted ? new URL(publicUrl).origin : null;
  const publicHost = isHosted ? new URL(publicUrl).host : null;
  await requireFreeLoopback(port);

  const fileIn = (name) => path.join(dataDir, name);
  const stores = {
    calibration: createStore(fileIn('calibration.json'), { indent: 2 }),
    game: createStore(fileIn('game.json')),
    pairing: createStore(fileIn('pairing.json'), { indent: 2 }),
  };
  const code = await loadPairingCode(stores.pairing, isHosted);
  const gate = createGate(code, now, isHosted ? hostPassword : null);
  const calibration = createCalibrationEditor(await loadCalibration(stores.calibration));
  const session = await loadSession(stores.game);

  const httpServer = http.createServer();
  await listen(httpServer, port, host);
  const boundPort = httpServer.address().port;

  const app = createWebApp({ publicDir, port: boundPort, gate, publicUrl: publicOrigin });
  httpServer.on('request', app);
  const hub = createHub({ session, calibration, stores, gate });
  httpServer.on('upgrade', (request, socket, head) => {
    // Node stops watching a socket once it is handed over, so an error here would be fatal.
    socket.on('error', () => socket.destroy());
    const status = upgradeRefusal(request, boundPort, publicHost);
    if (status === null) hub.upgrade(request, socket, head);
    else refuseUpgrade(socket, status);
  });

  async function shutDown() {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    hub.close();
    httpServer.closeAllConnections();
    await closed;
    const saves = await Promise.all(Object.values(stores).map((store) => store.close()));
    return saves.every(Boolean);
  }

  let closing = null;
  return {
    port: boundPort,
    publicUrl: publicOrigin,
    phoneUrl: () => phoneUrl(phoneAddresses()[0], boundPort, gate.code),
    close() {
      closing ??= shutDown();
      return closing;
    },
  };
}
