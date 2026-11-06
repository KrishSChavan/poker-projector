import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createDefaultCalibration } from '../public/js/calibration.js';
import { defaultCorners } from '../public/js/geometry.js';
import { startServer } from '../server/app.js';
import { MAX_MESSAGE_BYTES } from '../server/hub.js';
import {
  isAllowedHost,
  isLoopback,
  isSameOrigin,
  lanAddresses,
  localNames,
  phoneAddresses,
} from '../server/network.js';
import { createGate } from '../server/pairing.js';
import { createStore } from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 10_000;
const LOOPBACK = '127.0.0.1';
const LAN_ADDRESS = lanAddresses()[0];
const onLan = { skip: LAN_ADDRESS ? false : 'no LAN address here, so nothing is non-loopback' };

// A copy of the save the user's running copy wrote, in exactly that format.
const USER_SAVE = {
  table: { lengthIn: 70, widthIn: 36, railIn: 5.25 },
  corners: [
    [0.27848347981770843, 0.11889573256751329],
    [0.7084834798177084, 0.11889573256751329],
    [0.7084834798177084, 0.9050626007658202],
    [0.27848347981770843, 0.9050626007658202],
  ],
  offsets: { 'l-up': [-1.211656673934101, -0.8080004894399604] },
  themeId: 'noir',
  pattern: 'table',
};

const add = (name) => ({ type: 'addPlayer', name });
const START = { type: 'startGame' };
const CALL = { type: 'call' };
const CHECK = { type: 'check' };
const FOLD = { type: 'fold' };
const raiseTo = (to) => ({ type: 'raise', to });
const isType = (type) => (message) => message.type === type;

const temporaryDirs = [];
after(() => Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'poker-server-'));
  temporaryDirs.push(dir);
  return dir;
}

async function boot(t, { dataDir, ...options } = {}) {
  const server = await startServer({
    port: 0,
    host: LOOPBACK,
    dataDir: dataDir ?? (await tempDir()),
    ...options,
  });
  t.after(() => server.close());
  return server;
}

function createPeer(url, options) {
  const socket = new WebSocket(url, options);
  const inbox = [];
  const watchers = new Set();
  let nextRequestId = 1;
  let closeCode = null;

  const wake = () => watchers.forEach((watcher) => watcher());
  socket.on('message', (data) => {
    inbox.push(JSON.parse(data.toString()));
    wake();
  });
  socket.on('close', (code) => {
    closeCode = code;
    wake();
  });
  socket.on('error', () => {});

  function waitFor(read, label) {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        watchers.delete(check);
      };
      const check = () => {
        const value = read();
        if (value === undefined) return;
        stop();
        resolve(value);
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`Timed out waiting for ${label}. Inbox: ${JSON.stringify(inbox)}`));
      }, TIMEOUT_MS);
      watchers.add(check);
      check();
    });
  }

  const peer = {
    socket,
    inbox,
    opened: once(socket, 'open'),
    send: (message) => socket.send(JSON.stringify(message)),
    sendRaw: (data, options) => socket.send(data, options),
    next: () => waitFor(() => inbox.shift(), 'the next message'),
    // The oldest message that matches, leaving the others queued in order.
    take(matches, label = 'a matching message') {
      return waitFor(() => {
        const at = inbox.findIndex(matches);
        return at < 0 ? undefined : inbox.splice(at, 1)[0];
      }, label);
    },
    ask(message) {
      const requestId = nextRequestId;
      nextRequestId += 1;
      peer.send({ ...message, requestId });
      const isReply = (reply) => reply.requestId === requestId;
      return peer.take(isReply, `the reply to ${message.type}`);
    },
    closed: () => waitFor(() => closeCode ?? undefined, 'the socket to close'),
  };
  return peer;
}

const socketUrl = (server, address = LOOPBACK) => `ws://${address}:${server.port}/ws`;

async function join(server, { address, role = 'control', key } = {}) {
  const peer = createPeer(socketUrl(server, address));
  await peer.opened;
  peer.send({ type: 'hello', role, key });
  peer.welcome = await peer.next();
  peer.calibration = await peer.next();
  peer.session = await peer.next();
  peer.game = await peer.next();
  return peer;
}

// Plays actions in order, starting from `version`. Returns the version it ends on.
async function play(peer, version, ...actions) {
  let at = version;
  for (const action of actions) {
    const reply = await peer.ask({ type: 'game:action', action, version: at });
    assert.equal(reply.type, 'ack', `${action.type} was refused: ${JSON.stringify(reply)}`);
    at += 1;
  }
  return at;
}

async function askOk(peer, message) {
  const reply = await peer.ask(message);
  assert.equal(reply.type, 'ack', `${message.type} was refused: ${JSON.stringify(reply)}`);
}

function assertRefused(reply, code) {
  assert.equal(reply.type, 'error', JSON.stringify(reply));
  assert.equal(reply.code, code);
  assert.equal(typeof reply.message, 'string');
}

function request(port, target, { address = LOOPBACK, host, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host === undefined ? {} : { Host: host };
    const call = http.request({ host: address, port, path: target, method, headers, agent: false });
    call.on('error', reject);
    call.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    call.end();
  });
}

async function pairingOf(server) {
  const response = await request(server.port, '/api/pairing');
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
}

// Resolves with the status the server answered an upgrade with, 101 when it was accepted.
function upgradeStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('open', () => {
      socket.terminate();
      resolve(101);
    });
    socket.on('unexpected-response', (call, response) => {
      resolve(response.statusCode);
      call.destroy();
    });
    socket.on('error', reject);
  });
}

function launch(dataDir, port = '0') {
  const env = { ...process.env, PORT: port, DATA_DIR: dataDir };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
  const running = { child, output: '', exited: once(child, 'exit') };
  running.ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      running.output += chunk;
      if (!running.output.includes('/dealer#')) return;
      running.port = Number(/localhost:(\d+)/.exec(running.output)[1]);
      resolve();
    });
    child.stderr.on('data', (chunk) => {
      running.output += chunk;
    });
    child.on('exit', () => reject(new Error(`Server stopped: ${running.output}`)));
  });
  running.ready.catch(() => {});
  return running;
}

// Sends exactly these bytes, for requests a normal HTTP client won't produce.
function rawStatus(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, LOOPBACK, () => socket.write(text));
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      reply += chunk;
      socket.end();
    });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d+)/.exec(reply)?.[1])));
    socket.on('error', reject);
  });
}

/* ---------- Snapshot on connect ---------- */

test('a new socket gets welcome, then one each of calibration, session and game', async (t) => {
  const server = await boot(t);
  const peer = createPeer(socketUrl(server));
  await peer.opened;
  peer.send({ type: 'hello', role: 'control', key: null });

  const welcome = await peer.next();
  assert.deepEqual(Object.keys(welcome).sort(), [
    'blocked',
    'canControl',
    'connectionId',
    'retryInMs',
    'type',
  ]);
  assert.equal(welcome.type, 'welcome');
  assert.equal(typeof welcome.connectionId, 'string');
  assert.equal(welcome.canControl, true);
  assert.equal(welcome.blocked, false);
  assert.equal(welcome.retryInMs, 0);

  assert.deepEqual(await peer.next(), {
    type: 'calibration',
    calibration: createDefaultCalibration(),
    canUndo: false,
    canRedo: false,
    origin: null,
  });
  assert.deepEqual(await peer.next(), {
    type: 'session',
    view: 'projection',
    showPoints: true,
    selectedPoint: null,
    output: { connected: false, width: 1920, height: 1080 },
    dealerConnected: false,
    saveFailed: false,
  });
  const game = await peer.next();
  assert.equal(game.type, 'game');
  assert.equal(game.game.phase, 'lobby');
  assert.equal(game.version, 0);
  assert.equal(game.canUndo, false);
  assert.equal(game.undoLabel, null);

  await peer.ask({ type: 'ping' });
  assert.deepEqual(peer.inbox, []);
});

test('each socket gets its own connection id', async (t) => {
  const server = await boot(t);
  const [first, second] = await Promise.all([join(server), join(server)]);
  assert.notEqual(first.welcome.connectionId, second.welcome.connectionId);
});

test('ping is acked for anyone, even before hello', async (t) => {
  const server = await boot(t);
  const peer = createPeer(socketUrl(server));
  await peer.opened;
  assert.deepEqual(await peer.ask({ type: 'ping' }), { type: 'ack', requestId: 1 });
});

test('nothing but ping works before hello, and nothing is broadcast to that socket', async (t) => {
  const server = await boot(t);
  const owner = await join(server);
  const peer = createPeer(socketUrl(server));
  await peer.opened;

  assertRefused(await peer.ask({ type: 'game:undo', version: 0 }), 'forbidden');
  await play(owner, 0, add('Alice'));
  await peer.ask({ type: 'ping' });
  assert.deepEqual(peer.inbox, []);
});

test('a second hello is refused and changes nothing', async (t) => {
  const server = await boot(t);
  const peer = await join(server, { role: 'dealer' });
  assertRefused(await peer.ask({ type: 'hello', role: 'output' }), 'bad-request');
  assertRefused(await peer.ask({ type: 'output:size', width: 100, height: 100 }), 'forbidden');
});

test('a hello with an unknown role is refused, and a good one can follow', async (t) => {
  const server = await boot(t);
  const peer = createPeer(socketUrl(server));
  await peer.opened;
  for (const role of ['admin', 42, null, undefined, 'constructor']) {
    assertRefused(await peer.ask({ type: 'hello', role }), 'bad-request');
  }
  peer.send({ type: 'hello', role: 'dealer' });
  assert.equal((await peer.next()).type, 'welcome');
});

test('a fire and forget command still gets an answer, with a null requestId', async (t) => {
  const server = await boot(t);
  const peer = await join(server);
  peer.send({ type: 'session:set', showPoints: false });
  assert.deepEqual(await peer.take(isType('ack')), { type: 'ack', requestId: null });
  peer.send({ type: 'session:set', showPoints: 'maybe' });
  const error = await peer.take(isType('error'));
  assert.equal(error.requestId, null);
  assert.equal(error.code, 'bad-request');
});

/* ---------- Game ---------- */

test('a game action reaches every socket before the sender gets its ack', async (t) => {
  const server = await boot(t);
  const [dealer, wall] = await Promise.all([
    join(server, { role: 'dealer' }),
    join(server, { role: 'output' }),
  ]);

  await askOk(dealer, { type: 'game:action', action: add('Alice'), version: 0 });

  assert.ok(dealer.inbox.some(isType('game')), 'the sender saw the new state before its ack');
  for (const peer of [dealer, wall]) {
    const update = await peer.take(isType('game'));
    assert.equal(update.version, 1);
    assert.deepEqual(update.game.players.map((player) => player.name), ['Alice']);
  }
});

