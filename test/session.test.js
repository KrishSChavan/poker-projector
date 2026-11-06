import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameError, MAX_PLAYERS, MIN_PLAYERS, createGame } from '../game/engine.js';
import { createSession } from '../game/session.js';

const FOLD = { type: 'fold' };
const CALL = { type: 'call' };
const CHECK = { type: 'check' };
const START = { type: 'startGame' };
const END_GAME = { type: 'endGame' };
const NEXT_HAND = { type: 'nextHand' };
const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gia', 'Hal', 'Ivy'];

function send(session, ...actions) {
  for (const action of actions) session.dispatch(action, session.version);
}

function seated(count) {
  const session = createSession();
  send(session, ...NAMES.slice(0, count).map((name) => ({ type: 'addPlayer', name })));
  return session;
}

function running(count) {
  const session = seated(count);
  send(session, START);
  return session;
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof GameError && error.code === code);
}

test('a new session is an empty lobby at version 0', () => {
  for (const session of [createSession(), createSession(undefined), createSession(null)]) {
    assert.equal(session.version, 0);
    assert.equal(session.view.phase, 'lobby');
    assert.deepEqual(session.view.players, []);
    assert.equal(session.canUndo, false);
    assert.equal(session.undoLabel, null);
  }
});

test('version goes up by one on every successful dispatch and undo', () => {
  const session = createSession();
  session.dispatch({ type: 'addPlayer', name: 'Alice' }, 0);
  assert.equal(session.version, 1);
  session.dispatch({ type: 'addPlayer', name: 'Bob' }, 1);
  session.dispatch(START, 2);
  assert.equal(session.version, 3);
  session.dispatch(FOLD, 3);
  assert.equal(session.version, 4);
  session.undo(4);
  assert.equal(session.version, 5);
  session.undo(5);
  assert.equal(session.version, 6);
});

test('dispatch and undo throw stale on a version that does not match', () => {
  const session = running(3);
  const { version, view } = session;
  for (const stale of [version - 1, version + 1, undefined, null, String(version)]) {
    throwsCode(() => session.dispatch(FOLD, stale), 'stale');
    throwsCode(() => session.undo(stale), 'stale');
  }
  assert.equal(session.version, version);
  assert.deepEqual(session.view, view);
});

test('stale wins over a bad action, so a double tap never hits the next player', () => {
  const session = running(3);
  const shown = session.version;
  session.dispatch(FOLD, shown);
  const { view } = session;
  throwsCode(() => session.dispatch(FOLD, shown), 'stale');
  throwsCode(() => session.dispatch({ type: 'dance' }, shown), 'stale');
  assert.deepEqual(session.view, view);
});

test('a refused action changes nothing', () => {
  const session = running(2);
  const { version, view, undoLabel } = session;
  throwsCode(() => session.dispatch(CHECK, version), 'cannot-check');
  throwsCode(() => session.dispatch({ type: 'dance' }, version), 'unknown-action');
  throwsCode(() => session.dispatch(null, version), 'unknown-action');
  assert.equal(session.version, version);
  assert.deepEqual(session.view, view);
  assert.equal(session.undoLabel, undoLabel);
});

test('lobby edits are not undoable', () => {
  const session = seated(3);
  assert.equal(session.canUndo, false);
  assert.equal(session.undoLabel, null);
  send(
    session,
    { type: 'removePlayer', id: 'p3' },
    { type: 'movePlayer', id: 'p1', direction: 1 },
    { type: 'setDealer', id: 'p2' },
    { type: 'setOptions', startingChips: 500, smallBlind: 1, bigBlind: 2 },
  );
  assert.equal(session.canUndo, false);
  throwsCode(() => session.undo(session.version), 'nothing-to-undo');
});

test('a lobby edit clears the undo stack', () => {
  const session = running(2);
  send(session, FOLD, END_GAME);
  assert.equal(session.canUndo, true);
  send(session, { type: 'addPlayer', name: 'Cara' });
  assert.equal(session.canUndo, false);
  assert.equal(session.undoLabel, null);
});

test('undo after startGame returns to the lobby', () => {
  const session = seated(3);
  const lobby = session.view;
  send(session, START);
  assert.equal(session.undoLabel, 'Started the game');
  session.undo(session.version);
  assert.deepEqual(session.view, lobby);
  assert.equal(session.canUndo, false);
  send(session, { type: 'addPlayer', name: 'Dan' }, START);
  assert.equal(session.view.players.length, 4);
});

