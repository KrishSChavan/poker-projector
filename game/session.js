// One running game plus its undo history. The server holds a single session and persists
// serialize() after every change, so a crash mid-hand loses nothing.

import { GameError, applyAction, createGame, describeAction, toView } from './engine.js';

const UNDO_LIMIT = 300;
const LOBBY_EDITS = new Set(['addPlayer', 'removePlayer', 'movePlayer', 'setDealer', 'setOptions']);
const PHASES = new Set([
  'lobby',
  'betting',
  'streetClosed',
  'showdown',
  'handComplete',
  'betweenHands',
  'gameOver',
]);

// A damaged state fails toView or the chip count, so it can't crash a later broadcast.
function isUsableState(state) {
  try {
    const { phase, players, options, pot } = toView(state);
    const chips = players.reduce((total, player) => total + player.stack, pot.total);
    const expected = state.tableChips ?? players.length * options.startingChips;
    return PHASES.has(phase) && chips === expected;
  } catch {
    return false;
  }
}

function isSavedGame(saved) {
  return Number.isSafeInteger(saved?.version) && saved.version >= 0 && isUsableState(saved.state);
}

function isSavedHistory(history) {
  return (
    Array.isArray(history) &&
    history.every((entry) => typeof entry?.label === 'string' && isUsableState(entry.state))
  );
}

// A save that can't be trusted starts a fresh game, the same as a missing file. Undo history is
// only a convenience, so a bad entry costs the history and leaves the game alone.
function restore(saved) {
  if (!isSavedGame(saved)) {
    const damage = saved === undefined ? null : 'game';
    return { state: createGame(), version: 0, history: [], damage };
  }
  if (isSavedHistory(saved.history)) return { ...structuredClone(saved), damage: null };
  return { ...structuredClone(saved), history: [], damage: 'history' };
}

export function createSession(saved) {
  const restored = restore(saved);
  let { state, version, history } = restored;

  function requireVersion(expected) {
    if (expected !== version) throw new GameError('stale', 'The game has moved on.');
  }

  return {
    // What a damaged save cost: 'history', 'game', or null if it cost nothing.
    damage: restored.damage,
    get view() {
      return toView(state);
    },
    get version() {
      return version;
    },
    get canUndo() {
      return history.length > 0;
    },
    get undoLabel() {
      return history.at(-1)?.label ?? null;
    },
    dispatch(action, expectedVersion) {
      requireVersion(expectedVersion);
      const next = applyAction(state, action);
      if (LOBBY_EDITS.has(action.type)) {
        history = [];
      } else {
        history = [...history, { state, label: describeAction(state, action) }].slice(-UNDO_LIMIT);
      }
      state = next;
      version += 1;
    },
    undo(expectedVersion) {
      requireVersion(expectedVersion);
      if (history.length === 0) throw new GameError('nothing-to-undo', 'There is nothing to undo.');
      state = history.at(-1).state;
      history = history.slice(0, -1);
      version += 1;
    },
    serialize() {
      return structuredClone({ state, version, history });
    },
  };
}