test('the game message carries the view, version and undo state', async (t) => {
  const server = await boot(t);
  const dealer = await join(server);
  let version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START);

  await askOk(dealer, { type: 'game:action', action: raiseTo(40), version });
  version += 1;
  dealer.inbox.length = 0;
  await askOk(dealer, { type: 'game:action', action: CALL, version });
  const update = await dealer.take(isType('game'));

  assert.equal(update.version, version + 1);
  assert.equal(update.canUndo, true);
  assert.match(update.undoLabel, /called/);
  assert.equal(update.game.phase, 'betting');
  assert.equal(update.game.currentBet, 40);
  assert.equal(update.game.pot.total, 90);
});

test('an out of date version is refused as stale and changes nothing', async (t) => {
  const server = await boot(t);
  const [first, second] = await Promise.all([join(server), join(server)]);
  await play(first, 0, add('Alice'), add('Bob'), START);

  // A double tap: both sends carry the version the screen was showing.
  const version = 3;
  const [won, lost] = await Promise.all([
    first.ask({ type: 'game:action', action: CALL, version }),
    first.ask({ type: 'game:action', action: CALL, version }),
  ]);
  assert.equal(won.type, 'ack');
  assertRefused(lost, 'stale');

  // The other device was showing the same version, and the fresh state beat its error back.
  assertRefused(await second.ask({ type: 'game:action', action: FOLD, version }), 'stale');
  assert.ok(second.inbox.some((message) => message.type === 'game' && message.version === 4));

  const check = await join(server);
  assert.equal(check.game.version, 4);
  assert.equal(check.game.game.pot.total, 20);
  assert.equal(check.game.game.actingId, check.game.game.bigBlindId);
});

test('engine refusals pass through with their own code and do not move the version', async (t) => {
  const server = await boot(t);
  const dealer = await join(server);
  const version = await play(dealer, 0, add('Alice'));

  const refusals = [
    [add('alice'), 'duplicate-name'],
    [add('   '), 'bad-name'],
    [add(42), 'bad-name'],
    [{ type: 'removePlayer', id: 'nobody' }, 'unknown-player'],
    [{ type: 'setOptions', startingChips: 0, smallBlind: 1, bigBlind: 2 }, 'bad-options'],
    [START, 'not-enough-players'],
    [FOLD, 'wrong-phase'],
    [{ type: 'nope' }, 'unknown-action'],
    [{ type: 'constructor' }, 'unknown-action'],
    [null, 'unknown-action'],
    ['fold', 'unknown-action'],
    [42, 'unknown-action'],
  ];
  for (const [action, code] of refusals) {
    assertRefused(await dealer.ask({ type: 'game:action', action, version }), code);
  }

  const check = await join(server);
  assert.equal(check.game.version, version);
});

test('a version that is missing or not an integer is a bad request', async (t) => {
  const server = await boot(t);
  const dealer = await join(server);
  for (const version of [undefined, null, '0', 0.5, [0], {}]) {
    const action = add('Alice');
    assertRefused(await dealer.ask({ type: 'game:action', action, version }), 'bad-request');
    assertRefused(await dealer.ask({ type: 'game:undo', version }), 'bad-request');
  }
  assert.equal((await join(server)).game.version, 0);
});

test('undo steps the game back, reaches everyone, and checks the version', async (t) => {
  const server = await boot(t);
  const [dealer, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);
  const version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START, raiseTo(30));
  wall.inbox.length = 0;

  assertRefused(await dealer.ask({ type: 'game:undo', version: version - 1 }), 'stale');

  await askOk(dealer, { type: 'game:undo', version });
  const update = await wall.take(isType('game'));
  assert.equal(update.version, version + 1);
  assert.equal(update.game.currentBet, 10);
  assert.equal(update.undoLabel, 'Started the game');

  await askOk(dealer, { type: 'game:undo', version: version + 1 });
  const lobby = await wall.take(isType('game'));
  assert.equal(lobby.game.phase, 'lobby');
  assert.equal(lobby.canUndo, false);
  assert.equal(lobby.undoLabel, null);

  assertRefused(await dealer.ask({ type: 'game:undo', version: version + 2 }), 'nothing-to-undo');
});

test('a whole hand plays through to a moved dealer chip', async (t) => {
  const server = await boot(t);
  const dealer = await join(server, { role: 'dealer' });
  let version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START);
  version = await play(dealer, version, CALL, CALL, CHECK);
  version = await play(dealer, version, { type: 'nextStreet' }, CHECK, CHECK, CHECK);
  version = await play(dealer, version, { type: 'nextStreet' }, CHECK, CHECK, CHECK);
  version = await play(dealer, version, { type: 'nextStreet' }, CHECK, CHECK, CHECK);

  const showdown = await join(server);
  assert.equal(showdown.game.game.phase, 'showdown');
  const [alice, bob, cara] = showdown.game.game.players;
  assert.equal(showdown.game.game.dealerId, alice.id);

  version = await play(dealer, version, { type: 'award', pots: [[bob.id, cara.id]] });
  version = await play(dealer, version, { type: 'nextHand' });
  const next = await join(server);
  assert.equal(next.game.game.dealerId, bob.id);
  assert.equal(next.game.game.handNumber, 2);
});

/* ---------- Calibration ---------- */

const movedCorner = (calibration, delta = 0.01) => ({
  ...calibration,
  corners: calibration.corners.map(([x, y], i) => (i === 0 ? [x + delta, y] : [x, y])),
});

// Convex, so it gets past the shape check, but too small for the solver.
const TINY = 1e-15;
const TOO_SMALL_TO_SOLVE = [
  [0.5, 0.5],
  [0.5 + TINY, 0.5],
  [0.5 + TINY, 0.5 + TINY],
  [0.5, 0.5 + TINY],
];

test('begin pushes one snapshot and tells everyone there is something to undo', async (t) => {
  const server = await boot(t);
  const [editor, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);

  await askOk(editor, { type: 'calibration:begin' });
  const update = await wall.take(isType('calibration'));
  assert.equal(update.canUndo, true);
  assert.equal(update.canRedo, false);
  assert.deepEqual(update.calibration, createDefaultCalibration());
});

test('an update is sanitized, broadcast with its origin, and adds no history', async (t) => {
  const server = await boot(t);
  const [editor, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);
  const moved = movedCorner(editor.calibration.calibration);

  await askOk(editor, {
    type: 'calibration:update',
    calibration: {
      ...moved,
      themeId: 'gone',
      pattern: 'gone',
      offsets: { 'l-up': [1, 2], bogus: [3, 4] },
      extra: true,
    },
  });

  const expected = { ...moved, offsets: { 'l-up': [1, 2] }, themeId: 'emerald', pattern: 'table' };
  for (const peer of [editor, wall]) {
    assert.deepEqual(await peer.take(isType('calibration')), {
      type: 'calibration',
      calibration: expected,
      canUndo: false,
      canRedo: false,
      origin: editor.welcome.connectionId,
    });
  }
});

test('an invalid update is refused and not broadcast', async (t) => {
  const server = await boot(t);
  const [editor, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);
  const good = editor.calibration.calibration;
  const crossed = [good.corners[1], good.corners[0], good.corners[2], good.corners[3]];

  const invalid = [
    undefined,
    null,
    42,
    'calibration',
    [],
    {},
    { ...good, corners: [] },
    { ...good, corners: crossed },
    { ...good, corners: good.corners.map(() => ['a', 'b']) },
    { ...good, corners: good.corners.map(() => [0.5, 0.5]) },
    { ...good, corners: TOO_SMALL_TO_SOLVE },
    { ...good, table: null },
    { ...good, table: { lengthIn: 'long', widthIn: 36, railIn: 5 } },
  ];
  for (const calibration of invalid) {
    assertRefused(await editor.ask({ type: 'calibration:update', calibration }), 'bad-request');
  }

  await wall.ask({ type: 'ping' });
  assert.deepEqual(wall.inbox, []);
});

test('undo and redo step through edits with no origin, so nobody ignores them', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;
  const moved = movedCorner(start);

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: moved });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:undo' });
  const undone = await editor.take(isType('calibration'));
  assert.deepEqual(undone, {
    type: 'calibration',
    calibration: start,
    canUndo: false,
    canRedo: true,
    origin: null,
  });

  await askOk(editor, { type: 'calibration:redo' });
  const redone = await editor.take(isType('calibration'));
  assert.deepEqual(redone, {
    type: 'calibration',
    calibration: moved,
    canUndo: true,
    canRedo: false,
    origin: null,
  });
});

test('undo and redo with nothing to do are harmless', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  await askOk(editor, { type: 'calibration:undo' });
  await askOk(editor, { type: 'calibration:redo' });
  const latest = await editor.take(isType('calibration'));
  assert.deepEqual(latest.calibration, createDefaultCalibration());
});

test('the laptop and the phone share one history', async (t) => {
  const server = await boot(t);
  const [laptop, phone] = await Promise.all([join(server), join(server, { role: 'dealer' })]);
  const start = laptop.calibration.calibration;

  await askOk(laptop, { type: 'calibration:begin' });
  await askOk(laptop, { type: 'calibration:update', calibration: movedCorner(start) });
  phone.inbox.length = 0;

  await askOk(phone, { type: 'calibration:undo' });
  assert.deepEqual((await laptop.take((m) => m.type === 'calibration' && m.origin === null))
    .calibration, start);
});

test('a new edit clears redo', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: movedCorner(start) });
  await askOk(editor, { type: 'calibration:undo' });
  editor.inbox.length = 0;
  await askOk(editor, { type: 'calibration:begin' });
  assert.equal((await editor.take(isType('calibration'))).canRedo, false);
});

test('undo leaves the theme and pattern alone, as the old page did', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;
  const moved = movedCorner(start);

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: moved });
  const restyled = { ...moved, themeId: 'midnight', pattern: 'grid' };
  await askOk(editor, { type: 'calibration:update', calibration: restyled });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:undo' });
  const undone = (await editor.take(isType('calibration'))).calibration;
  assert.deepEqual(undone, { ...start, themeId: 'midnight', pattern: 'grid' });

  await askOk(editor, { type: 'calibration:redo' });
  assert.deepEqual((await editor.take(isType('calibration'))).calibration, restyled);
});

test('undo restores a table size change along with its corners', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;
  const bigger = { ...start, table: { lengthIn: 84, widthIn: 40, railIn: 6 } };

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: bigger });
  editor.inbox.length = 0;
  await askOk(editor, { type: 'calibration:undo' });
  assert.deepEqual((await editor.take(isType('calibration'))).calibration, start);
});

test('a begin with no edit behind it does not make undo look broken', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: movedCorner(start) });
  // Tapping points to select them: a pointer down with no drag behind it, more than once.
  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:begin' });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:undo' });
  const undone = await editor.take(isType('calibration'));
  assert.deepEqual(undone.calibration, start);
  assert.equal(undone.canUndo, false);
});

