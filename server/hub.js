// The realtime side: one socket per page, commands in, state out. Every page gets the same
// broadcasts, so the laptop, the phone and the wall can't drift apart.

import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GameError } from '../game/engine.js';
import { DEFAULT_TABLE, sanitizeCalibration } from '../public/js/calibration.js';
import { controlPoints, defaultCorners } from '../public/js/geometry.js';
import { isLoopback } from './network.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_WALL_PIXELS = 65_536;
const MAX_REQUEST_ID_LENGTH = 64;
const DEFAULT_WALL = { width: 1920, height: 1080 };
const ROLES = new Set(['control', 'output', 'dealer']);
const VIEWS = new Set(['projection', 'game']);
const NEEDS_NO_CONTROL = new Set(['hello', 'ping']);

const { keystone, fine } = controlPoints(DEFAULT_TABLE);
const POINT_IDS = new Set([...keystone, ...fine, { id: 'move' }].map((point) => point.id));

const SCREEN_FIELDS = {
  view: (value) => VIEWS.has(value),
  showPoints: (value) => typeof value === 'boolean',
  selectedPoint: (value) => value === null || POINT_IDS.has(value),
};

const refuse = (code, message) => new GameError(code, message);

// Not saved, because the game says it all: a restart mid game goes straight back to the game, even
// if the wall reconnects first or nothing else ever does.
const startingView = ({ view: { phase } }) => (phase === 'lobby' ? 'projection' : 'game');