test('undoLabel names the most recent undoable action', () => {
  const session = running(3);
  send(session, { type: 'raise', to: 40 });
  assert.equal(session.undoLabel, 'Alice raised to 40');
  send(session, CALL);
  assert.equal(session.undoLabel, 'Bob called 35');
  send(session, FOLD);
  assert.equal(session.undoLabel, 'Cara folded');
  send(session, { type: 'nextStreet' });
  assert.equal(session.undoLabel, 'Dealt the flop');
  session.undo(session.version);
  assert.equal(session.undoLabel, 'Cara folded');
  session.undo(session.version);
  assert.equal(session.undoLabel, 'Bob called 35');
  session.undo(session.version);
  assert.equal(session.undoLabel, 'Alice raised to 40');
});

test('undo steps back through an award, a new hand and an ended game', () => {
  const session = running(2);
  send(session, FOLD);
  const showdown = session.view;
  send(session, { type: 'award' });
  const complete = session.view;
  assert.equal(session.undoLabel, 'Bob won 10');
  send(session, NEXT_HAND);
  const secondHand = session.view;
  assert.equal(secondHand.dealerId, 'p2');
  assert.equal(session.undoLabel, 'Started hand 2');
  send(session, END_GAME);
  assert.equal(session.view.phase, 'lobby');
  assert.equal(session.undoLabel, 'Ended the game');

  session.undo(session.version);
  assert.deepEqual(session.view, secondHand);
  session.undo(session.version);
  assert.deepEqual(session.view, complete);
  session.undo(session.version);
  assert.deepEqual(session.view, showdown);
});

test('undo works after a game over', () => {
  const session = running(2);
  send(session, { type: 'allIn' }, CALL);
  send(session, { type: 'nextStreet' }, { type: 'nextStreet' }, { type: 'nextStreet' });
  const showdown = session.view;
  send(session, { type: 'award', pots: [['p2']] });
  assert.equal(session.view.phase, 'gameOver');
  session.undo(session.version);
  assert.deepEqual(session.view, showdown);
  send(session, { type: 'award', pots: [['p1']] });
  assert.equal(session.view.gameWinnerId, 'p1');
});

test('the undo stack keeps the last 300 actions', () => {
  const session = seated(2);
  send(session, { type: 'setOptions', startingChips: 1000000, smallBlind: 1, bigBlind: 2 }, START);
  const views = [];
  for (let i = 0; i < 110; i += 1) {
    for (const action of [FOLD, { type: 'award' }, NEXT_HAND]) {
      views.push(session.view);
      send(session, action);
    }
  }
  assert.equal(views.length, 330);
  for (let i = 0; i < 300; i += 1) {
    assert.equal(session.canUndo, true);
    session.undo(session.version);
    assert.deepEqual(session.view, views.at(-1 - i));
  }
  assert.equal(session.canUndo, false);
  assert.equal(session.undoLabel, null);
  throwsCode(() => session.undo(session.version), 'nothing-to-undo');
});

test('nothing to undo leaves the version alone', () => {
  const session = createSession();
  throwsCode(() => session.undo(0), 'nothing-to-undo');
  assert.equal(session.version, 0);
});

test('a saved session restores everything, through JSON', () => {
  const session = running(3);
  send(session, { type: 'raise', to: 40 }, CALL);
  const restored = createSession(JSON.parse(JSON.stringify(session.serialize())));
  assert.equal(restored.version, session.version);
  assert.deepEqual(restored.view, session.view);
  assert.equal(restored.canUndo, true);
  assert.equal(restored.undoLabel, 'Bob called 35');
  restored.undo(restored.version);
  assert.equal(restored.undoLabel, 'Alice raised to 40');
  restored.undo(restored.version);
  restored.undo(restored.version);
  assert.equal(restored.view.phase, 'lobby');
  assert.equal(restored.canUndo, false);
});

test('a restored session plays on from where it stopped', () => {
  const session = running(3);
  send(session, CALL, CALL);
  const restored = createSession(session.serialize());
  send(session, CHECK);
  send(restored, CHECK);
  assert.deepEqual(restored.view, session.view);
  assert.equal(restored.version, session.version);
});