test('tapping points over and over cannot push real edits out of the history', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;

  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: movedCorner(start) });
  for (let i = 0; i < 150; i += 1) await askOk(editor, { type: 'calibration:begin' });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:undo' });
  assert.deepEqual((await editor.take(isType('calibration'))).calibration, start);
});

test('calibration history stops at 100 steps', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  let latest = editor.calibration.calibration;

  for (let i = 0; i < 105; i += 1) {
    latest = movedCorner(latest, 0.0001);
    await askOk(editor, { type: 'calibration:begin' });
    await askOk(editor, { type: 'calibration:update', calibration: latest });
  }

  for (let i = 0; i < 100; i += 1) await askOk(editor, { type: 'calibration:undo' });
  editor.inbox.length = 0;
  await askOk(editor, { type: 'calibration:undo' });
  const bottom = await editor.take(isType('calibration'));
  assert.equal(bottom.canUndo, false);
  assert.notDeepEqual(bottom.calibration, editor.calibration.calibration);
});

test('reset fine clears the offsets, keeps the rest, and is one undo step', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  const start = editor.calibration.calibration;
  const tuned = {
    ...movedCorner(start),
    offsets: { 'r-tip': [0.5, -0.5] },
    themeId: 'noir',
    pattern: 'grid',
  };
  await askOk(editor, { type: 'calibration:update', calibration: tuned });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:reset', scope: 'fine' });
  const reset = await editor.take(isType('calibration'));
  assert.deepEqual(reset.calibration, { ...tuned, offsets: {} });
  assert.equal(reset.canUndo, true);
  assert.equal(reset.origin, null);

  await askOk(editor, { type: 'calibration:undo' });
  assert.deepEqual((await editor.take(isType('calibration'))).calibration, tuned);
});

test('reset all refits to the wall and keeps the table size, theme and pattern', async (t) => {
  const server = await boot(t);
  const [editor, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);
  await askOk(wall, { type: 'output:size', width: 1600, height: 1200 });

  const table = { lengthIn: 84, widthIn: 40, railIn: 6 };
  const tuned = {
    ...movedCorner(editor.calibration.calibration),
    table,
    offsets: { 'r-tip': [0.5, -0.5] },
    themeId: 'oxblood',
    pattern: 'outline',
  };
  await askOk(editor, { type: 'calibration:update', calibration: tuned });
  editor.inbox.length = 0;

  await askOk(editor, { type: 'calibration:reset', scope: 'all' });
  const reset = await editor.take(isType('calibration'));
  assert.deepEqual(reset.calibration, {
    ...tuned,
    corners: defaultCorners(table, 1600 / 1200),
    offsets: {},
  });
  assert.equal(reset.canUndo, true);
  assert.equal(reset.origin, null);

  await askOk(editor, { type: 'calibration:undo' });
  assert.deepEqual((await editor.take(isType('calibration'))).calibration, tuned);
});

test('reset all with no wall ever connected fits 16 by 9', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  await askOk(editor, {
    type: 'calibration:update',
    calibration: movedCorner(editor.calibration.calibration),
  });
  editor.inbox.length = 0;
  await askOk(editor, { type: 'calibration:reset', scope: 'all' });
  const reset = await editor.take(isType('calibration'));
  assert.deepEqual(reset.calibration, createDefaultCalibration());
});

test('reset with an unknown scope is refused', async (t) => {
  const server = await boot(t);
  const editor = await join(server);
  for (const scope of [undefined, null, 'everything', 1, {}]) {
    assertRefused(await editor.ask({ type: 'calibration:reset', scope }), 'bad-request');
  }
});

/* ---------- Session ---------- */

test('session changes reach every other socket', async (t) => {
  const server = await boot(t);
  const [laptop, phone, wall] = await Promise.all([
    join(server),
    join(server, { role: 'dealer' }),
    join(server, { role: 'output' }),
  ]);
  laptop.inbox.length = 0;
  phone.inbox.length = 0;

  await askOk(phone, { type: 'session:set', view: 'game' });
  for (const peer of [laptop, phone, wall]) {
    assert.equal((await peer.take((m) => m.type === 'session' && m.view === 'game')).view, 'game');
  }

  await askOk(laptop, { type: 'session:set', showPoints: false, selectedPoint: 'r-tip' });
  const update = await wall.take((m) => m.type === 'session' && m.showPoints === false);
  assert.equal(update.selectedPoint, 'r-tip');
  assert.equal(update.view, 'game');
});

test('session view, showPoints and selectedPoint are checked as one', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);

  const refused = [
    {},
    { view: 'table' },
    { view: null },
    { showPoints: 'yes' },
    { selectedPoint: 'nope' },
    { selectedPoint: 7 },
    { selectedPoint: 'constructor' },
    { view: 'game', selectedPoint: 'nope' },
    { veiw: 'game' },
  ];
  for (const fields of refused) {
    assertRefused(await laptop.ask({ type: 'session:set', ...fields }), 'bad-request');
  }

  const check = await join(server);
  assert.equal(check.session.view, 'projection');
  assert.equal(check.session.selectedPoint, null);
});

test('all 13 points can be selected, and the selection can be cleared', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);
  const ids = ['tl', 'tr', 'br', 'bl', 'top', 'r-up', 'r-tip', 'r-down', 'bottom', 'l-down',
    'l-tip', 'l-up', 'move'];
  for (const selectedPoint of [...ids, null]) {
    await askOk(laptop, { type: 'session:set', selectedPoint });
  }
});

/* ---------- Wall and dealer tracking ---------- */

test('output size and connection are tracked and broadcast', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);

  const wall = await join(server, { role: 'output' });
  assert.equal(wall.session.output.connected, true);
  assert.deepEqual((await laptop.take(isType('session'))).output, {
    connected: true,
    width: 1920,
    height: 1080,
  });

  await askOk(wall, { type: 'output:size', width: 1280, height: 720 });
  assert.deepEqual((await laptop.take(isType('session'))).output, {
    connected: true,
    width: 1280,
    height: 720,
  });

  wall.socket.close();
  assert.deepEqual((await laptop.take(isType('session'))).output, {
    connected: false,
    width: 1280,
    height: 720,
  });
});

test('an overlapping wall reload keeps the wall connected with the right size', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);
  const first = await join(server, { role: 'output' });
  await askOk(first, { type: 'output:size', width: 1920, height: 1080 });
  const second = await join(server, { role: 'output' });
  await askOk(second, { type: 'output:size', width: 1280, height: 720 });
  laptop.inbox.length = 0;

  second.socket.close();
  assert.deepEqual((await laptop.take(isType('session'))).output, {
    connected: true,
    width: 1920,
    height: 1080,
  });

  first.socket.close();
  assert.deepEqual((await laptop.take(isType('session'))).output, {
    connected: false,
    width: 1920,
    height: 1080,
  });
});

test('only the output role reports a size, and the size must make sense', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);
  assertRefused(await laptop.ask({ type: 'output:size', width: 800, height: 600 }), 'forbidden');

  const wall = await join(server, { role: 'output' });
  const sizes = [
    [0, 600],
    [800, -1],
    [800, null],
    ['800', 600],
    [undefined, undefined],
    [Number.MAX_SAFE_INTEGER, 600],
  ];
  for (const [width, height] of sizes) {
    assertRefused(await wall.ask({ type: 'output:size', width, height }), 'bad-request');
  }
  assert.equal((await join(server)).session.output.width, 1920);
});

test('dealerConnected follows the dealer sockets', async (t) => {
  const server = await boot(t);
  const laptop = await join(server);
  assert.equal(laptop.session.dealerConnected, false);

  const dealer = await join(server, { role: 'dealer' });
  assert.equal(dealer.session.dealerConnected, true);
  assert.equal((await laptop.take(isType('session'))).dealerConnected, true);

  const backup = await join(server, { role: 'dealer' });
  dealer.socket.close();
  assert.equal(
    (await laptop.take((m) => m.type === 'session' && m.dealerConnected === true)).type,
    'session',
  );
  backup.socket.close();
  await laptop.take((m) => m.type === 'session' && m.dealerConnected === false);
});

test('a control socket coming and going says nothing to the others', async (t) => {
  const server = await boot(t);
  const wall = await join(server, { role: 'output' });
  const laptop = await join(server);
  laptop.socket.close();
  await laptop.closed();
  await wall.ask({ type: 'ping' });
  assert.deepEqual(wall.inbox, []);
});

test('a dead socket is reaped within 30 seconds and a live one is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = await boot(t);
  const [quiet, watcher] = await Promise.all([join(server), join(server)]);

  // A phone that went to sleep: the socket looks open and never answers.
  const asleep = createPeer(socketUrl(server), { autoPong: false });
  await asleep.opened;
  asleep.send({ type: 'hello', role: 'dealer' });
  await watcher.take((m) => m.type === 'session' && m.dealerConnected === true);

  // One heartbeat. The round trip on another socket lets the quiet socket's pong land first.
  const heartbeat = async () => {
    const pinged = once(quiet.socket, 'ping');
    t.mock.timers.tick(15_000);
    await pinged;
    await askOk(watcher, { type: 'ping' });
  };

  await heartbeat();
  assert.equal(asleep.socket.readyState, WebSocket.OPEN);

  await heartbeat();
  await watcher.take((m) => m.type === 'session' && m.dealerConnected === false);
  assert.equal(await asleep.closed(), 1006);

  // Quiet is not dead: answering pings is enough, for any number of rounds.
  for (let round = 0; round < 3; round += 1) await heartbeat();
  await askOk(quiet, { type: 'ping' });
});

test('only a pong is proof of life, so sending does not save a socket', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = await boot(t);
  const watcher = await join(server);
  const chatty = createPeer(socketUrl(server), { autoPong: false });
  await chatty.opened;
  chatty.send({ type: 'hello', role: 'dealer' });
  await chatty.take(isType('game'));
  await watcher.take((m) => m.type === 'session' && m.dealerConnected === true);

  // The first round only asks, and a message in between is not an answer.
  t.mock.timers.tick(15_000);
  await askOk(chatty, { type: 'ping' });
  t.mock.timers.tick(15_000);
  assert.equal(await chatty.closed(), 1006);
});

test('a page that sends its own pings and answers the server is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = await boot(t);
  const phone = await join(server, { role: 'dealer' });

  for (let round = 0; round < 4; round += 1) {
    const pinged = once(phone.socket, 'ping');
    t.mock.timers.tick(15_000);
    await pinged;
    await askOk(phone, { type: 'ping' });
  }
  assert.equal(phone.socket.readyState, WebSocket.OPEN);
});