function parseMessage(data, isBinary) {
  if (isBinary) return null;
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function requestIdOf(message) {
  const id = message?.requestId;
  const isShortString = typeof id === 'string' && id.length <= MAX_REQUEST_ID_LENGTH;
  return Number.isSafeInteger(id) || isShortString ? id : null;
}

function failureOf(error) {
  if (error instanceof GameError) return { code: error.code, message: error.message };
  console.error('Command failed:', error);
  return { code: 'internal', message: 'Something went wrong.' };
}

function requireVersion(version) {
  if (!Number.isSafeInteger(version)) throw refuse('bad-request', 'A version is required.');
}

function requireWallSize({ width, height }) {
  const isSize = (value) => Number.isFinite(value) && value >= 1 && value <= MAX_WALL_PIXELS;
  if (!isSize(width) || !isSize(height)) throw refuse('bad-request', 'That size is not usable.');
}

export function createHub({ session, calibration, stores, gate }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const clients = new Map();
  const screen = { view: startingView(session), showPoints: true, selectedPoint: null };
  const anyStoreFailing = () => Object.values(stores).some((store) => store.failed);
  let wallSize = DEFAULT_WALL;
  let wallReports = 0;
  let saveFailed = anyStoreFailing();

  const withRole = (role) => [...clients.values()].filter((client) => client.role === role);
  const anyWithControl = (role) => withRole(role).some((client) => client.canControl);

  function sendTo({ socket }, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    // A client that stopped reading would otherwise have everything queued here, without end.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.terminate();
    else socket.send(JSON.stringify(message));
  }

  // Only sockets that said hello, so a page always starts from its welcome and snapshot.
  function broadcast(message, except = null) {
    for (const client of clients.values()) {
      if (client.role !== null && client !== except) sendTo(client, message);
    }
  }

  // A reload can overlap its old socket and a second window can close, so when a wall goes the
  // size to show is that of the newest one still open. With none open, the last size stands.
  function fallBackToOpenWall() {
    const reported = withRole('output').filter((client) => client.wallReport > 0);
    const [newest] = reported.sort((a, b) => b.wallReport - a.wallReport);
    if (newest) wallSize = newest.wallSize;
  }

  const calibrationMessage = (origin) => ({
    type: 'calibration',
    calibration: calibration.current,
    canUndo: calibration.canUndo,
    canRedo: calibration.canRedo,
    origin,
  });

  const sessionMessage = () => ({
    type: 'session',
    ...screen,
    output: { connected: anyWithControl('output'), ...wallSize },
    dealerConnected: anyWithControl('dealer'),
    saveFailed,
  });

  const gameMessage = () => ({
    type: 'game',
    game: session.view,
    version: session.version,
    canUndo: session.canUndo,
    undoLabel: session.undoLabel,
  });

  function hello(client, { role, key }) {
    if (client.role !== null) throw refuse('bad-request', 'This socket already said hello.');
    if (!ROLES.has(role)) throw refuse('bad-request', 'Unknown role.');
    client.role = role;
    // Read before the key is checked: the wrong guess that starts a block was still looked at.
    const blocked = gate.isBlocked(client.address);
    const retryInMs = gate.blockLeftMs(client.address);
    client.canControl = gate.mayControl(client.address, key);
    sendTo(client, {
      type: 'welcome',
      connectionId: client.id,
      canControl: client.canControl,
      blocked,
      retryInMs,
    });
    sendTo(client, calibrationMessage(null));
    sendTo(client, sessionMessage());
    sendTo(client, gameMessage());
    if (role !== 'control') broadcast(sessionMessage(), client);
  }

  function reportWallSize(client, message) {
    if (client.role !== 'output') throw refuse('forbidden', 'Only the wall reports its size.');
    requireWallSize(message);
    wallReports += 1;
    wallSize = { width: message.width, height: message.height };
    client.wallSize = wallSize;
    client.wallReport = wallReports;
    broadcast(sessionMessage());
  }

  // A retry runs on its own timer, so recovery has to be heard from the stores, not from a command.
  function syncSaveFailed() {
    if (anyStoreFailing() === saveFailed) return;
    saveFailed = !saveFailed;
    broadcast(sessionMessage());
  }

  // The ack waits for the disk, so while saves work a crash can't lose an action the dealer saw
  // answered. A failed save is still acked, because the action did happen. saveFailed carries the
  // warning, as a crash before the next good write would lose that action.
  async function changeGame(change) {
    change();
    broadcast(gameMessage());
    stores.game.save(session.serialize());
    await stores.game.flush();
  }

  function dispatch(_client, { action, version }) {
    requireVersion(version);
    return changeGame(() => session.dispatch(action, version));
  }

  function undoGame(_client, { version }) {
    requireVersion(version);
    return changeGame(() => session.undo(version));
  }

  // `origin` marks an echo of what that client just sent, which it may ignore mid-drag. Undo,
  // redo and resets are new to everyone, so they go out with no origin.
  function calibrationChanged(origin) {
    stores.calibration.save(calibration.current);
    broadcast(calibrationMessage(origin));
  }

  function beginEdit(client) {
    calibration.begin();
    broadcast(calibrationMessage(client.id));
  }

  function updateCalibration(client, { calibration: raw }) {
    const clean = sanitizeCalibration(raw);
    if (!clean) throw refuse('bad-request', 'That calibration is not usable.');
    calibration.update(clean);
    calibrationChanged(client.id);
  }

  function undoCalibration() {
    calibration.undo();
    calibrationChanged(null);
  }

  function redoCalibration() {
    calibration.redo();
    calibrationChanged(null);
  }

  // Keeps the table size, theme and pattern: a reset is about where the points are.
  function afterReset(scope) {
    const { current } = calibration;
    if (scope === 'fine') return { ...current, offsets: {} };
    const aspect = wallSize.width / wallSize.height;
    return { ...current, offsets: {}, corners: defaultCorners(current.table, aspect) };
  }

  function resetCalibration(_client, { scope }) {
    if (scope !== 'fine' && scope !== 'all') throw refuse('bad-request', 'Unknown reset scope.');
    calibration.replace(afterReset(scope));
    calibrationChanged(null);
  }

  function setScreen(_client, message) {
    const fields = Object.keys(SCREEN_FIELDS).filter((field) => Object.hasOwn(message, field));
    const isValid = fields.every((field) => SCREEN_FIELDS[field](message[field]));
    if (fields.length === 0 || !isValid) throw refuse('bad-request', 'That setting is not usable.');
    for (const field of fields) screen[field] = message[field];
    broadcast(sessionMessage());
  }

  // Only this computer ever sees the code, so only it can replace it: a phone that shouldn't have
  // been paired must not be able to lock everyone else out. Control is decided at hello, which is
  // why a paired device has to be cut off here. It comes back as a stranger with an old code.
  async function replacePairingCode(client) {
    if (!isLoopback(client.address)) {
      throw refuse('forbidden', 'Only the laptop can change the code.');
    }
    stores.pairing.save({ code: gate.newCode() });
    for (const other of clients.values()) {
      if (other.canControl && !isLoopback(other.address)) other.socket.terminate();
    }
    await stores.pairing.flush();
  }

  // A Map, not an object: a message of type "constructor" must not find anything here.
  const commands = new Map([
    ['hello', hello],
    ['ping', () => {}],
    ['output:size', reportWallSize],
    ['game:action', dispatch],
    ['game:undo', undoGame],
    ['calibration:begin', beginEdit],
    ['calibration:update', updateCalibration],
    ['calibration:undo', undoCalibration],
    ['calibration:redo', redoCalibration],
    ['calibration:reset', resetCalibration],
    ['session:set', setScreen],
    ['pairing:new', replacePairingCode],
  ]);

  async function route(client, message) {
    const command = commands.get(message?.type);
    if (!command) throw refuse('bad-request', 'Unknown message.');
    if (!NEEDS_NO_CONTROL.has(message.type) && !client.canControl) {
      throw refuse('forbidden', 'This device is not paired.');
    }
    await command(client, message);
  }

  async function receive(client, data, isBinary) {
    const message = parseMessage(data, isBinary);
    const requestId = requestIdOf(message);
    try {
      await route(client, message);
      if (message.type !== 'hello') sendTo(client, { type: 'ack', requestId });
    } catch (error) {
      sendTo(client, { type: 'error', requestId, ...failureOf(error) });
    }
  }

  function accept(socket, request) {
    const client = {
      id: randomUUID(),
      socket,
      address: request.socket.remoteAddress,
      role: null,
      canControl: false,
      alive: true,
      wallSize: null,
      wallReport: 0,
    };
    clients.set(socket, client);
    // Only a pong: a client can keep sending while it has stopped reading.
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      receive(client, data, isBinary);
    });
    // Without a listener a bad frame would crash the process. ws closes the socket itself.
    socket.on('error', () => {});
    socket.on('close', () => {
      clients.delete(socket);
      if (client.role === 'output') fallBackToOpenWall();
      if (client.role === 'output' || client.role === 'dealer') broadcast(sessionMessage());
    });
  }

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
      } else {
        client.alive = false;
        client.socket.ping();
      }
    }
  }, HEARTBEAT_MS);

  for (const store of Object.values(stores)) store.onFailedChange(syncSaveFailed);

  return {
    upgrade(request, socket, head) {
      server.handleUpgrade(request, socket, head, (ws) => accept(ws, request));
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of clients.keys()) socket.terminate();
      server.close();
    },
  };
}
