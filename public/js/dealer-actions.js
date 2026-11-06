// The only way anything reaches the game. A tap locks every button until the server has replied,
// and a new screen stays locked long enough for the second half of a double tap to land on
// nothing: a reply takes milliseconds, so waiting for it alone would let that tap hit the next
// player. The version sent is always the one on screen.

// Either way the tap went out and the phone can't know whether it landed.
const OUTCOME_UNKNOWN = new Set(['timeout', 'disconnected']);
const BUZZ_MS = 12;

function messageFor(error) {
  return OUTCOME_UNKNOWN.has(error.code)
    ? 'No reply. Check the wall, then try again.'
    : error.message;
}

export function createActions({ request, version, isOnline, onChange, onSend, onError }) {
  let busy = false;
  let guardUntil = 0;
  let guardTimer = 0;

  const isGuarded = () => performance.now() < guardUntil;
  const isBusy = () => busy || isGuarded();
  const isLocked = () => isBusy() || !isOnline();

  function guard(ms) {
    const until = performance.now() + ms;
    if (until <= guardUntil) return;
    guardUntil = until;
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      guardUntil = 0;
      onChange();
    }, ms);
    onChange();
  }

  // Steps run one after another without unlocking, each with the version the last one produced.
  // That is safe to read here because the server broadcasts a change before it acks it.
  async function run(messages) {
    if (isLocked() || messages.length === 0) return false;
    busy = true;
    onChange();
    onSend();
    navigator.vibrate?.(BUZZ_MS);
    try {
      for (const message of messages) await request({ ...message, version: version() });
      return true;
    } catch (error) {
      if (error.code !== 'stale') onError(messageFor(error));
      return false;
    } finally {
      busy = false;
      onChange();
    }
  }

  return {
    isLocked,
    isBusy,
    guard,
    dispatch: (...actions) => run(actions.map((action) => ({ type: 'game:action', action }))),
    undo: () => run([{ type: 'game:undo' }]),
  };
}