test('a socket that stops reading is cut off and nobody else notices', async (t) => {
  const server = await boot(t);
  const [sender, watcher] = await Promise.all([join(server), join(server)]);
  const stalled = await join(server, { role: 'dealer' });
  t.after(() => stalled.socket.terminate());
  await watcher.take((m) => m.type === 'session' && m.dealerConnected === true);
  stalled.socket._socket.pause();

  // Past the OS socket buffers, which take a few megabytes before anything queues in the server.
  const { calibration } = sender.calibration;
  const isGone = (m) => m.type === 'session' && m.dealerConnected === false;
  const deadline = Date.now() + TIMEOUT_MS;
  while (!watcher.inbox.some(isGone)) {
    assert.ok(Date.now() < deadline, 'the stalled socket is still open');
    for (let i = 0; i < 200; i += 1) sender.send({ type: 'calibration:update', calibration });
    await askOk(sender, { type: 'ping' });
    await askOk(watcher, { type: 'ping' });
    sender.inbox.length = 0;
    watcher.inbox.splice(0, watcher.inbox.length, ...watcher.inbox.filter(isGone));
  }

  assert.equal(sender.socket.readyState, WebSocket.OPEN);
  assert.equal(watcher.socket.readyState, WebSocket.OPEN);
  await askOk(sender, { type: 'session:set', showPoints: false });
});

/* ---------- Bad input ---------- */

test('garbage messages are refused and the socket stays usable', async (t) => {
  const server = await boot(t);
  const peer = await join(server);

  const garbage = [
    'not json',
    '',
    'null',
    '42',
    '"hello"',
    '[]',
    '[1,2]',
    '{}',
    '{"type":42}',
    '{"type":null}',
    '{"type":"nope"}',
    '{"type":"constructor"}',
    '{"type":"toString"}',
    '{"type":"__proto__"}',
    '{"__proto__":{"canControl":true},"type":"nope"}',
    `{"type":"${'x'.repeat(5000)}"}`,
  ];
  for (const text of garbage) {
    peer.sendRaw(text);
    const reply = await peer.next();
    assert.equal(reply.type, 'error', text);
    assert.equal(reply.code, 'bad-request', text);
  }

  peer.sendRaw(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal((await peer.next()).code, 'bad-request');
  peer.sendRaw(Buffer.from('{"type":"ping","requestId":9}'), { binary: true });
  assert.equal((await peer.next()).code, 'bad-request');

  await askOk(peer, { type: 'ping' });
});

test('only a short plain request id is echoed back', async (t) => {
  const server = await boot(t);
  const peer = await join(server);
  const echoed = async (requestId) => {
    peer.send({ type: 'ping', requestId });
    return (await peer.next()).requestId;
  };
  assert.equal(await echoed(7), 7);
  assert.equal(await echoed('abc'), 'abc');
  assert.equal(await echoed({ evil: true }), null);
  assert.equal(await echoed([1]), null);
  assert.equal(await echoed('x'.repeat(1000)), null);
});

test('an oversized message closes that socket and nothing else', async (t) => {
  const server = await boot(t);
  const [big, bystander] = await Promise.all([join(server), join(server)]);

  big.sendRaw(JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES) }));
  assert.equal(await big.closed(), 1009);

  await askOk(bystander, { type: 'ping' });
  await play(await join(server), 0, add('Alice'));
});

test('a message just under the limit still works', async (t) => {
  const server = await boot(t);
  const peer = await join(server);
  const room = MAX_MESSAGE_BYTES - JSON.stringify({ type: 'ping', pad: '', requestId: 1 }).length;
  await askOk(peer, { type: 'ping', pad: 'x'.repeat(room) });
});

test('broken websocket frames close that socket and nothing else', async (t) => {
  const server = await boot(t);
  const [broken, bystander] = await Promise.all([join(server), join(server)]);

  // Raw bytes on the wire: reserved bits set and no mask, which no real client sends.
  broken.socket._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01]));
  await broken.closed();

  await askOk(bystander, { type: 'ping' });
});

test('invalid UTF-8 in a text frame closes that socket and nothing else', async (t) => {
  const server = await boot(t);
  const [broken, bystander] = await Promise.all([join(server), join(server)]);

  const payload = Buffer.from([0xc3, 0x28]);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
  broken.socket._socket.write(frame);
  assert.equal(await broken.closed(), 1007);

  await askOk(bystander, { type: 'ping' });
});

test('a socket that vanishes during a broadcast does not hurt the server', async (t) => {
  const server = await boot(t);
  const dealer = await join(server);
  for (let i = 0; i < 20; i += 1) {
    const peer = await join(server, { role: 'dealer' });
    peer.socket.terminate();
    await askOk(dealer, { type: 'session:set', showPoints: i % 2 === 0 });
  }
  await askOk(dealer, { type: 'ping' });
});

test('garbage requests do not hurt the server', async (t) => {
  const server = await boot(t);
  const peer = await join(server);

  assert.notEqual((await request(server.port, '/%E0%A4%A')).status, 500);
  await askOk(peer, { type: 'ping' });
});

test('nothing outside the public folder can be reached', async (t) => {
  const root = await tempDir();
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), 'laptop');
  await writeFile(path.join(root, 'decoy.json'), 'outside the public folder');
  const server = await boot(t, { publicDir });

  const escapes = ['/../decoy.json', '/%2e%2e/decoy.json', '/..%2fdecoy.json', '//../decoy.json'];
  for (const target of escapes) {
    const response = await request(server.port, target);
    assert.notEqual(response.status, 200, target);
    assert.ok(!response.body.includes('outside'), target);
  }
});

/* ---------- Persistence ---------- */

test('a game restored after a restart is the same game, mid-hand', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const dealer = await join(server, { role: 'dealer' });
  const version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START, raiseTo(40),
    CALL);
  const before = (await join(server)).game;
  assert.equal(before.game.phase, 'betting');
  await server.close();

  const restarted = await boot(t, { dataDir });
  const back = await join(restarted);
  assert.deepEqual(back.game, before);

  // The undo stack came back too, and the hand carries on from the same version.
  await askOk(back, { type: 'game:undo', version });
  const undone = await join(restarted);
  assert.equal(undone.game.game.pot.total, 55);
  await play(back, version + 1, CALL, CALL);
  const last = await join(restarted);
  assert.equal(last.game.game.pot.total, 120);
});

test('an undo survives a restart', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const dealer = await join(server);
  const version = await play(dealer, 0, add('Alice'), add('Bob'), START, raiseTo(40));
  await askOk(dealer, { type: 'game:undo', version });
  await server.close();

  const back = await join(await boot(t, { dataDir }));
  assert.equal(back.game.version, version + 1);
  assert.equal(back.game.game.currentBet, 10);
});

test('a calibration edit survives a restart, but undo history and session do not', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const editor = await join(server);
  const moved = movedCorner(editor.calibration.calibration);
  await askOk(editor, { type: 'calibration:begin' });
  await askOk(editor, { type: 'calibration:update', calibration: moved });
  await askOk(editor, { type: 'session:set', view: 'game', showPoints: false });
  await server.close();

  const back = await join(await boot(t, { dataDir }));
  assert.deepEqual(back.calibration, {
    type: 'calibration',
    calibration: moved,
    canUndo: false,
    canRedo: false,
    origin: null,
  });
  assert.equal(back.session.view, 'projection');
  assert.equal(back.session.showPoints, true);
});

test('a restart mid game comes straight back to the game view', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const dealer = await join(server);
  await play(dealer, 0, add('Alice'), add('Bob'), START);
  await server.close();

  const wall = await join(await boot(t, { dataDir }), { role: 'output' });
  assert.equal(wall.session.view, 'game');
  assert.equal(wall.game.game.phase, 'betting');
});

test('the pairing code stays the same across restarts', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const { code } = await pairingOf(server);
  await server.close();

  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'pairing.json'), 'utf8')).code, code);
  assert.equal((await pairingOf(await boot(t, { dataDir }))).code, code);
});

test('a kill mid-hand loses nothing the dealer saw acknowledged', async (t) => {
  const dataDir = await tempDir();
  const first = launch(dataDir);
  t.after(() => first.child.kill('SIGKILL'));
  await first.ready;

  const dealer = await join(first);
  const version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START, raiseTo(40));
  first.child.kill('SIGKILL');
  await first.exited;

  const second = launch(dataDir);
  t.after(() => second.child.kill('SIGKILL'));
  await second.ready;
  const back = await join(second);
  assert.equal(back.game.version, version);
  assert.equal(back.game.game.currentBet, 40);
  assert.equal(back.game.game.phase, 'betting');
  assert.equal(back.game.canUndo, true);
  second.child.kill('SIGKILL');
  await second.exited;
});

test('SIGTERM writes out an edit still waiting for its debounce', async (t) => {
  const dataDir = await tempDir();
  const running = launch(dataDir);
  t.after(() => running.child.kill('SIGKILL'));
  await running.ready;

  const editor = await join(running);
  const moved = movedCorner(editor.calibration.calibration);
  await askOk(editor, { type: 'calibration:update', calibration: moved });

  running.child.kill('SIGTERM');
  const [code] = await running.exited;
  assert.equal(code, 0);
  const saved = await readFile(path.join(dataDir, 'calibration.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), moved);
});

test('SIGINT shuts down cleanly with sockets open', async (t) => {
  const dataDir = await tempDir();
  const running = launch(dataDir);
  t.after(() => running.child.kill('SIGKILL'));
  await running.ready;
  const peer = await join(running);

  running.child.kill('SIGINT');
  const [code] = await running.exited;
  assert.equal(code, 0);
  await peer.closed();
});

async function loopbackListener(t, host) {
  const other = http.createServer((_request, response) => response.end('another program'));
  await once(other.listen(0, host), 'listening');
  t.after(() => other.close());
  return other.address().port;
}

test('a program on 127.0.0.1 stops a start the OS would have let through', async (t) => {
  const port = await loopbackListener(t, '127.0.0.1');
  const dataDir = await tempDir();
  await assert.rejects(startServer({ port, dataDir }), { code: 'EADDRINUSE' });
});

test('a program on ::1 stops the start too', async (t) => {
  const port = await loopbackListener(t, '::1');
  const dataDir = await tempDir();
  await assert.rejects(startServer({ port, dataDir }), { code: 'EADDRINUSE' });
});

test('the entry point refuses to share a port with an old copy on loopback', async (t) => {
  const port = await loopbackListener(t, '127.0.0.1');
  const running = launch(await tempDir(), String(port));
  const [code] = await running.exited;
  assert.equal(code, 1);
  assert.match(running.output, new RegExp(`Port ${port} is already in use`));
  assert.ok(!running.output.includes('Poker Projection running at'));
});

test('the entry point logs the phone URL and reports a busy port', async (t) => {
  const taken = await boot(t, { host: '0.0.0.0' });
  const running = launch(await tempDir(), String(taken.port));
  const [code] = await running.exited;
  assert.equal(code, 1);
  assert.equal(
    running.output.trim(),
    `Port ${taken.port} is already in use. The app may already be running at ` +
      `http://localhost:${taken.port}. A second copy needs its own PORT and DATA_DIR.`,
  );

  const fresh = launch(await tempDir());
  t.after(() => fresh.child.kill('SIGKILL'));
  await fresh.ready;
  assert.match(fresh.output, /Phone: http:\/\/[^\s]+:\d+\/dealer#[A-Z2-9]{6}\n/);

  // PORT=0 has to mean a spare port. Falling back to the default would put tests on port 3000.
  assert.ok(fresh.port > 10_000, `PORT=0 gave ${fresh.port}`);
});

test('the user\'s existing save loads exactly as it is and is not rewritten', async (t) => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'calibration.json');
  const bytes = JSON.stringify(USER_SAVE, null, 2);
  await writeFile(file, bytes);

  const server = await boot(t, { dataDir });
  const peer = await join(server);
  assert.deepEqual(peer.calibration.calibration, USER_SAVE);
  await server.close();

  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('starting and stopping leaves a save untouched, whatever its format', async (t) => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'calibration.json');
  const bytes = `${JSON.stringify({ ...USER_SAVE, fieldFromLongAgo: true })}\n`;
  await writeFile(file, bytes);

  const server = await boot(t, { dataDir });
  await join(server);
  await server.close();

  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual((await readdir(dataDir)).sort(), ['calibration.json', 'pairing.json']);
});

test('a saved calibration keeps the same readable format', async (t) => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'calibration.json');
  await writeFile(file, JSON.stringify(USER_SAVE, null, 2));

  const server = await boot(t, { dataDir });
  const peer = await join(server);
  const moved = movedCorner(USER_SAVE);
  await askOk(peer, { type: 'calibration:update', calibration: moved });
  await server.close();

  assert.equal(await readFile(file, 'utf8'), JSON.stringify(moved, null, 2));
});

