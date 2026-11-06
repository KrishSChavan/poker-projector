import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from '../public/js/connection.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// Enough of a browser socket to go silent. `close()` only starts closing, as it does over a dead
// link, and the close event comes when a test says so.
function fakeBrowser(t) {
  const sockets = [];

  class FakeSocket {
    static OPEN = OPEN;
    static CLOSED = CLOSED;

    readyState = CONNECTING;
    sent = [];
    listeners = {};

    constructor() {
      sockets.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }

    send(text) {
      this.sent.push(JSON.parse(text));
    }

    close() {
      this.readyState = CLOSING;
    }

    deliver(message) {
      this.listeners.message({ data: JSON.stringify(message) });
    }

    answer() {
      this.readyState = OPEN;
      this.listeners.open();
      this.deliver({ type: 'welcome', connectionId: 'a', canControl: true });
    }

    finishClosing() {
      this.readyState = CLOSED;
      this.listeners.close();
    }
  }

  const page = { addEventListener() {}, visibilityState: 'visible' };
  const globals = {
    WebSocket: FakeSocket,
    window: { ...page, location: { protocol: 'http:', host: 'localhost:3000' } },
    document: page,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const name of Object.keys(globals)) delete globalThis[name];
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  return sockets;
}

function open(t) {
  const sockets = fakeBrowser(t);
  const statuses = [];
  const messages = [];
  const link = connect({
    role: 'dealer',
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
  });
  sockets[0].answer();
  return { sockets, statuses, messages, link };
}

test('a socket that stops answering pings is lost at once, without waiting for its close', (t) => {
  const { sockets, statuses } = open(t);
  t.mock.timers.tick(10_000);
  assert.equal(sockets[0].sent.at(-1).type, 'ping');
  assert.equal(statuses.at(-1), 'connected');

  t.mock.timers.tick(4_000);
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(sockets[0].readyState, CLOSING);

  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  assert.equal(statuses.at(-1), 'connecting');
});

test('a command with no reply rejects and takes the dead socket down with it', async (t) => {
  const { sockets, statuses, link } = open(t);
  const answer = link.request({ type: 'game:action' });
  const other = link.request({ type: 'ping' }, 60_000);
  t.mock.timers.tick(5_000);

  await assert.rejects(answer, { code: 'timeout' });
  await assert.rejects(other, { code: 'disconnected' });
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(link.send({ type: 'calibration:begin' }), false);
  assert.equal(sockets[0].sent.filter(({ type }) => type === 'calibration:begin').length, 0);
});

test('an attempt that hangs is given up on, so a returning network is noticed quickly', (t) => {
  const { sockets, statuses } = open(t);
  sockets[0].finishClosing();
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);

  t.mock.timers.tick(4_000);
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(sockets[1].readyState, CLOSING);

  t.mock.timers.tick(1_000);
  assert.equal(sockets.length, 3);
  sockets[2].answer();
  assert.equal(statuses.at(-1), 'connected');
});

test('a welcomed socket is not timed out by the connect limit', (t) => {
  const { statuses } = open(t);
  t.mock.timers.tick(4_000);
  assert.equal(statuses.at(-1), 'connected');
});

test('a socket that was given up on can no longer speak or start a second reconnect', (t) => {
  const { sockets, statuses, messages } = open(t);
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(4_000);
  const heard = messages.length;

  sockets[0].deliver({ type: 'game', version: 1 });
  assert.equal(messages.length, heard);

  sockets[0].finishClosing();
  assert.deepEqual(statuses.filter((status) => status === 'disconnected').length, 1);
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
});

test('nothing is queued while offline', async (t) => {
  const { sockets, link } = open(t);
  sockets[0].finishClosing();
  assert.equal(link.send({ type: 'calibration:begin' }), false);
  await assert.rejects(link.request({ type: 'game:action' }), { code: 'disconnected' });
  t.mock.timers.tick(500);
  sockets[1].answer();
  assert.deepEqual(sockets[1].sent.map(({ type }) => type), ['hello']);
});

test('a new key reconnects with that key', (t) => {
  const { sockets, link } = open(t);
  link.setKey('ABC234');
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].answer();
  assert.equal(sockets[1].sent[0].key, 'ABC234');
});

test('a key goes out again on every reconnect until it is cleared', (t) => {
  const { sockets, link } = open(t);
  link.setKey('ABC234');
  t.mock.timers.tick(500);
  sockets[1].answer();

  sockets[1].finishClosing();
  t.mock.timers.tick(500);
  sockets[2].answer();
  assert.equal(sockets[2].sent[0].key, 'ABC234');
});

test('clearing a key keeps the socket and takes the key off later hellos', (t) => {
  const { sockets, statuses, link } = open(t);
  link.setKey('ABC234');
  t.mock.timers.tick(500);
  sockets[1].answer();

  link.clearKey();
  assert.equal(statuses.at(-1), 'connected');
  assert.equal(sockets[1].readyState, OPEN);
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);

  sockets[1].finishClosing();
  t.mock.timers.tick(500);
  sockets[2].answer();
  assert.equal(sockets[2].sent[0].key, null);
});
