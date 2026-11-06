// The one WebSocket client every page uses. It reconnects on its own, because phones
// drop sockets whenever the screen sleeps. It never queues commands across a reconnect:
// a bet that arrives late is worse than one the dealer has to tap again.

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 4000;
const PING_INTERVAL_MS = 10000;
const PING_TIMEOUT_MS = 4000;

export function connect({ role, key = null, onMessage, onStatus = () => {} }) {
  const pending = new Map();
  let socket = null;
  let currentKey = key;
  let attempts = 0;
  let nextRequestId = 1;
  let reconnectTimer = 0;
  let connectTimer = 0;
  let welcomed = false;

  function settle(requestId, error) {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve();
  }

  function rejectAll(code) {
    for (const requestId of [...pending.keys()]) {
      settle(requestId, Object.assign(new Error('Connection lost'), { code }));
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempts);
    attempts += 1;
    reconnectTimer = setTimeout(open, delay);
  }

  // Over a dead link a close waits about a minute for a handshake that can't finish, so a socket
  // that stops answering is given up on here rather than when the browser gets round to saying so.
  function drop(current) {
    if (socket !== current) return;
    clearTimeout(connectTimer);
    socket = null;
    welcomed = false;
    current.close();
    rejectAll('disconnected');
    onStatus('disconnected');
    scheduleReconnect();
  }

  function open() {
    clearTimeout(reconnectTimer);
    onStatus('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const current = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket = current;
    connectTimer = setTimeout(() => drop(current), CONNECT_TIMEOUT_MS);

    current.addEventListener('open', () => {
      current.send(JSON.stringify({ type: 'hello', role, key: currentKey }));
    });

    current.addEventListener('message', (event) => {
      if (socket !== current) return;
      const message = JSON.parse(event.data);
      if (message.type === 'ack') {
        settle(message.requestId);
      } else if (message.type === 'error' && pending.has(message.requestId)) {
        settle(
          message.requestId,
          Object.assign(new Error(message.message), { code: message.code }),
        );
      } else {
        if (message.type === 'welcome') {
          clearTimeout(connectTimer);
          attempts = 0;
          welcomed = true;
          onStatus('connected');
        }
        onMessage(message);
      }
    });

    current.addEventListener('close', () => drop(current));
  }

  const isOpen = () => socket?.readyState === WebSocket.OPEN && welcomed;

  function send(message) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function request(message, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) {
        reject(Object.assign(new Error('Not connected'), { code: 'disconnected' }));
        return;
      }
      const requestId = nextRequestId;
      nextRequestId += 1;
      const sentOn = socket;
      // A dead socket on a phone can still report itself as open, so only a reply proves it.
      const timer = setTimeout(() => {
        settle(requestId, Object.assign(new Error('No reply'), { code: 'timeout' }));
        drop(sentOn);
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...message, requestId }));
    });
  }

  function checkAlive() {
    if (!isOpen() || document.visibilityState !== 'visible') return;
    request({ type: 'ping' }, PING_TIMEOUT_MS).catch(() => {});
  }

  function reconnectNow() {
    if (!socket || socket.readyState === WebSocket.CLOSED) open();
    else checkAlive();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectNow();
  });
  window.addEventListener('online', reconnectNow);
  setInterval(checkAlive, PING_INTERVAL_MS);

  open();

  return {
    send,
    request,
    setKey(nextKey) {
      currentKey = nextKey;
      if (socket) drop(socket);
      else open();
    },
    // For a refused key, so that no reconnect sends it again. The socket stays up.
    clearKey() {
      currentKey = null;
    },
  };
}