test('unreadable files are treated as absent', async (t) => {
  const dataDir = await tempDir();
  await writeFile(path.join(dataDir, 'calibration.json'), '{ not json');
  await writeFile(path.join(dataDir, 'game.json'), '{ not json');
  await writeFile(path.join(dataDir, 'pairing.json'), '{ not json');

  const server = await boot(t, { dataDir });
  const peer = await join(server);
  assert.deepEqual(peer.calibration.calibration, createDefaultCalibration());
  assert.equal(peer.game.version, 0);
  assert.match((await pairingOf(server)).code, /^[A-Z2-9]{6}$/);
});

test('valid JSON that is not a usable save is treated as absent', async (t) => {
  const dataDir = await tempDir();
  const crossed = { ...USER_SAVE, corners: [...USER_SAVE.corners].reverse().slice(0, 3) };
  await writeFile(path.join(dataDir, 'calibration.json'), JSON.stringify(crossed));
  await writeFile(path.join(dataDir, 'game.json'), JSON.stringify({ version: 9, state: { a: 1 } }));
  await writeFile(path.join(dataDir, 'pairing.json'), JSON.stringify({ code: ['ABC234'] }));

  const server = await boot(t, { dataDir });
  const peer = await join(server);
  assert.deepEqual(peer.calibration.calibration, createDefaultCalibration());
  assert.equal(peer.game.version, 0);
  assert.match((await pairingOf(server)).code, /^[A-Z2-9]{6}$/);
});

test('a saved calibration the solver cannot handle does not stop the server', async (t) => {
  const dataDir = await tempDir();
  const save = { ...USER_SAVE, corners: TOO_SMALL_TO_SOLVE };
  await writeFile(path.join(dataDir, 'calibration.json'), JSON.stringify(save));

  const peer = await join(await boot(t, { dataDir }));
  assert.deepEqual(peer.calibration.calibration, createDefaultCalibration());
});

test('saves leave no temp files behind', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const peer = await join(server);
  await play(peer, 0, add('Alice'));
  await askOk(peer, {
    type: 'calibration:update',
    calibration: movedCorner(peer.calibration.calibration),
  });
  await server.close();

  assert.deepEqual((await readdir(dataDir)).sort(), [
    'calibration.json',
    'game.json',
    'pairing.json',
  ]);
});

test('a reader never sees half a file, however the writes land', async () => {
  const file = path.join(await tempDir(), 'store.json');
  const store = createStore(file);
  const big = (step) => ({ step, pad: 'x'.repeat(2_000_000) });
  store.save(big(0));
  await store.flush();

  for (let step = 1; step <= 25; step += 1) {
    store.save(big(step));
    let written = false;
    store.flush().then(() => {
      written = true;
    });
    do {
      const seen = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(seen.step === step || seen.step === step - 1);
    } while (!written);
  }
});

test('the store keeps the newest value when saves overlap a write', async () => {
  const file = path.join(await tempDir(), 'nested', 'store.json');
  const store = createStore(file, { delayMs: 5 });

  assert.equal(await store.load(), undefined);
  const flushes = [];
  for (let i = 0; i < 50; i += 1) {
    store.save({ i });
    flushes.push(store.flush());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(flushes);
  assert.deepEqual(await store.load(), { i: 49 });

  store.save({ i: 50 });
  store.save({ i: 51 });
  await store.flush();
  assert.deepEqual(await store.load(), { i: 51 });
  await store.flush();
});

test('the store turns a burst into one write that later saves cannot push back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = path.join(await tempDir(), 'store.json');
  const store = createStore(file, { delayMs: 250 });

  store.save({ step: 1 });
  t.mock.timers.tick(200);
  store.save({ step: 2 });

  // Mocked time hasn't reached the delay, so real time passing must not write anything.
  const pause = Date.now() + 30;
  while (Date.now() < pause) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await store.load(), undefined);

  // Exactly 250ms after the first save, with no flush to help it along.
  t.mock.timers.tick(50);
  const deadline = Date.now() + 3000;
  while ((await store.load()) === undefined && Date.now() < deadline);
  assert.deepEqual(await store.load(), { step: 2 });
});

test('a failed write is logged and does not stop the next one', async (t) => {
  const dir = await tempDir();
  const blocker = path.join(dir, 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const blocked = createStore(path.join(blocker, 'store.json'), { delayMs: 1 });
  const logged = t.mock.method(console, 'error', () => {});

  blocked.save({ a: 1 });
  await blocked.flush();
  assert.equal(logged.mock.callCount(), 1);

  await rm(blocker);
  blocked.save({ a: 2 });
  await blocked.flush();
  assert.deepEqual(await blocked.load(), { a: 2 });
});

test('a failed write keeps its value and retries every 2 seconds until it lands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'));

  store.save({ a: 1 });
  assert.equal(await store.flush(), false);
  assert.equal(store.failed, true);

  // Still failing: the timer tries again, and the failure doesn't end the retries.
  t.mock.timers.tick(2000);
  assert.equal(await store.flush(), false);
  assert.equal(store.failed, true);

  await rm(blocker);
  t.mock.timers.tick(1999);
  const pause = Date.now() + 30;
  while (Date.now() < pause) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await store.load(), undefined);
  assert.equal(store.failed, true);

  t.mock.timers.tick(1);
  const deadline = Date.now() + 3000;
  while ((await store.load()) === undefined && Date.now() < deadline);
  assert.deepEqual(await store.load(), { a: 1 });
  assert.equal(await store.flush(), true);
  assert.equal(store.failed, false);
});

test('flush reports a failure and settles at once, however many are waiting', async (t) => {
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'), { retryMs: 60_000 });

  store.save({ a: 1 });
  const results = await Promise.all([store.flush(), store.flush(), store.flush()]);
  assert.deepEqual(results, [false, false, false]);
  await store.close();
});

test('a run of failures logs one line, however many retries it takes', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'), { retryMs: 60_000 });

  store.save({ a: 1 });
  for (let i = 0; i < 10; i += 1) await store.flush();
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^Could not save store\.json: /);

  await rm(blocker);
  assert.equal(await store.flush(), true);
  assert.equal(logged.mock.callCount(), 1);

  // A new run is news again.
  await rm(blocker, { recursive: true });
  await writeFile(blocker, 'in the way again');
  store.save({ a: 2 });
  await store.flush();
  assert.equal(logged.mock.callCount(), 2);
  await store.close();
});

test('a store says when it starts failing and when it recovers, and only then', async (t) => {
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'), { retryMs: 60_000 });
  const heard = [];
  store.onFailedChange(() => heard.push(store.failed));

  store.save({ a: 1 });
  await store.flush();
  store.save({ a: 2 });
  await store.flush();
  assert.deepEqual(heard, [true]);

  await rm(blocker);
  store.save({ a: 3 });
  await store.flush();
  store.save({ a: 4 });
  await store.flush();
  assert.deepEqual(heard, [true, false]);
  assert.deepEqual(await store.load(), { a: 4 });
});

test('a value saved during a failing write is the one that lands', async (t) => {
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'), { retryMs: 60_000 });

  store.save({ a: 1 });
  const failing = store.flush();
  store.save({ a: 2 });
  assert.equal(await failing, false);

  await rm(blocker);
  assert.equal(await store.flush(), true);
  assert.deepEqual(await store.load(), { a: 2 });
});

test('close is the last try: it reports a failure and leaves no retry behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'));

  store.save({ a: 1 });
  assert.equal(await store.close(), false);

  await rm(blocker);
  t.mock.timers.tick(60_000);
  const pause = Date.now() + 30;
  while (Date.now() < pause) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await store.load(), undefined);
});

test('close writes out a recovered disk straight away', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const blocker = path.join(await tempDir(), 'blocker');
  await writeFile(blocker, 'a file where a directory should be');
  const store = createStore(path.join(blocker, 'store.json'));

  store.save({ a: 1 });
  await store.flush();
  await rm(blocker);
  assert.equal(await store.close(), true);
  assert.deepEqual(await store.load(), { a: 1 });
});

test('a failed save is acked, warns everyone and clears on a timed retry', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const [dealer, wall] = await Promise.all([join(server), join(server, { role: 'output' })]);
  assert.equal(dealer.session.saveFailed, false);
  const version = await play(dealer, 0, add('Alice'));

  // A folder at the temp file's path makes every write fail, for any user on any system.
  const blocker = path.join(dataDir, 'game.json.tmp');
  await mkdir(blocker);
  dealer.inbox.length = 0;
  await askOk(dealer, { type: 'game:action', action: add('Bob'), version });

  // Already here when the ack landed, and sent once, so a failing disk can't chatter.
  const warnings = () => dealer.inbox.filter((m) => m.type === 'session' && m.saveFailed);
  assert.equal(warnings().length, 1);
  await wall.take((m) => m.type === 'session' && m.saveFailed);
  await askOk(dealer, { type: 'game:action', action: add('Cara'), version: version + 1 });
  assert.equal(warnings().length, 1);
  assert.equal(logged.mock.callCount(), 1);

  // A page that arrives now is told too, and the game it sees has moved on.
  const late = await join(server);
  assert.equal(late.session.saveFailed, true);
  assert.equal(late.game.version, version + 2);

  await rm(blocker, { recursive: true });
  for (const peer of [dealer, wall]) {
    await peer.take((m) => m.type === 'session' && m.saveFailed === false);
  }
  const saved = JSON.parse(await readFile(path.join(dataDir, 'game.json'), 'utf8'));
  assert.equal(saved.version, version + 2);
  assert.equal((await join(server)).session.saveFailed, false);
});