test('a save is a copy that later play cannot reach', () => {
  const session = running(2);
  const saved = session.serialize();
  const text = JSON.stringify(saved);
  send(session, FOLD);
  assert.equal(JSON.stringify(saved), text);

  const restored = createSession(saved);
  saved.state.players[0].stack = 1;
  saved.history.length = 0;
  assert.equal(restored.view.players[0].stack, 995);
  assert.equal(restored.canUndo, true);
});

test('changing a save cannot reach back into the session', () => {
  const session = running(2);
  send(session, CALL);
  const saved = session.serialize();
  saved.state.players[0].stack = 1;
  saved.history[0].label = 'changed';
  saved.history.length = 0;
  saved.version = 0;
  assert.equal(session.view.players[0].stack, 990);
  assert.equal(session.undoLabel, 'Alice called 5');
});

test('a view cannot reach back into the session', () => {
  const session = running(2);
  const { view } = session;
  view.players[0].stack = -1;
  view.legal.call = -1;
  assert.equal(session.view.players[0].stack, 995);
  assert.equal(session.view.legal.call, 5);
});

test('a damaged save starts a fresh game instead of crashing', () => {
  const good = running(3).serialize();
  const idle = seated(3).serialize();
  const broken = [
    {},
    'text',
    42,
    [],
    { ...good, version: -1 },
    { ...good, version: 1.5 },
    { ...good, version: '3' },
    { ...good, state: null },
    { ...good, state: {} },
    { ...good, state: { ...good.state, phase: 'nonsense' } },
    { ...idle, state: { ...idle.state, phase: 'nonsense' } },
    { ...good, state: { ...good.state, players: 'nobody' } },
    { ...good, state: { ...good.state, actingId: 'nobody' } },
    { ...good, state: { ...good.state, options: null } },
    { ...good, state: { ...good.state, players: good.state.players.slice(1) } },
  ];
  for (const saved of broken) {
    const session = createSession(saved);
    assert.equal(session.version, 0);
    assert.equal(session.view.phase, 'lobby');
    assert.deepEqual(session.view.players, []);
    assert.equal(session.canUndo, false);
    assert.equal(session.damage, 'game');
  }
  assert.equal(createSession(good).version, good.version);
});

test('a save with a usable game but unusable history keeps the game and drops the history', () => {
  const original = running(3);
  send(original, { type: 'raise', to: 40 }, CALL);
  const good = original.serialize();

  const broken = [
    { ...good, history: null },
    { ...good, history: undefined },
    { ...good, history: 'none' },
    { ...good, history: [null] },
    { ...good, history: [...good.history, { label: 'x', state: {} }] },
    { ...good, history: [{ state: good.state }] },
    { ...good, history: [good.history[0], { label: 'x', state: { phase: 'nonsense' } }] },
  ];
  for (const saved of broken) {
    const session = createSession(saved);
    assert.equal(session.version, good.version);
    assert.deepEqual(session.view, original.view);
    assert.equal(session.canUndo, false);
    assert.equal(session.undoLabel, null);
    assert.equal(session.damage, 'history');
    session.dispatch(CALL, session.version);
    assert.equal(session.undoLabel, 'Cara called 30');
  }
});

test('damage means a save was found and could not be fully used', () => {
  const good = running(2).serialize();
  assert.equal(createSession().damage, null);
  assert.equal(createSession(undefined).damage, null);
  assert.equal(createSession(good).damage, null);
  assert.equal(createSession(JSON.parse(JSON.stringify(good))).damage, null);
  assert.equal(createSession(null).damage, 'game');
  // At version 0 a rejected save looks like a fresh game unless the session says otherwise.
  assert.equal(createSession({ version: 0, state: {}, history: [] }).damage, 'game');
});

test('a restored lobby is accepted, even an empty one', () => {
  const session = createSession({ state: createGame(), version: 7, history: [] });
  assert.equal(session.version, 7);
  assert.equal(session.view.phase, 'lobby');
});

test('every action a session offers keeps the serialized form plain JSON', () => {
  const session = running(4);
  send(session, { type: 'raise', to: 40 }, CALL, FOLD, FOLD);
  const saved = session.serialize();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
});

// Random play through the session.

function mulberry32(seed) {
  let current = seed;
  return () => {
    current = (current + 0x6d2b79f5) | 0;
    let mixed = Math.imul(current ^ (current >>> 15), 1 | current);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, low, high) => low + Math.floor(rng() * (high - low + 1));
const pick = (rng, items) => items[Math.floor(rng() * items.length)];

function randomBettingAction(rng, { legal }) {
  const options = [FOLD];
  if (legal.check) options.push(CHECK, CHECK, CHECK);
  if (legal.call > 0) options.push(CALL, CALL, CALL);
  if (legal.allIn !== null) options.push({ type: 'allIn' });
  for (const type of ['bet', 'raise']) {
    if (legal[type]) options.push({ type, to: between(rng, legal[type].min, legal[type].max) });
  }
  return pick(rng, options);
}

function randomAward(rng, { pots }) {
  return {
    type: 'award',
    pots: pots.map(({ eligibleIds }) => {
      const winners = eligibleIds.filter(() => rng() < 0.4);
      return winners.length > 0 ? winners : [pick(rng, eligibleIds)];
    }),
  };
}

function randomAction(rng, view) {
  switch (view.phase) {
    case 'betting':
      return randomBettingAction(rng, view);
    case 'streetClosed':
      return { type: 'nextStreet' };
    case 'showdown':
      return randomAward(rng, view);
    case 'handComplete':
      return NEXT_HAND;
    case 'gameOver':
      return END_GAME;
    default:
      return START;
  }
}

function randomSession(rng) {
  const count = between(rng, MIN_PLAYERS, MAX_PLAYERS);
  const session = seated(count);
  const bigBlind = pick(rng, [2, 10, 50]);
  const startingChips = bigBlind * pick(rng, [2, 5, 20, 100]);
  const smallBlind = bigBlind / 2;
  send(session, { type: 'setOptions', startingChips, smallBlind, bigBlind });
  return session;
}

test('undoing back through whole games restores each earlier view exactly', () => {
  const rng = mulberry32(42);
  let longest = 0;
  for (let game = 0; game < 150; game += 1) {
    const session = randomSession(rng);
    const steps = [{ view: session.view, label: null }];
    const length = between(rng, 1, 500);
    for (let i = 0; i < length; i += 1) {
      send(session, randomAction(rng, session.view));
      steps.push({ view: session.view, label: session.undoLabel });
      assert.equal(session.canUndo, true);
    }
    longest = Math.max(longest, length);

    const undoable = Math.min(length, 300);
    for (let i = 1; i <= undoable; i += 1) {
      assert.equal(session.canUndo, true);
      assert.equal(session.undoLabel, steps.at(-i).label);
      const { version } = session;
      session.undo(version);
      assert.equal(session.version, version + 1);
      assert.deepEqual(session.view, steps.at(-i - 1).view);
    }
    assert.equal(session.canUndo, false);
    assert.equal(session.undoLabel, null);
  }
  assert.ok(longest > 300);
});

test('random dispatch, undo and restart stay in step with a model of the stack', () => {
  const rng = mulberry32(99);
  for (let game = 0; game < 60; game += 1) {
    let session = randomSession(rng);
    let model = [];
    let { version } = session;
    for (let turn = 0; turn < 400; turn += 1) {
      const roll = rng();
      if (roll < 0.2 && model.length > 0) {
        session.undo(version);
        version += 1;
        const { before } = model.pop();
        assert.deepEqual(session.view, before);
      } else if (roll < 0.25) {
        session = createSession(JSON.parse(JSON.stringify(session.serialize())));
      } else if (roll < 0.3 && session.view.phase === 'lobby') {
        const { players } = session.view;
        const firstId = players[0].id;
        session.dispatch({ type: 'setDealer', id: firstId }, version);
        version += 1;
        model = [];
      } else if (roll < 0.33) {
        throwsCode(() => session.dispatch(FOLD, version - 1), 'stale');
        throwsCode(() => session.undo(version + 1), 'stale');
      } else {
        const before = session.view;
        session.dispatch(randomAction(rng, before), version);
        version += 1;
        model.push({ before, label: session.undoLabel });
        if (model.length > 300) model.shift();
      }
      assert.equal(session.version, version);
      assert.equal(session.canUndo, model.length > 0);
      assert.equal(session.undoLabel, model.at(-1)?.label ?? null);
    }
  }
});