test('saveFailed stays on until every store has recovered', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const dealer = await join(server);
  const game = path.join(dataDir, 'game.json.tmp');
  const calibration = path.join(dataDir, 'calibration.json.tmp');
  await mkdir(game);
  await mkdir(calibration);

  await askOk(dealer, {
    type: 'calibration:update',
    calibration: movedCorner(dealer.calibration.calibration),
  });
  await dealer.take((m) => m.type === 'session' && m.saveFailed === true);
  await askOk(dealer, { type: 'game:action', action: add('Alice'), version: 0 });

  await rm(game, { recursive: true });
  await askOk(dealer, { type: 'game:action', action: add('Bob'), version: 1 });
  assert.equal((await join(server)).session.saveFailed, true);
  // A second store failing and recovering changed nothing overall, so nothing went out.
  assert.ok(!dealer.inbox.some(isType('session')));

  await rm(calibration, { recursive: true });
  await dealer.take((m) => m.type === 'session' && m.saveFailed === false);
});

test('a pairing code that cannot be saved shows from the first message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dataDir = await tempDir();
  const blocker = path.join(dataDir, 'pairing.json.tmp');
  await mkdir(blocker);
  const server = await boot(t, { dataDir });
  const peer = await join(server);
  assert.equal(peer.session.saveFailed, true);

  await rm(blocker, { recursive: true });
  await peer.take((m) => m.type === 'session' && m.saveFailed === false);
  const { code } = JSON.parse(await readFile(path.join(dataDir, 'pairing.json'), 'utf8'));
  assert.equal(code, (await pairingOf(server)).code);
});

test('close reports whether everything was saved', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dataDir = await tempDir();
  const healthy = await boot(t, { dataDir });
  const peer = await join(healthy);
  await play(peer, 0, add('Alice'));
  assert.equal(await healthy.close(), true);

  const failing = await boot(t, { dataDir });
  await mkdir(path.join(dataDir, 'game.json.tmp'));
  await play(await join(failing), 1, add('Bob'));
  assert.equal(await failing.close(), false);
});

test('a closed server stops trying to save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const dealer = await join(server);
  const blocker = path.join(dataDir, 'game.json.tmp');
  await mkdir(blocker);
  await play(dealer, 0, add('Alice'));
  assert.equal(await server.close(), false);

  await rm(blocker, { recursive: true });
  t.mock.timers.tick(60_000);
  const pause = Date.now() + 30;
  while (Date.now() < pause) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!(await readdir(dataDir)).includes('game.json'));
});

test('SIGTERM on a failing disk still stops in time and says what was lost', async (t) => {
  const dataDir = await tempDir();
  const running = launch(dataDir);
  t.after(() => running.child.kill('SIGKILL'));
  await running.ready;

  const dealer = await join(running);
  await mkdir(path.join(dataDir, 'game.json.tmp'));
  const version = await play(dealer, 0, add('Alice'), add('Bob'));
  assert.equal(version, 2);

  const asked = Date.now();
  running.child.kill('SIGTERM');
  const [code] = await running.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - asked < 3000, `took ${Date.now() - asked}ms`);
  assert.equal(running.output.match(/Could not save game\.json/g).length, 1);
  assert.match(running.output, /Stopped with changes that could not be saved\./);
});

test('SIGTERM writes out what a recovered disk could not take earlier', async (t) => {
  const dataDir = await tempDir();
  const running = launch(dataDir);
  t.after(() => running.child.kill('SIGKILL'));
  await running.ready;

  const dealer = await join(running);
  const blocker = path.join(dataDir, 'game.json.tmp');
  await mkdir(blocker);
  await play(dealer, 0, add('Alice'), add('Bob'));
  await rm(blocker, { recursive: true });

  running.child.kill('SIGTERM');
  const [code] = await running.exited;
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'game.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.ok(!running.output.includes('Stopped with changes'));
});

/* ---------- Damaged saves ---------- */

const damagedCopies = async (dataDir, name) => {
  const files = await readdir(dataDir);
  return files.filter((file) => file.startsWith(`${name}.damaged-`));
};

test('a file that cannot be parsed is copied aside byte for byte', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = await tempDir();
  const file = path.join(dir, 'store.json');
  await writeFile(file, '{ not json');

  assert.equal(await createStore(file).load(), undefined);

  const copies = await damagedCopies(dir, 'store.json');
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^store\.json\.damaged-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  assert.equal(await readFile(path.join(dir, copies[0]), 'utf8'), '{ not json');
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});

test('a missing file is not damage', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const dir = await tempDir();
  assert.equal(await createStore(path.join(dir, 'store.json')).load(), undefined);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(warned.mock.callCount(), 0);
});

test('copies made in the same instant do not overwrite each other', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.mock.method(console, 'warn', () => {});
  const dir = await tempDir();
  const file = path.join(dir, 'store.json');
  const store = createStore(file);
  for (const bytes of ['first', 'second', 'third']) {
    await writeFile(file, bytes);
    await store.keepDamaged();
  }

  const copies = await damagedCopies(dir, 'store.json');
  const kept = await Promise.all(copies.map((copy) => readFile(path.join(dir, copy), 'utf8')));
  assert.deepEqual(kept.sort(), ['first', 'second', 'third']);
});

test('a copy that cannot be made is logged and the load carries on', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const logged = t.mock.method(console, 'error', () => {});
  const dir = await tempDir();
  const file = path.join(dir, 'store.json');
  await mkdir(file);

  assert.equal(await createStore(file).load(), undefined);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^Could not keep a copy of store\.json: /);
});

test('rejected saves are kept when the first change replaces them', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const unusable = [
    ['calibration.json', '{ not json'],
    ['calibration.json', JSON.stringify({ ...USER_SAVE, corners: TOO_SMALL_TO_SOLVE })],
    ['game.json', '{ not json'],
    ['game.json', JSON.stringify({ version: 9, state: { a: 1 } })],
    // At version 0 a rejected save looks just like a fresh game.
    ['game.json', JSON.stringify({ version: 0, state: { a: 1 }, history: [] })],
    ['game.json', 'null'],
  ];
  for (const [name, bytes] of unusable) {
    const dataDir = await tempDir();
    await writeFile(path.join(dataDir, name), bytes);
    const server = await boot(t, { dataDir });
    const peer = await join(server);
    await play(peer, 0, add('Alice'));
    await askOk(peer, {
      type: 'calibration:update',
      calibration: movedCorner(peer.calibration.calibration),
    });
    await server.close();

    assert.notEqual(await readFile(path.join(dataDir, name), 'utf8'), bytes, bytes);
    const copies = await damagedCopies(dataDir, name);
    assert.equal(copies.length, 1, bytes);
    assert.equal(await readFile(path.join(dataDir, copies[0]), 'utf8'), bytes);
  }
});

test('a bad pairing.json is kept too, before the new code replaces it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = await tempDir();
  const bytes = JSON.stringify({ code: ['ABC234'] });
  await writeFile(path.join(dataDir, 'pairing.json'), bytes);

  await boot(t, { dataDir });

  const copies = await damagedCopies(dataDir, 'pairing.json');
  assert.equal(copies.length, 1);
  assert.equal(await readFile(path.join(dataDir, copies[0]), 'utf8'), bytes);
});

test('one bad undo entry costs the history, not the game, and the file is kept', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const dataDir = await tempDir();
  const first = await boot(t, { dataDir });
  const dealer = await join(first);
  const version = await play(dealer, 0, add('Alice'), add('Bob'), add('Cara'), START, raiseTo(40),
    CALL);
  const before = (await join(first)).game;
  await first.close();

  const file = path.join(dataDir, 'game.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.history.at(-1).state.players[0].stack += 1;
  const bytes = JSON.stringify(saved);
  await writeFile(file, bytes);

  const server = await boot(t, { dataDir });
  const back = await join(server);
  assert.equal(back.game.version, version);
  assert.deepEqual(back.game.game, before.game);
  assert.equal(back.game.canUndo, false);
  assert.equal(back.session.view, 'game');
  assert.ok(warned.mock.calls.some(({ arguments: [line] }) => /undo history/.test(line)));

  await play(back, version, CALL);
  await server.close();
  const copies = await damagedCopies(dataDir, 'game.json');
  assert.equal(copies.length, 1);
  assert.equal(await readFile(path.join(dataDir, copies[0]), 'utf8'), bytes);
});

/* ---------- HTTP ---------- */

test('public pages are served, with clean URLs for the wall and the phone', async (t) => {
  const publicDir = await tempDir();
  await writeFile(path.join(publicDir, 'index.html'), 'laptop');
  await writeFile(path.join(publicDir, 'output.html'), 'wall');
  await writeFile(path.join(publicDir, 'dealer.html'), 'phone');
  await writeFile(path.join(publicDir, 'app.js'), 'code');
  const server = await boot(t, { publicDir });

  const pages = [['/', 'laptop'], ['/output', 'wall'], ['/dealer', 'phone'], ['/app.js', 'code']];
  for (const [target, body] of pages) {
    const response = await request(server.port, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.body, body);
  }
  assert.equal((await request(server.port, '/nope')).status, 404);
});

test('the real public folder is what gets served by default', async (t) => {
  const server = await boot(t);
  const response = await request(server.port, '/js/connection.js');
  assert.equal(response.status, 200);
  assert.match(response.body, /export function connect/);
});

test('the old calibration routes are gone', async (t) => {
  const server = await boot(t);
  assert.equal((await request(server.port, '/api/calibration')).status, 404);
  const put = await request(server.port, '/api/calibration', { method: 'PUT' });
  assert.equal(put.status, 404);
});

test('/api/pairing gives this computer the code, QR and phone address', async (t) => {
  const server = await boot(t);
  const response = await request(server.port, '/api/pairing');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');

  const { url, code, qrSvg, addresses } = JSON.parse(response.body);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(url, `http://${addresses[0]}:${server.port}/dealer#${code}`);
  assert.equal(server.phoneUrl(), url);
  assert.ok(qrSvg.includes('<svg'));
  assert.ok(addresses.length > 0);
});

test('/api/pairing refuses a non-loopback client', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);

  const refused = await request(server.port, '/api/pairing', { address: LAN_ADDRESS });
  assert.equal(refused.status, 403);
  assert.ok(!refused.body.includes(code));

  // The same address reaches an ordinary page, so that 403 came from the route itself.
  assert.notEqual((await request(server.port, '/', { address: LAN_ADDRESS })).status, 403);
});

test('a LAN client gains nothing by claiming to be local in its headers', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const claim = {
    Host: `localhost:${server.port}`,
    Origin: `http://localhost:${server.port}`,
    'X-Forwarded-For': LOOPBACK,
    'X-Real-IP': LOOPBACK,
  };

  const fetched = await new Promise((resolve, reject) => {
    const call = http.get({
      host: LAN_ADDRESS,
      port: server.port,
      path: '/api/pairing',
      headers: claim,
      agent: false,
    });
    call.on('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on('error', reject);
  });
  assert.equal(fetched, 403);

  const guest = createPeer(socketUrl(server, LAN_ADDRESS), { headers: claim });
  await guest.opened;
  guest.send({ type: 'hello', role: 'dealer' });
  assert.equal((await guest.next()).canControl, false);
});

test('requests with a foreign Host are refused', async (t) => {
  const server = await boot(t);
  const { port } = server;
  const refused = [
    'evil.example',
    `evil.example:${port}`,
    `localhost:${port + 1}`,
    'localhost',
    `evil.example@localhost:${port}`,
    `localhost:${port}@evil.example`,
    `localhost:${port}/`,
    `localhost.evil.example:${port}`,
    `0.0.0.0:${port}`,
    `127.0.0.2:${port}`,
    `[::2]:${port}`,
  ];
  for (const host of refused) {
    const response = await request(port, '/js/connection.js', { host });
    assert.equal(response.status, 403, host);
    assert.ok(!response.body.includes('connect'), host);
  }
  assert.equal((await request(port, '/api/pairing', { host: 'evil.example' })).status, 403);
});

test('a request with an empty or missing Host is refused', async (t) => {
  const server = await boot(t);
  const refused = [
    'GET / HTTP/1.1\r\nHost:\r\n\r\n',
    'GET / HTTP/1.0\r\n\r\n',
    'GET / HTTP/1.1\r\n\r\n',
  ];
  for (const text of refused) {
    const status = await rawStatus(server.port, text);
    assert.ok(status === 403 || status === 400, `${JSON.stringify(text)} got ${status}`);
  }
  await askOk(await join(server), { type: 'ping' });
});

test('requests to this machine by any of its names are allowed', async (t) => {
  const server = await boot(t);
  const { port } = server;
  const machine = os.hostname();
  const short = machine.split('.')[0];
  const allowed = [
    `localhost:${port}`,
    `LOCALHOST:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    `${machine}:${port}`,
    `${machine.toUpperCase()}:${port}`,
    `${short}.local:${port}`,
    `${short}:${port}`,
  ];
  if (LAN_ADDRESS) allowed.push(`${LAN_ADDRESS}:${port}`);
  for (const host of allowed) {
    assert.equal((await request(port, '/js/connection.js', { host })).status, 200, host);
  }
});

test('isAllowedHost needs the right name and port, with 80 as the default', () => {
  const names = localNames('Krishs-MacBook-Pro.local', {
    en0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'FE80::1', family: 'IPv6', internal: false },
    ],
  });
  const allowed = (host, port = 3000) => isAllowedHost(host, port, names);

  assert.equal(allowed('krishs-macbook-pro.local:3000'), true);
  assert.equal(allowed('krishs-macbook-pro:3000'), true);
  assert.equal(allowed('192.168.1.20:3000'), true);
  assert.equal(allowed('[fe80::1]:3000'), true);
  assert.equal(allowed('[::1]:3000'), true);
  assert.equal(allowed('localhost', 80), true);
  assert.equal(allowed('localhost:80', 80), true);

  assert.equal(allowed('localhost'), false);
  assert.equal(allowed('192.168.1.21:3000'), false);
  assert.equal(allowed(undefined), false);
  assert.equal(allowed(''), false);
  assert.equal(allowed('localhost:3000:3000'), false);
});

/* ---------- WebSocket upgrade ---------- */

test('a socket upgrade needs a local Host', async (t) => {
  const server = await boot(t);
  const url = socketUrl(server);
  assert.equal(await upgradeStatus(url, {}), 101);
  assert.equal(await upgradeStatus(url, { Host: `localhost:${server.port}` }), 101);
  assert.equal(await upgradeStatus(url, { Host: 'evil.example' }), 403);
  assert.equal(await upgradeStatus(url, { Host: `localhost:${server.port + 1}` }), 403);
});

test('a socket upgrade from another site is refused', async (t) => {
  const server = await boot(t);
  const url = socketUrl(server);
  const host = `localhost:${server.port}`;
  const here = { Host: host };

  assert.equal(await upgradeStatus(url, { ...here, Origin: `http://${host}` }), 101);
  assert.equal(await upgradeStatus(url, { ...here, Origin: `https://${host}` }), 101);
  const shouted = `http://LOCALHOST:${server.port}`;
  assert.equal(await upgradeStatus(url, { ...here, Origin: shouted }), 101);

  assert.equal(await upgradeStatus(url, { ...here, Origin: 'https://evil.example' }), 403);
  const otherName = `http://127.0.0.1:${server.port}`;
  assert.equal(await upgradeStatus(url, { ...here, Origin: otherName }), 403);
  assert.equal(await upgradeStatus(url, { ...here, Origin: 'http://localhost' }), 403);
  assert.equal(await upgradeStatus(url, { ...here, Origin: 'null' }), 403);
  assert.equal(await upgradeStatus(url, { ...here, Origin: 'file://' }), 403);
  assert.equal(await upgradeStatus(url, { ...here, Origin: '' }), 403);
  assert.equal(await upgradeStatus(url, { ...here, Origin: 'garbage' }), 403);
});

test('a rebound domain is refused even though its Origin and Host agree', async (t) => {
  const server = await boot(t);
  const host = `evil.example:${server.port}`;
  const headers = { Host: host, Origin: `http://${host}` };
  assert.equal(await upgradeStatus(socketUrl(server), headers), 403);
});

test('only /ws upgrades', async (t) => {
  const server = await boot(t);
  const base = `ws://${LOOPBACK}:${server.port}`;
  assert.equal(await upgradeStatus(`${base}/ws?x=1`, {}), 101);
  assert.equal(await upgradeStatus(`${base}/`, {}), 404);
  assert.equal(await upgradeStatus(`${base}/ws/extra`, {}), 404);
});

test('isSameOrigin compares the host and port, and allows no Origin at all', () => {
  assert.equal(isSameOrigin(undefined, 'localhost:3000'), true);
  assert.equal(isSameOrigin('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(isSameOrigin('http://[::1]:3000', '[::1]:3000'), true);
  assert.equal(isSameOrigin('http://localhost', 'localhost:80'), true);
  assert.equal(isSameOrigin('http://localhost:3000', 'localhost:3001'), false);
  assert.equal(isSameOrigin('http://localhost:3000', undefined), false);
  assert.equal(isSameOrigin('null', 'localhost:3000'), false);
});

/* ---------- Control rights ---------- */

const CONTROL_COMMANDS = [
  { type: 'game:action', action: add('Mallory'), version: 0 },
  { type: 'game:undo', version: 0 },
  { type: 'calibration:begin' },
  { type: 'calibration:update', calibration: createDefaultCalibration() },
  { type: 'calibration:undo' },
  { type: 'calibration:redo' },
  { type: 'calibration:reset', scope: 'all' },
  { type: 'session:set', view: 'game' },
  { type: 'pairing:new' },
];

test('a loopback socket has control with no key, or the wrong one', async (t) => {
  const server = await boot(t);
  assert.equal((await join(server)).welcome.canControl, true);
  assert.equal((await join(server, { key: 'WRONG1' })).welcome.canControl, true);
});

test('a LAN socket with no key can look but not touch', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const owner = await join(server);
  const guest = await join(server, { address: LAN_ADDRESS, role: 'dealer' });
  assert.equal(guest.welcome.canControl, false);
  assert.equal(guest.game.version, 0);

  for (const command of CONTROL_COMMANDS) {
    assertRefused(await guest.ask(command), 'forbidden');
  }
  assert.equal(guest.socket.readyState, WebSocket.OPEN);
  await askOk(guest, { type: 'ping' });

  // Nothing moved, and the socket still follows the game.
  assert.equal((await join(server)).game.version, 0);
  await play(owner, 0, add('Alice'));
  assert.equal((await guest.take(isType('game'))).version, 1);
});

test('a LAN socket with no key cannot pose as the wall', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const guest = await join(server, { address: LAN_ADDRESS, role: 'output' });
  assert.equal(guest.welcome.canControl, false);
  assert.equal(guest.session.output.connected, false);
  assertRefused(await guest.ask({ type: 'output:size', width: 1, height: 65536 }), 'forbidden');

  assert.deepEqual((await join(server)).session.output, {
    connected: false,
    width: 1920,
    height: 1080,
  });

  // The real wall on this computer is not held up by the guest, and outlasts it.
  const wall = await join(server, { role: 'output' });
  await askOk(wall, { type: 'output:size', width: 1280, height: 720 });
  const laptop = await join(server);
  assert.deepEqual(laptop.session.output, { connected: true, width: 1280, height: 720 });
  guest.socket.close();
  await guest.closed();
  assert.deepEqual((await join(server)).session.output, {
    connected: true,
    width: 1280,
    height: 720,
  });
});

test('a LAN wall with the code counts as the wall', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  const wall = await join(server, { address: LAN_ADDRESS, role: 'output', key: code });
  assert.equal(wall.session.output.connected, true);
  await askOk(wall, { type: 'output:size', width: 1024, height: 768 });
  assert.equal((await join(server)).session.output.width, 1024);
});

test('dealerConnected counts only a dealer with control', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  const laptop = await join(server);

  const guest = await join(server, { address: LAN_ADDRESS, role: 'dealer' });
  assert.equal(guest.session.dealerConnected, false);
  assert.equal((await join(server)).session.dealerConnected, false);

  const dealer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: code });
  assert.equal(dealer.session.dealerConnected, true);
  await laptop.take((m) => m.type === 'session' && m.dealerConnected === true);

  dealer.socket.close();
  await laptop.take((m) => m.type === 'session' && m.dealerConnected === false);
  assert.equal(guest.socket.readyState, WebSocket.OPEN);
});

test('a new code replaces the old one, on this computer and on disk', async (t) => {
  const dataDir = await tempDir();
  const server = await boot(t, { dataDir });
  const before = await pairingOf(server);
  const laptop = await join(server);

  await askOk(laptop, { type: 'pairing:new' });
  const after = await pairingOf(server);
  assert.notEqual(after.code, before.code);
  assert.match(after.url, new RegExp(`#${after.code}$`));
  assert.notEqual(after.qrSvg, before.qrSvg);
  assert.ok(server.phoneUrl().endsWith(`#${after.code}`));

  await server.close();
  assert.equal((await pairingOf(await boot(t, { dataDir }))).code, after.code);
});

test('a new code cuts off a paired phone, and only the new code gets back in', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code: oldCode } = await pairingOf(server);
  const laptop = await join(server);
  const dealer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: oldCode });
  const guest = await join(server, { address: LAN_ADDRESS, role: 'dealer' });
  assert.equal(dealer.welcome.canControl, true);

  await askOk(laptop, { type: 'pairing:new' });
  await dealer.closed();
  await laptop.take((m) => m.type === 'session' && m.dealerConnected === false);
  assert.equal(laptop.socket.readyState, WebSocket.OPEN);
  assert.equal(guest.socket.readyState, WebSocket.OPEN);

  const stale = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: oldCode });
  assert.equal(stale.welcome.canControl, false);
  assertRefused(await stale.ask(CONTROL_COMMANDS[0]), 'forbidden');

  const { code } = await pairingOf(server);
  const back = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: code });
  assert.equal(back.welcome.canControl, true);
});

test('a paired phone can not change the code', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  const dealer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: code });
  assertRefused(await dealer.ask({ type: 'pairing:new' }), 'forbidden');
  assert.equal((await pairingOf(server)).code, code);
  assert.equal(dealer.socket.readyState, WebSocket.OPEN);
});

test('a LAN socket with a bad key stays connected and read only', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const guest = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: 'WRONG1' });
  assert.equal(guest.welcome.canControl, false);
  assertRefused(await guest.ask(CONTROL_COMMANDS[0]), 'forbidden');
  assert.equal(guest.socket.readyState, WebSocket.OPEN);
});

test('a LAN socket with the right key has control', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  const dealer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: code });
  assert.equal(dealer.welcome.canControl, true);

  for (const key of [code.toLowerCase(), ` ${code} `]) {
    const typed = await join(server, { address: LAN_ADDRESS, role: 'dealer', key });
    assert.equal(typed.welcome.canControl, true);
  }

  await play(dealer, 0, add('Alice'));
  await askOk(dealer, { type: 'session:set', view: 'game' });
});

test('keys of the wrong type or length are just wrong', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  for (const key of [12345, true, ['A'], { code: 'A' }, 'X', 'x'.repeat(10000)]) {
    const guest = await join(server, { address: LAN_ADDRESS, key });
    assert.equal(guest.welcome.canControl, false);
  }
});

test('five bad codes lock an address out, even with the right code', onLan, async (t) => {
  let clock = 1_000_000;
  const server = await boot(t, { host: '0.0.0.0', now: () => clock });
  const { code } = await pairingOf(server);
  const tryCode = async (key) => {
    const peer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key });
    peer.socket.close();
    return peer.welcome.canControl;
  };

  for (let i = 0; i < 5; i += 1) assert.equal(await tryCode('WRONG1'), false);
  assert.equal(await tryCode(code), false);

  // Loopback is not part of this, and a device already paired stays paired.
  assert.equal((await join(server)).welcome.canControl, true);

  clock += 59_999;
  assert.equal(await tryCode(code), false);
  clock += 1;
  assert.equal(await tryCode(code), true);
});

test('a socket with no key at all is not guessing', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  for (let i = 0; i < 8; i += 1) {
    const peer = await join(server, { address: LAN_ADDRESS, key: i % 2 ? null : '' });
    peer.socket.close();
  }
  const dealer = await join(server, { address: LAN_ADDRESS, key: code });
  assert.equal(dealer.welcome.canControl, true);
});

test('the guess that starts a block is refused normally, later tries wait', onLan, async (t) => {
  let clock = 1_000_000;
  const server = await boot(t, { host: '0.0.0.0', now: () => clock });
  const { code } = await pairingOf(server);
  const tryCode = async (key) => {
    const peer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key });
    peer.socket.close();
    return peer.welcome;
  };

  for (let i = 0; i < 5; i += 1) {
    const refused = await tryCode('WRONG1');
    assert.equal(refused.canControl, false);
    assert.equal(refused.blocked, false);
    assert.equal(refused.retryInMs, 0);
  }

  clock += 10_000;
  for (const key of [code, 'WRONG1', null]) {
    const waiting = await tryCode(key);
    assert.equal(waiting.canControl, false);
    assert.equal(waiting.blocked, true);
    assert.equal(waiting.retryInMs, 50_000);
  }

  // A stored right code works the moment the block ends, with nothing typed.
  clock += 50_000;
  const back = await tryCode(code);
  assert.equal(back.canControl, true);
  assert.equal(back.blocked, false);
  assert.equal(back.retryInMs, 0);
});

test('a code sent during a block is not looked at, so it uses no guess', onLan, async (t) => {
  let clock = 1_000_000;
  const server = await boot(t, { host: '0.0.0.0', now: () => clock });
  const tryCode = async (key) => {
    const peer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key });
    peer.socket.close();
    return peer.welcome;
  };

  for (let i = 0; i < 5; i += 1) await tryCode('WRONG1');
  for (let i = 0; i < 20; i += 1) assert.equal((await tryCode('WRONG1')).blocked, true);

  clock += 60_000;
  for (let i = 0; i < 4; i += 1) assert.equal((await tryCode('WRONG1')).blocked, false);
  assert.equal((await tryCode('WRONG1')).blocked, false);
  assert.equal((await tryCode('WRONG1')).blocked, true);
});

test('this computer is never told to wait', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  for (let i = 0; i < 6; i += 1) await join(server, { address: LAN_ADDRESS, key: 'WRONG1' });
  assert.equal((await join(server, { address: LAN_ADDRESS, key: code })).welcome.blocked, true);

  const laptop = await join(server, { key: 'WRONG1' });
  assert.equal(laptop.welcome.canControl, true);
  assert.equal(laptop.welcome.blocked, false);
});

test('a socket that is already paired keeps working through a lockout', onLan, async (t) => {
  const server = await boot(t, { host: '0.0.0.0' });
  const { code } = await pairingOf(server);
  const dealer = await join(server, { address: LAN_ADDRESS, role: 'dealer', key: code });
  for (let i = 0; i < 6; i += 1) await join(server, { address: LAN_ADDRESS, key: 'WRONG1' });
  await play(dealer, 0, add('Alice'));
});

test('the throttle counts per address over a rolling minute', () => {
  let clock = 0;
  const gate = createGate('ABC234', () => clock);
  const [phone, other] = ['192.168.1.20', '192.168.1.21'];

  for (let i = 0; i < 4; i += 1) assert.equal(gate.mayControl(phone, 'WRONG1'), false);
  assert.equal(gate.mayControl(phone, 'ABC234'), true);

  // Those four age out, so one more bad code a minute later doesn't reach five.
  clock = 60_000;
  assert.equal(gate.mayControl(phone, 'WRONG1'), false);
  assert.equal(gate.mayControl(phone, 'ABC234'), true);

  for (let i = 0; i < 4; i += 1) gate.mayControl(phone, 'WRONG1');
  assert.equal(gate.mayControl(phone, 'ABC234'), false);
  assert.equal(gate.mayControl(other, 'ABC234'), true);

  // Tries during the lockout don't extend it.
  clock += 30_000;
  gate.mayControl(phone, 'WRONG1');
  clock += 30_000;
  assert.equal(gate.mayControl(phone, 'ABC234'), true);
  assert.equal(gate.mayControl(phone, 'WRONG1'), false);
  assert.equal(gate.mayControl(phone, 'ABC234'), true);
});

test('the gate says whether an address is blocked and for how much longer', () => {
  let clock = 0;
  const gate = createGate('ABC234', () => clock);
  const phone = '192.168.1.20';

  for (let i = 0; i < 4; i += 1) gate.mayControl(phone, 'WRONG1');
  assert.equal(gate.isBlocked(phone), false);
  assert.equal(gate.blockLeftMs(phone), 0);

  gate.mayControl(phone, 'WRONG1');
  assert.equal(gate.isBlocked(phone), true);
  assert.equal(gate.blockLeftMs(phone), 60_000);
  assert.equal(gate.isBlocked('192.168.1.21'), false);

  clock = 59_999;
  assert.equal(gate.isBlocked(phone), true);
  assert.equal(gate.blockLeftMs(phone), 1);

  clock = 60_000;
  assert.equal(gate.isBlocked(phone), false);
  assert.equal(gate.blockLeftMs(phone), 0);
});

test('asking whether an address is blocked uses no guess', () => {
  const gate = createGate('ABC234', () => 0);
  const phone = '192.168.1.20';
  for (let i = 0; i < 100; i += 1) gate.isBlocked(phone);
  for (let i = 0; i < 4; i += 1) gate.mayControl(phone, 'WRONG1');
  assert.equal(gate.mayControl(phone, 'ABC234'), true);
});

test('loopback means loopback, in every form the socket reports it', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback(address), true, address);
  }
  for (const address of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) {
    assert.equal(isLoopback(address), false, address);
  }
});

/* ---------- LAN address ---------- */

const ipv4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('the LAN address prefers en0 and skips what a phone cannot reach', () => {
  const interfaces = {
    lo0: [ipv4('127.0.0.1', true)],
    utun3: [ipv4('10.8.0.2')],
    bridge100: [ipv4('192.168.64.1')],
    vmnet8: [ipv4('172.16.5.1')],
    docker0: [ipv4('172.17.0.1')],
    awdl0: [ipv4('10.0.0.9')],
    llw0: [ipv4('10.0.0.10')],
    en5: [ipv4('192.168.1.50')],
    en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, ipv4('192.168.1.20')],
    en1: [ipv4('8.8.8.8'), ipv4('169.254.3.4')],
    wlan0: [ipv4('10.1.2.3')],
  };
  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.20', '192.168.1.50', '10.1.2.3']);
});

test('every private range counts and nothing else does', () => {
  const only = (address) => lanAddresses({ en0: [ipv4(address)] }).length === 1;
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.1']) {
    assert.equal(only(address), true, address);
  }
  for (const address of ['172.15.0.1', '172.32.0.1', '192.167.0.1', '11.0.0.1', '100.64.0.1']) {
    assert.equal(only(address), false, address);
  }
});

test('with no LAN address the phone address is localhost', () => {
  assert.deepEqual(phoneAddresses({ lo0: [ipv4('127.0.0.1', true)] }), ['localhost']);
  assert.deepEqual(phoneAddresses({ en0: [ipv4('192.168.1.20')] }), ['192.168.1.20']);
});

/* ---------- Shutdown ---------- */

test('close does not wait for a request that never finishes', async (t) => {
  const server = await boot(t);
  const stuck = net.connect(server.port, LOOPBACK);
  stuck.on('error', () => {});
  await once(stuck, 'connect');
  stuck.write('GET / HTTP/1.1\r\nHost: loc');
  await request(server.port, '/js/connection.js');

  let timer;
  const stalled = new Promise((resolve) => {
    timer = setTimeout(resolve, 3000, 'stalled');
  });
  const outcome = await Promise.race([server.close().then(() => 'closed'), stalled]);
  clearTimeout(timer);
  stuck.destroy();
  assert.equal(outcome, 'closed');
});

test('close is safe to call twice and frees the port', async (t) => {
  const server = await boot(t);
  await join(server);
  await request(server.port, '/js/connection.js');
  await Promise.all([server.close(), server.close()]);
  await assert.rejects(request(server.port, '/'), { code: 'ECONNREFUSED' });
});
