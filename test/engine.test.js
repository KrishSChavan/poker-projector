import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GameError,
  MAX_PLAYERS,
  MIN_PLAYERS,
  applyAction,
  createGame,
  describeAction,
  toView,
} from '../game/engine.js';

const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gia', 'Hal', 'Ivy'];
const FOLD = { type: 'fold' };
const CHECK = { type: 'check' };
const CALL = { type: 'call' };
const ALL_IN = { type: 'allIn' };
const NEXT_STREET = { type: 'nextStreet' };
const NEXT_HAND = { type: 'nextHand' };
const END_GAME = { type: 'endGame' };
const START = { type: 'startGame' };
const bet = (to) => ({ type: 'bet', to });
const raise = (to) => ({ type: 'raise', to });
const award = (...pots) => ({ type: 'award', pots });

const sum = (values) => values.reduce((total, value) => total + value, 0);
const play = (state, ...actions) => actions.reduce((s, action) => applyAction(s, action), state);

function lobby(count, options = {}) {
  const added = NAMES.slice(0, count).reduce(
    (state, name) => applyAction(state, { type: 'addPlayer', name }),
    createGame(),
  );
  return {
    ...added,
    options: { startingChips: 1000, smallBlind: 5, bigBlind: 10, ...options },
  };
}

// A hand already under way with exact stacks, which real play can only reach by chance.
function table(stacks, { dealer = 0, ...options } = {}) {
  const state = lobby(stacks.length, options);
  const players = state.players.map((player, i) => ({ ...player, stack: stacks[i] }));
  return applyAction({ ...state, players, dealerId: players[dealer].id }, START);
}

const person = (state, name) => toView(state).players.find((player) => player.name === name);
const acting = (state) => {
  const view = toView(state);
  return view.players.find((player) => player.id === view.actingId)?.name ?? null;
};
const idOf = (state, name) => person(state, name).id;
const bets = (state) => toView(state).players.map((player) => player.bet);
const stacks = (state) => toView(state).players.map((player) => player.stack);
const statuses = (state) => toView(state).players.map((player) => player.status);
const allChips = (state) => sum(stacks(state)) + toView(state).pot.total;

// Plays actions from `choose` until `isDone`. The cap turns a broken engine into a failure
// instead of a hang.
function playUntil(state, isDone, choose) {
  let current = state;
  for (let step = 0; step < 100; step += 1) {
    if (isDone(current)) return current;
    current = applyAction(current, choose(current));
  }
  return assert.fail(`no end in sight in phase ${current.phase}`);
}

// Everyone calls and checks through preflop, leaving the flop open.
function flop(chips, options) {
  const closed = playUntil(
    table(chips, options),
    (state) => state.phase !== 'betting',
    (state) => (toView(state).legal.check ? CHECK : CALL),
  );
  return applyAction(closed, NEXT_STREET);
}

// Checks every street down to the showdown.
function checkDown(state) {
  return playUntil(
    state,
    (current) => current.phase === 'showdown',
    (current) => (current.phase === 'betting' ? CHECK : NEXT_STREET),
  );
}

function tapToShowdown(state) {
  return playUntil(
    state,
    (current) => current.phase !== 'streetClosed',
    () => NEXT_STREET,
  );
}

function rejects(state, action, code) {
  assert.throws(
    () => applyAction(state, action),
    (error) => error instanceof GameError && error.code === code,
    `expected ${JSON.stringify(action)} to throw ${code}`,
  );
}

// Lobby

test('a new game is an empty lobby with the default options', () => {
  assert.equal(MIN_PLAYERS, 2);
  assert.equal(MAX_PLAYERS, 9);
  assert.deepEqual(toView(createGame()), {
    phase: 'lobby',
    options: { startingChips: 1000, smallBlind: 5, bigBlind: 10 },
    handNumber: 0,
    street: null,
    nextStreet: null,
    dealerId: null,
    nextDealerId: null,
    smallBlindId: null,
    bigBlindId: null,
    actingId: null,
    currentBet: 0,
    players: [],
    pot: { total: 0, collected: 0 },
    pots: [],
    legal: null,
    result: null,
    gameWinnerId: null,
  });
});

test('the view has exactly the contract fields in every phase', () => {
  const viewKeys = [
    'actingId',
    'bigBlindId',
    'currentBet',
    'dealerId',
    'gameWinnerId',
    'handNumber',
    'legal',
    'nextDealerId',
    'nextStreet',
    'options',
    'phase',
    'players',
    'pot',
    'pots',
    'result',
    'smallBlindId',
    'street',
  ];
  const playerKeys = [
    'bet',
    'committed',
    'id',
    'lastAction',
    'name',
    'payout',
    'seat',
    'stack',
    'status',
  ];
  const betting = table([1000, 1000, 1000]);
  const closed = play(betting, CALL, CALL, CHECK);
  const showdown = checkDown(closed);
  const complete = play(showdown, award(['p1']));
  for (const state of [lobby(3), betting, closed, showdown, complete]) {
    const view = toView(state);
    assert.deepEqual(Object.keys(view).sort(), viewKeys);
    for (const player of view.players) assert.deepEqual(Object.keys(player).sort(), playerKeys);
  }
  assert.deepEqual(Object.keys(toView(betting).legal).sort(), [
    'allIn',
    'bet',
    'call',
    'check',
    'fold',
    'raise',
  ]);
});

test('names are trimmed and ids come from a counter', () => {
  const state = play(
    createGame(),
    { type: 'addPlayer', name: '  Alice ' },
    { type: 'addPlayer', name: 'Bob' },
  );
  const view = toView(state);
  assert.deepEqual(
    view.players.map(({ id, name, seat, stack, status }) => [id, name, seat, stack, status]),
    [
      ['p1', 'Alice', 0, 1000, 'active'],
      ['p2', 'Bob', 1, 1000, 'active'],
    ],
  );
  assert.equal(view.dealerId, 'p1');
});

test('names must be 1 to 16 characters and unique ignoring case', () => {
  const state = play(createGame(), { type: 'addPlayer', name: 'Alice' });
  rejects(state, { type: 'addPlayer', name: '' }, 'bad-name');
  rejects(state, { type: 'addPlayer', name: '   ' }, 'bad-name');
  rejects(state, { type: 'addPlayer', name: 'x'.repeat(17) }, 'bad-name');
  rejects(state, { type: 'addPlayer', name: 42 }, 'bad-name');
  rejects(state, { type: 'addPlayer' }, 'bad-name');
  rejects(state, { type: 'addPlayer', name: 'ALICE' }, 'duplicate-name');
  rejects(state, { type: 'addPlayer', name: ' alice ' }, 'duplicate-name');
  assert.equal(toView(play(state, { type: 'addPlayer', name: 'x'.repeat(16) })).players.length, 2);
  assert.equal(toView(play(state, { type: 'addPlayer', name: '  B  ' })).players[1].name, 'B');
});

test('a character outside the basic plane still counts as one', () => {
  const state = play(createGame(), { type: 'addPlayer', name: '\u{1F0A1}'.repeat(16) });
  assert.equal(state.players.length, 1);
  rejects(state, { type: 'addPlayer', name: '\u{1F0A1}'.repeat(17) }, 'bad-name');
});

test('the lobby holds at most nine players', () => {
  const full = lobby(MAX_PLAYERS);
  assert.equal(full.players.length, 9);
  rejects(full, { type: 'addPlayer', name: 'Tenth' }, 'table-full');
});

test('removed ids are never reused and a removed dealer falls back to the first player', () => {
  let state = play(lobby(3), { type: 'setDealer', id: 'p2' });
  state = play(state, { type: 'removePlayer', id: 'p3' });
  assert.equal(toView(state).dealerId, 'p2');
  state = play(state, { type: 'removePlayer', id: 'p2' }, { type: 'addPlayer', name: 'New' });
  const view = toView(state);
  assert.deepEqual(
    view.players.map((player) => player.id),
    ['p1', 'p4'],
  );
  assert.equal(view.dealerId, 'p1');
  rejects(state, { type: 'removePlayer', id: 'nobody' }, 'unknown-player');
  assert.equal(toView(play(state, { type: 'removePlayer', id: 'p1' })).dealerId, 'p4');
  assert.equal(
    toView(play(state, { type: 'removePlayer', id: 'p1' }, { type: 'removePlayer', id: 'p4' }))
      .dealerId,
    null,
  );
});

test('moving a player changes seat order and keeps the dealer', () => {
  const state = play(
    lobby(3),
    { type: 'setDealer', id: 'p3' },
    { type: 'movePlayer', id: 'p3', direction: -1 },
  );
  const view = toView(state);
  assert.deepEqual(
    view.players.map((player) => [player.id, player.seat]),
    [
      ['p1', 0],
      ['p3', 1],
      ['p2', 2],
    ],
  );
  assert.equal(view.dealerId, 'p3');
  rejects(state, { type: 'movePlayer', id: 'p1', direction: -1 }, 'cannot-move');
  rejects(state, { type: 'movePlayer', id: 'p2', direction: 1 }, 'cannot-move');
  rejects(state, { type: 'movePlayer', id: 'p1', direction: 2 }, 'bad-direction');
  rejects(state, { type: 'movePlayer', id: 'p1' }, 'bad-direction');
  rejects(state, { type: 'movePlayer', id: 'nope', direction: 1 }, 'unknown-player');
});

test('the dealer can be chosen and starts the first hand', () => {
  const state = play(lobby(3), { type: 'setDealer', id: 'p2' }, START);
  const view = toView(state);
  assert.equal(view.dealerId, 'p2');
  assert.equal(view.smallBlindId, 'p3');
  assert.equal(view.bigBlindId, 'p1');
  rejects(lobby(3), { type: 'setDealer', id: 'nope' }, 'unknown-player');
});

test('options must be positive integers in a sensible order', () => {
  const valid = { type: 'setOptions', startingChips: 500, smallBlind: 10, bigBlind: 20 };
  const state = play(lobby(2), valid);
  assert.deepEqual(toView(state).options, { startingChips: 500, smallBlind: 10, bigBlind: 20 });
  assert.deepEqual(stacks(state), [500, 500]);
  assert.equal(toView(play(state, { type: 'addPlayer', name: 'Late' })).players[2].stack, 500);

  for (const bad of [
    { startingChips: 0 },
    { smallBlind: 0 },
    { bigBlind: -10 },
    { smallBlind: 2.5 },
    { bigBlind: '20' },
    { startingChips: NaN },
    { startingChips: Infinity },
    { startingChips: undefined },
    { startingChips: Number.MAX_SAFE_INTEGER },
    { smallBlind: 21 },
    { startingChips: 19 },
  ]) {
    rejects(state, { ...valid, ...bad }, 'bad-options');
  }
  assert.equal(toView(play(lobby(2), { ...valid, smallBlind: 20 })).options.smallBlind, 20);
  assert.equal(toView(play(lobby(2), { ...valid, startingChips: 20 })).options.startingChips, 20);
});

test('a game needs two players and locks the lobby once it runs', () => {
  rejects(createGame(), START, 'not-enough-players');
  rejects(lobby(1), START, 'not-enough-players');
  const running = play(lobby(2), START);
  assert.equal(toView(running).handNumber, 1);
  for (const action of [
    { type: 'addPlayer', name: 'Late' },
    { type: 'removePlayer', id: 'p1' },
    { type: 'movePlayer', id: 'p1', direction: 1 },
    { type: 'setDealer', id: 'p2' },
    { type: 'setOptions', startingChips: 1, smallBlind: 1, bigBlind: 1 },
    START,
  ]) {
    rejects(running, action, 'wrong-phase');
  }
});

test('unknown or malformed actions throw a GameError with a kebab-case code', () => {
  const state = table([1000, 1000]);
  for (const action of [null, undefined, 42, 'fold', {}, { type: 'dance' }, { type: 'toString' }]) {
    rejects(state, action, 'unknown-action');
  }
  const error = new GameError('stale');
  assert.equal(error.code, 'stale');
  assert.ok(error instanceof Error);
});

// Hand flow

test('with four players the blinds sit left of the dealer and left of them acts first', () => {
  const view = toView(table([1000, 1000, 1000, 1000]));
  assert.equal(view.phase, 'betting');
  assert.equal(view.handNumber, 1);
  assert.equal(view.street, 'preflop');
  assert.equal(view.nextStreet, null);
  assert.equal(view.dealerId, 'p1');
  assert.equal(view.smallBlindId, 'p2');
  assert.equal(view.bigBlindId, 'p3');
  assert.equal(view.actingId, 'p4');
  assert.equal(view.currentBet, 10);
  assert.deepEqual(
    view.players.map((player) => [player.stack, player.bet, player.committed, player.lastAction]),
    [
      [1000, 0, 0, null],
      [995, 5, 5, 'sb'],
      [990, 10, 10, 'bb'],
      [1000, 0, 0, null],
    ],
  );
  assert.deepEqual(view.pot, { total: 15, collected: 0 });
  assert.deepEqual(view.legal, {
    fold: true,
    check: false,
    call: 10,
    bet: null,
    raise: { min: 20, max: 1000 },
    allIn: 1000,
  });
});

test('with three players the dealer acts first preflop and the small blind first after', () => {
  const state = table([1000, 1000, 1000]);
  assert.equal(acting(state), 'Alice');
  const onFlop = play(state, CALL, CALL, CHECK, NEXT_STREET);
  assert.equal(acting(onFlop), 'Bob');
  assert.equal(acting(play(onFlop, CHECK)), 'Cara');
  assert.equal(acting(play(onFlop, CHECK, CHECK)), 'Alice');
});

test('nine handed, the player left of the big blind opens and the action runs clockwise', () => {
  const state = table(Array(9).fill(1000), { dealer: 7 });
  const view = toView(state);
  assert.equal(view.dealerId, 'p8');
  assert.equal(view.smallBlindId, 'p9');
  assert.equal(view.bigBlindId, 'p1');
  const order = [];
  let current = state;
  for (let i = 0; i < 9; i += 1) {
    order.push(acting(current));
    current = applyAction(current, toView(current).legal.check ? CHECK : CALL);
  }
  assert.deepEqual(order, ['Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gia', 'Hal', 'Ivy', 'Alice']);
  assert.equal(current.phase, 'streetClosed');
});

test('after the flop the first live player left of the dealer opens, skipping folds', () => {
  let state = table([1000, 1000, 1000, 1000]);
  state = play(state, CALL, CALL, FOLD, CHECK, NEXT_STREET);
  assert.equal(acting(state), 'Cara');
  assert.equal(acting(play(state, CHECK)), 'Dan');
  assert.equal(acting(play(state, CHECK, CHECK)), 'Alice');
});

test('the big blind gets its option when nobody raised', () => {
  const state = play(table([1000, 1000, 1000]), CALL, CALL);
  assert.equal(acting(state), 'Cara');
  const { legal, phase } = toView(state);
  assert.equal(phase, 'betting');
  assert.equal(legal.check, true);
  assert.equal(legal.call, 0);
  assert.deepEqual(legal.raise, { min: 20, max: 1000 });

  assert.equal(play(state, CHECK).phase, 'streetClosed');
  const raised = play(state, raise(30));
  assert.equal(acting(raised), 'Alice');
  assert.equal(toView(raised).legal.call, 20);
  assert.equal(play(raised, CALL, CALL).phase, 'streetClosed');
});

test('the big blind has no option after a raise, it must call or fold', () => {
  const state = play(table([1000, 1000, 1000]), raise(30), CALL);
  assert.equal(acting(state), 'Cara');
  assert.equal(toView(state).legal.check, false);
  assert.equal(toView(state).legal.call, 20);
});

test('heads up the dealer is the small blind, first preflop and last after', () => {
  const state = table([1000, 1000]);
  const view = toView(state);
  assert.equal(view.dealerId, 'p1');
  assert.equal(view.smallBlindId, 'p1');
  assert.equal(view.bigBlindId, 'p2');
  assert.equal(view.actingId, 'p1');
  assert.equal(view.legal.call, 5);

  const option = play(state, CALL);
  assert.equal(acting(option), 'Bob');
  assert.equal(toView(option).legal.check, true);

  const onFlop = play(option, CHECK, NEXT_STREET);
  assert.equal(acting(onFlop), 'Bob');
  assert.equal(acting(play(onFlop, CHECK)), 'Alice');
  assert.equal(play(onFlop, CHECK, CHECK).phase, 'streetClosed');
});

test('heads up the action closes when the dealer calls a raise from the big blind', () => {
  const state = play(table([1000, 1000]), CALL, raise(40));
  assert.equal(acting(state), 'Alice');
  assert.equal(play(state, CALL).phase, 'streetClosed');
});

test('bets stay out while the street is closed and are collected by nextStreet', () => {
  const closed = play(table([1000, 1000, 1000]), CALL, CALL, CHECK);
  const view = toView(closed);
  assert.equal(view.phase, 'streetClosed');
  assert.equal(view.street, 'preflop');
  assert.equal(view.nextStreet, 'flop');
  assert.equal(view.actingId, null);
  assert.equal(view.legal, null);
  assert.deepEqual(bets(closed), [10, 10, 10]);
  assert.deepEqual(view.pot, { total: 30, collected: 0 });

  const next = play(closed, NEXT_STREET);
  const opened = toView(next);
  assert.equal(opened.phase, 'betting');
  assert.equal(opened.street, 'flop');
  assert.equal(opened.nextStreet, null);
  assert.equal(opened.currentBet, 0);
  assert.deepEqual(bets(next), [0, 0, 0]);
  assert.deepEqual(opened.pot, { total: 30, collected: 30 });
  assert.deepEqual(
    opened.players.map((player) => player.lastAction),
    [null, null, null],
  );
  assert.deepEqual(
    opened.players.map((player) => player.committed),
    [10, 10, 10],
  );
});

test('pot total includes street bets and collected does not', () => {
  const state = play(flop([1000, 1000, 1000]), bet(50));
  assert.deepEqual(toView(state).pot, { total: 80, collected: 30 });
});

test('streets run flop, turn, river and the river closes straight into showdown', () => {
  let state = play(table([1000, 1000]), CALL, CHECK);
  for (const [street, following] of [
    ['flop', 'turn'],
    ['turn', 'river'],
  ]) {
    state = play(state, NEXT_STREET);
    assert.equal(toView(state).street, street);
    state = play(state, CHECK, CHECK);
    assert.equal(toView(state).phase, 'streetClosed');
    assert.equal(toView(state).nextStreet, following);
  }
  state = play(state, NEXT_STREET);
  assert.equal(toView(state).street, 'river');
  state = play(state, bet(10), CALL);
  const view = toView(state);
  assert.equal(view.phase, 'showdown');
  assert.equal(view.street, 'river');
  assert.equal(view.nextStreet, null);
  assert.equal(view.result, null);
  assert.deepEqual(bets(state), [0, 0]);
  assert.deepEqual(view.pot, { total: 40, collected: 40 });
});

test('with everyone all in the dealer taps through every street', () => {
  const seen = [];
  const state = playUntil(
    play(table([200, 200]), ALL_IN, CALL),
    (current) => current.phase !== 'streetClosed',
    (current) => {
      seen.push(toView(current).nextStreet);
      return NEXT_STREET;
    },
  );
  assert.deepEqual(seen, ['flop', 'turn', 'river']);
  const view = toView(state);
  assert.equal(view.phase, 'showdown');
  assert.equal(view.street, 'river');
});

test('one player with chips against an all in gets no betting street', () => {
  const state = play(table([200, 1000, 1000]), ALL_IN, FOLD, CALL);
  const view = toView(state);
  assert.equal(view.phase, 'streetClosed');
  const onFlop = play(state, NEXT_STREET);
  assert.equal(toView(onFlop).phase, 'streetClosed');
  assert.equal(toView(onFlop).street, 'flop');
  assert.equal(toView(onFlop).nextStreet, 'turn');
  assert.equal(toView(onFlop).actingId, null);
});

test('two players with chips keep betting beside an all in', () => {
  const state = play(table([200, 1000, 1000]), ALL_IN, CALL, CALL, NEXT_STREET);
  assert.equal(toView(state).phase, 'betting');
  assert.equal(acting(state), 'Bob');
  const closed = play(state, CHECK, CHECK);
  assert.equal(toView(closed).phase, 'streetClosed');
  assert.equal(toView(closed).nextStreet, 'turn');
  assert.deepEqual(statuses(closed), ['allIn', 'active', 'active']);
});

test('when everyone else folds the hand goes straight to showdown', () => {
  const state = play(table([1000, 1000, 1000]), raise(30), FOLD, FOLD);
  const view = toView(state);
  assert.equal(view.phase, 'showdown');
  assert.equal(view.street, 'preflop');
  assert.equal(view.result, null);
  assert.equal(view.actingId, null);
  assert.equal(view.legal, null);
  assert.deepEqual(view.pots, [{ label: 'Main pot', amount: 25, eligibleIds: ['p1'] }]);
  const done = toView(play(state, { type: 'award' }));
  assert.equal(done.phase, 'handComplete');
  assert.equal(done.result.foldOut, true);
});

// Short blinds and the amount to call

test('a short big blind posts what it has and everyone else still owes the full blind', () => {
  const state = table([1000, 1000, 6, 1000]);
  const view = toView(state);
  assert.deepEqual(statuses(state), ['active', 'active', 'allIn', 'active']);
  assert.equal(person(state, 'Cara').bet, 6);
  assert.equal(person(state, 'Cara').lastAction, 'bb');
  assert.equal(view.currentBet, 10);
  assert.equal(view.legal.call, 10);
  assert.deepEqual(view.legal.raise, { min: 20, max: 1000 });
  const afterCalls = play(state, CALL, CALL, CALL);
  assert.equal(afterCalls.phase, 'streetClosed');
  assert.deepEqual(bets(afterCalls), [10, 10, 6, 10]);
});

test('a short small blind posts what it has and is all in', () => {
  const state = table([1000, 3, 1000]);
  assert.deepEqual(statuses(state), ['active', 'allIn', 'active']);
  assert.equal(person(state, 'Bob').bet, 3);
  assert.equal(person(state, 'Bob').lastAction, 'sb');
  assert.equal(toView(state).legal.call, 10);
  const closed = play(state, CALL, CHECK);
  assert.deepEqual(bets(closed), [10, 3, 10]);
});

test('nobody pays more than the most any one opponent can match', () => {
  const state = table([1000, 3, 7]);
  const { legal, actingId, currentBet } = toView(state);
  assert.equal(actingId, 'p1');
  assert.equal(currentBet, 10);
  assert.equal(legal.call, 7);
  assert.equal(legal.check, false);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, null);

  const closed = play(state, CALL);
  assert.equal(closed.phase, 'streetClosed');
  assert.deepEqual(bets(closed), [7, 3, 7]);
  assert.deepEqual(stacks(closed), [993, 0, 0]);
});

test('heads up the small blind only tops up to what a short big blind holds', () => {
  const state = table([1000, 7]);
  assert.equal(toView(state).legal.call, 2);
  assert.equal(toView(state).legal.raise, null);
  assert.equal(toView(state).legal.allIn, null);
  const closed = play(state, CALL);
  assert.equal(closed.phase, 'streetClosed');
  assert.deepEqual(bets(closed), [7, 7]);
});

test('heads up with the big blind under the small blind nobody gets a turn', () => {
  const state = table([1000, 3]);
  const view = toView(state);
  assert.equal(view.phase, 'streetClosed');
  assert.equal(view.nextStreet, 'flop');
  assert.deepEqual(bets(state), [3, 3]);
  assert.deepEqual(stacks(state), [997, 0]);
  assert.equal(allChips(state), 1003);
});

test('heads up a short small blind leaves the big blind nothing to do', () => {
  const state = table([3, 1000]);
  const view = toView(state);
  assert.equal(view.phase, 'streetClosed');
  assert.deepEqual(bets(state), [3, 3]);
  assert.deepEqual(stacks(state), [0, 997]);
  assert.deepEqual(statuses(state), ['allIn', 'active']);
});

test('heads up, both blinds all in, the bigger one gets the difference back', () => {
  const state = table([5, 3]);
  assert.equal(state.phase, 'streetClosed');
  assert.deepEqual(bets(state), [3, 3]);
  assert.deepEqual(stacks(state), [2, 0]);
  assert.deepEqual(statuses(state), ['active', 'allIn']);
});

test('the opponent left is what caps the call once others fold', () => {
  const state = table([1000, 1000, 3, 1000]);
  assert.equal(toView(state).legal.call, 10);
  const closed = play(state, FOLD, FOLD);
  assert.equal(closed.phase, 'streetClosed');
  assert.deepEqual(bets(closed), [0, 3, 3, 0]);
  assert.deepEqual(stacks(closed), [1000, 997, 0, 1000]);
});

test('a stack below the blind calls for less', () => {
  const state = play(table([6, 1000, 8, 1000]), FOLD);
  assert.equal(acting(state), 'Alice');
  const { legal } = toView(state);
  assert.equal(legal.call, 6);
  assert.equal(legal.allIn, 6);
  assert.equal(legal.raise, null);
});

test('the cap comes from the biggest stack left to match, not the short blind', () => {
  const state = table([1000, 8, 3]);
  assert.equal(toView(state).legal.call, 8);
  const called = play(state, CALL);
  assert.equal(person(called, 'Alice').bet, 8);
  assert.equal(acting(called), 'Bob');
  assert.equal(toView(called).legal.call, 3);
  assert.equal(toView(called).legal.allIn, 8);
  assert.equal(play(called, CALL).phase, 'streetClosed');
});

test('no turn is owed by a player with nobody left who can act', () => {
  const state = play(table([7, 1000, 1000]), CALL, FOLD);
  const view = toView(state);
  assert.equal(view.phase, 'streetClosed');
  assert.deepEqual(bets(state), [7, 5, 7]);
  assert.deepEqual(stacks(state), [0, 995, 993]);
  assert.equal(person(state, 'Cara').status, 'active');
});

test('an exact call by the last opponent ends the round without a big blind option', () => {
  const state = play(table([1000, 10]), CALL);
  assert.equal(state.phase, 'streetClosed');
  assert.deepEqual(bets(state), [10, 10]);
});

test('the big blind keeps its option beside a short all in when another can still act', () => {
  const state = play(table([7, 1000, 1000]), CALL, CALL);
  assert.equal(acting(state), 'Cara');
  assert.equal(toView(state).legal.check, true);
  assert.deepEqual(toView(state).legal.raise, { min: 20, max: 1000 });
});

// Betting rules

test('bet is only legal with no bet this street and raise only with one', () => {
  const state = table([1000, 1000]);
  assert.equal(toView(state).legal.bet, null);
  rejects(state, bet(20), 'cannot-bet');

  const onFlop = play(state, CALL, CHECK, NEXT_STREET);
  assert.deepEqual(toView(onFlop).legal.bet, { min: 10, max: 990 });
  assert.equal(toView(onFlop).legal.raise, null);
  assert.equal(toView(onFlop).legal.check, true);
  assert.equal(toView(onFlop).legal.call, 0);
  rejects(onFlop, raise(20), 'cannot-raise');

  const facing = play(onFlop, bet(40));
  assert.equal(toView(facing).legal.bet, null);
  rejects(facing, bet(80), 'cannot-bet');
});

test('a bet is at least the big blind and at most the stack', () => {
  const state = flop([1000, 1000]);
  rejects(state, bet(9), 'bad-amount');
  rejects(state, bet(991), 'bad-amount');
  rejects(state, bet(10.5), 'bad-amount');
  rejects(state, bet('40'), 'bad-amount');
  rejects(state, { type: 'bet' }, 'bad-amount');
  rejects(state, bet(NaN), 'bad-amount');
  rejects(state, bet(Infinity), 'bad-amount');
  assert.equal(toView(play(state, bet(10))).currentBet, 10);
});

test('a raise is at least the current bet plus the last full raise', () => {
  const state = table([1000, 1000, 1000]);
  rejects(state, raise(19), 'bad-amount');
  const first = play(state, raise(35));
  assert.equal(toView(first).currentBet, 35);
  assert.deepEqual(toView(first).legal.raise, { min: 60, max: 1000 });
  rejects(first, raise(59), 'bad-amount');
  const second = play(first, raise(60));
  assert.deepEqual(toView(second).legal.raise, { min: 85, max: 1000 });
  const third = play(second, raise(200));
  assert.deepEqual(toView(third).legal.raise, { min: 340, max: 1000 });
});

test('the full raise size starts again at the big blind on each street', () => {
  const state = play(table([1000, 1000]), raise(100), raise(300), CALL, NEXT_STREET);
  assert.deepEqual(toView(state).legal.bet, { min: 10, max: 700 });
  const raised = play(state, bet(10));
  assert.deepEqual(toView(raised).legal.raise, { min: 20, max: 700 });
});

test('raise amounts are street totals, counting chips already in front', () => {
  const state = play(table([1000, 1000]), raise(40));
  assert.equal(person(state, 'Alice').stack, 960);
  assert.equal(person(state, 'Alice').bet, 40);
  assert.equal(person(state, 'Alice').committed, 40);
  assert.equal(person(state, 'Alice').lastAction, 'raise');
});

test('a bet or raise that uses the whole stack counts as all in', () => {
  const onFlop = flop([100, 100]);
  const betAll = play(onFlop, bet(90));
  assert.equal(person(betAll, 'Bob').status, 'allIn');
  assert.equal(person(betAll, 'Bob').lastAction, 'allIn');
  assert.equal(person(betAll, 'Bob').stack, 0);

  const preflop = table([100, 100]);
  const raisedAll = play(preflop, raise(100));
  assert.equal(person(raisedAll, 'Alice').status, 'allIn');
  assert.equal(person(raisedAll, 'Alice').lastAction, 'allIn');
});

test('a call that uses the whole stack counts as all in', () => {
  const state = play(table([500, 100]), raise(200), CALL);
  assert.equal(person(state, 'Bob').status, 'allIn');
  assert.equal(person(state, 'Bob').lastAction, 'allIn');
  assert.equal(person(state, 'Bob').stack, 0);
});

test('a raise below the minimum is refused even for the whole stack, all in takes it', () => {
  const state = table([15, 1000]);
  const { legal } = toView(state);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, 15);
  rejects(state, raise(15), 'cannot-raise');
  const short = play(state, ALL_IN);
  assert.equal(person(short, 'Alice').status, 'allIn');
  assert.equal(toView(short).currentBet, 15);
});

test('a bet below the big blind is only possible as an all in', () => {
  const facing = play(flop([16, 1000, 1000], { dealer: 1 }), CHECK);
  assert.equal(acting(facing), 'Alice');
  const { legal } = toView(facing);
  assert.equal(legal.bet, null);
  assert.equal(legal.allIn, 6);
  rejects(facing, bet(6), 'cannot-bet');
  assert.equal(toView(play(facing, ALL_IN)).currentBet, 6);
});

test('check and call are refused when they make no sense', () => {
  const state = table([1000, 1000]);
  rejects(state, CHECK, 'cannot-check');
  const option = play(state, CALL);
  rejects(option, CALL, 'nothing-to-call');
});

test('betting actions are refused outside the betting phase', () => {
  const closed = play(table([1000, 1000]), CALL, CHECK);
  for (const action of [FOLD, CHECK, CALL, bet(10), raise(10), ALL_IN]) {
    rejects(closed, action, 'wrong-phase');
  }
  rejects(table([1000, 1000]), NEXT_STREET, 'wrong-phase');
  rejects(table([1000, 1000]), NEXT_HAND, 'wrong-phase');
  rejects(table([1000, 1000]), award(['p1']), 'wrong-phase');
});

test('fold is always offered, even with nothing to call', () => {
  const state = flop([1000, 1000]);
  assert.equal(toView(state).legal.fold, true);
  assert.equal(toView(state).legal.check, true);
  assert.equal(play(state, FOLD).phase, 'showdown');
});

// Short all in raises

// On the flop of [Alice dealer, Bob, Cara, Dan] the order is Bob, Cara, Dan, Alice.
const short = (danStack) => flop([1000, 1000, 1000, danStack + 10]);

test('a short all in lifts the bet, keeps the full raise size and does not reopen', () => {
  let state = play(short(190), bet(100), CALL, ALL_IN);
  assert.equal(toView(state).currentBet, 190);
  assert.equal(acting(state), 'Alice');

  // Alice has not acted, so she may still raise, sized by the last full raise.
  assert.deepEqual(toView(state).legal.raise, { min: 290, max: 990 });
  state = play(state, CALL);

  assert.equal(acting(state), 'Bob');
  let { legal } = toView(state);
  assert.equal(legal.call, 90);
  assert.equal(legal.raise, null);
  assert.equal(legal.bet, null);
  assert.equal(legal.allIn, null);
  rejects(state, raise(290), 'cannot-raise');
  rejects(state, ALL_IN, 'cannot-all-in');

  state = play(state, CALL);
  assert.equal(acting(state), 'Cara');
  ({ legal } = toView(state));
  assert.equal(legal.raise, null);
  assert.equal(play(state, CALL).phase, 'streetClosed');
});

test('a short all in that a player can only call for less keeps All in on offer', () => {
  const facing = play(flop([1000, 160, 1000, 200]), bet(100), CALL, ALL_IN, CALL);
  assert.equal(acting(facing), 'Bob');
  const { legal } = toView(facing);
  assert.equal(legal.call, 50);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, 150);
  const called = play(facing, ALL_IN);
  assert.equal(person(called, 'Bob').status, 'allIn');
  assert.equal(person(called, 'Bob').bet, 150);
  assert.equal(toView(called).currentBet, 190);
});

test('an all in of exactly a full raise reopens the betting', () => {
  const state = play(short(200), bet(100), CALL, ALL_IN, CALL);
  assert.equal(toView(state).currentBet, 200);
  assert.equal(acting(state), 'Bob');
  assert.deepEqual(toView(state).legal.raise, { min: 300, max: 990 });
});

test('an all in one chip short of a full raise does not reopen', () => {
  const state = play(short(199), bet(100), CALL, ALL_IN, CALL);
  assert.equal(acting(state), 'Bob');
  assert.equal(toView(state).legal.raise, null);
  assert.equal(toView(state).legal.allIn, null);
});

test('several short all ins that add up to a full raise reopen the betting', () => {
  const state = flop([1000, 1000, 150, 210]);
  // Cara shoves 140, Dan shoves 200: neither is a full raise over 100, together they are.
  const facing = play(state, bet(100), ALL_IN, ALL_IN);
  assert.equal(toView(facing).currentBet, 200);
  assert.deepEqual(toView(facing).legal.raise, { min: 300, max: 990 });

  const back = play(facing, CALL);
  assert.equal(acting(back), 'Bob');
  assert.deepEqual(toView(back).legal.raise, { min: 300, max: 990 });
});

test('short all ins count from the level each player last acted at', () => {
  const state = flop([240, 1000, 160, 1000]);
  // Bob acted at 100, Dan at 150, then two short all ins take the bet to 230.
  const facing = play(state, bet(100), ALL_IN, CALL, ALL_IN);
  assert.equal(toView(facing).currentBet, 230);
  assert.equal(acting(facing), 'Bob');
  assert.deepEqual(toView(facing).legal.raise, { min: 330, max: 990 });

  const dan = play(facing, CALL);
  assert.equal(acting(dan), 'Dan');
  assert.equal(toView(dan).legal.call, 80);
  assert.equal(toView(dan).legal.raise, null);
  assert.equal(toView(dan).legal.allIn, null);
});

test('a later full raise reopens the betting for everyone', () => {
  const state = play(short(190), bet(100), CALL, ALL_IN, raise(290));
  assert.equal(acting(state), 'Bob');
  assert.deepEqual(toView(state).legal.raise, { min: 390, max: 990 });
  const bobCalls = play(state, CALL);
  assert.equal(acting(bobCalls), 'Cara');
  assert.deepEqual(toView(bobCalls).legal.raise, { min: 390, max: 990 });
});

test('a raise after a short all in is sized from the last full raise', () => {
  const state = play(short(190), bet(100), CALL, ALL_IN);
  rejects(state, raise(289), 'bad-amount');
  const raised = play(state, raise(290));
  assert.equal(toView(raised).currentBet, 290);
  assert.deepEqual(toView(raised).legal.raise, { min: 390, max: 990 });
});

test('a short all in over a first bet does not reopen for the player who checked', () => {
  const state = flop([1000, 1000, 16, 1000]);
  const facing = play(state, CHECK, ALL_IN);
  assert.equal(toView(facing).currentBet, 6);
  assert.equal(acting(facing), 'Dan');
  assert.deepEqual(toView(facing).legal.raise, { min: 16, max: 990 });

  const back = play(facing, CALL, CALL);
  assert.equal(acting(back), 'Bob');
  assert.equal(toView(back).legal.call, 6);
  assert.equal(toView(back).legal.raise, null);
  assert.equal(toView(back).legal.bet, null);
  assert.equal(toView(back).legal.allIn, null);
});

test('a short all in on the big blind option does not reopen for the limpers', () => {
  const state = play(table([1000, 1000, 15, 1000]), CALL, CALL, CALL);
  assert.equal(acting(state), 'Cara');
  const facing = play(state, ALL_IN);
  assert.equal(toView(facing).currentBet, 15);
  assert.equal(acting(facing), 'Dan');
  assert.equal(toView(facing).legal.call, 5);
  assert.equal(toView(facing).legal.raise, null);
  assert.equal(play(facing, CALL, CALL, CALL).phase, 'streetClosed');
});

test('a short all in before the blinds act leaves them free to raise', () => {
  const state = play(table([1000, 1000, 1000, 13]), ALL_IN, CALL);
  assert.equal(toView(state).currentBet, 13);
  assert.equal(acting(state), 'Bob');
  assert.deepEqual(toView(state).legal.raise, { min: 23, max: 1000 });
  const closed = play(state, CALL);
  assert.equal(acting(closed), 'Cara');
  assert.deepEqual(toView(closed).legal.raise, { min: 23, max: 1000 });
});

test('a full raise before a short all in stays open to whoever has not answered it', () => {
  const state = flop([1000, 1000, 1000, 360]);
  const facing = play(state, bet(100), raise(300), ALL_IN, FOLD);
  assert.equal(toView(facing).currentBet, 350);
  assert.equal(acting(facing), 'Bob');
  assert.deepEqual(toView(facing).legal.raise, { min: 550, max: 990 });
  const carasTurn = play(facing, CALL);
  assert.equal(acting(carasTurn), 'Cara');
  assert.equal(toView(carasTurn).legal.raise, null);
  assert.equal(toView(carasTurn).legal.call, 50);
});

// Nobody left to call a raise

test('a player cannot raise when everyone else is all in', () => {
  const state = play(table([300, 200, 1000]), ALL_IN, ALL_IN);
  assert.equal(acting(state), 'Cara');
  const { legal } = toView(state);
  assert.equal(legal.call, 290);
  assert.equal(legal.raise, null);
  assert.equal(legal.bet, null);
  assert.equal(legal.allIn, null);
  rejects(state, raise(600), 'cannot-raise');
  rejects(state, ALL_IN, 'cannot-all-in');
});

test('a player cannot raise when everyone else has folded or gone all in', () => {
  const state = play(table([300, 1000, 1000, 1000]), FOLD, ALL_IN, FOLD);
  assert.equal(acting(state), 'Cara');
  const { legal } = toView(state);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, null);
  assert.equal(legal.call, 290);
});

test('all in stays on offer when it is a call for less', () => {
  const state = play(table([500, 1000, 300]), raise(100), ALL_IN);
  assert.equal(acting(state), 'Cara');
  const { legal } = toView(state);
  assert.equal(legal.call, 290);
  assert.equal(legal.allIn, 300);
  assert.equal(legal.raise, null);
});

test('all in stays on offer when the call takes exactly the whole stack', () => {
  const state = play(table([1000, 200]), raise(200));
  const { legal } = toView(state);
  assert.equal(legal.call, 190);
  assert.equal(legal.allIn, 200);
  assert.equal(legal.raise, null);
});

test('no raise when nobody still to act can reach past the current bet', () => {
  const state = play(table([1000, 100, 200, 300]), ALL_IN);
  assert.equal(acting(state), 'Alice');
  const { legal } = toView(state);
  assert.equal(legal.call, 300);
  assert.equal(legal.raise, null);
  assert.equal(legal.allIn, null);

  const oneChipMore = play(table([1000, 100, 301, 300]), ALL_IN);
  assert.deepEqual(toView(oneChipMore).legal.raise, { min: 590, max: 1000 });
  assert.equal(toView(oneChipMore).legal.allIn, 1000);
});

// Uncalled bets

test('a raise everyone folds to is returned down to the next highest bet', () => {
  const state = play(table([1000, 1000, 1000]), raise(50), FOLD, FOLD);
  assert.deepEqual(stacks(state), [990, 995, 990]);
  assert.equal(person(state, 'Alice').committed, 10);
  assert.equal(toView(state).pot.total, 25);
  assert.deepEqual(stacks(play(state, award())), [1015, 995, 990]);
});

test('a walk returns the big blind what the small blind did not match', () => {
  const state = play(table([1000, 1000, 1000]), FOLD, FOLD);
  assert.equal(person(state, 'Cara').committed, 5);
  assert.equal(toView(state).pot.total, 10);
  const done = play(state, award());
  assert.deepEqual(stacks(done), [1000, 995, 1005]);
  assert.equal(person(done, 'Cara').payout, 10);
});

test('heads up a fold from the small blind returns the big blind its extra chips', () => {
  const done = play(table([1000, 1000]), FOLD, award());
  assert.deepEqual(stacks(done), [995, 1005]);
});

test('an over the top all in gets the excess back and returns to active', () => {
  const state = play(table([500, 1000, 200]), FOLD, ALL_IN, ALL_IN);
  assert.equal(state.phase, 'streetClosed');
  const bob = person(state, 'Bob');
  assert.equal(bob.status, 'active');
  assert.equal(bob.stack, 800);
  assert.equal(bob.bet, 200);
  assert.equal(bob.committed, 200);
  assert.equal(person(state, 'Cara').status, 'allIn');
  assert.equal(toView(state).currentBet, 200);
  assert.equal(toView(state).pot.total, 400);
  assert.equal(allChips(state), 1700);
});

test('a player given chips back is never left all in', () => {
  const state = play(table([100, 300]), ALL_IN, FOLD);
  assert.equal(state.phase, 'showdown');
  assert.equal(person(state, 'Alice').status, 'active');
  assert.equal(person(state, 'Alice').stack, 90);
  assert.equal(person(state, 'Alice').committed, 10);
});

test('the next highest bet counts folded chips too', () => {
  const state = play(flop([1000, 1000, 1000, 1000]), bet(100), raise(300), FOLD, FOLD, FOLD);
  assert.equal(state.phase, 'showdown');
  assert.equal(person(state, 'Cara').stack, 890);
  assert.equal(person(state, 'Cara').committed, 110);
  assert.equal(toView(state).pot.total, 240);
});

test('only chips from this street come back', () => {
  const state = play(flop([1000, 1000, 1000]), bet(100), FOLD, FOLD);
  assert.equal(state.phase, 'showdown');
  assert.equal(person(state, 'Bob').committed, 10);
  assert.equal(person(state, 'Bob').stack, 990);
  assert.equal(toView(state).pot.total, 30);
});

test('a called bet is not returned, and tied top bets are left alone', () => {
  const state = play(flop([1000, 1000, 1000]), bet(100), CALL, FOLD);
  assert.deepEqual(bets(state), [0, 100, 100]);
  assert.equal(toView(state).pot.total, 230);
});

test('a bet on the river that gets no call comes back before the showdown', () => {
  let state = flop([1000, 1000, 1000]);
  state = play(state, CHECK, CHECK, CHECK, NEXT_STREET, CHECK, CHECK, CHECK, NEXT_STREET);
  assert.equal(toView(state).street, 'river');
  state = play(state, bet(200), FOLD, FOLD);
  assert.equal(toView(state).phase, 'showdown');
  assert.equal(person(state, 'Bob').stack, 990);
  assert.equal(toView(state).pot.total, 30);
});

test('a short call on the last street refunds the difference before showdown', () => {
  let state = flop([1000, 1000, 110]);
  state = play(state, CHECK, CHECK, CHECK, NEXT_STREET, CHECK, CHECK, CHECK, NEXT_STREET);
  state = play(state, bet(300), ALL_IN, FOLD);
  assert.equal(toView(state).phase, 'showdown');
  assert.equal(person(state, 'Bob').stack, 890);
  assert.equal(person(state, 'Bob').committed, 110);
  assert.equal(toView(state).pots[0].amount, 230);
});

test('a chip count survives every refund', () => {
  for (const [state, total] of [
    [play(table([1000, 3]), NEXT_STREET), 1003],
    [play(table([500, 1000, 200]), FOLD, ALL_IN, ALL_IN), 1700],
    [play(table([100, 300]), ALL_IN, FOLD), 400],
  ]) {
    assert.equal(allChips(state), total);
  }
});

// Pots

test('a normal betting round shows one main pot, however uneven the street bets', () => {
  const state = play(table([1000, 1000, 1000, 1000]), raise(100));
  assert.deepEqual(toView(state).pots, [
    { label: 'Main pot', amount: 115, eligibleIds: ['p1', 'p2', 'p3', 'p4'] },
  ]);
});

test('an all in splits off a side pot as soon as chips go past it', () => {
  const state = play(table([1000, 1000, 1000, 100]), ALL_IN, raise(300));
  assert.deepEqual(toView(state).pots, [
    { label: 'Main pot', amount: 215, eligibleIds: ['p1', 'p2', 'p3', 'p4'] },
    { label: 'Side pot 1', amount: 200, eligibleIds: ['p1', 'p2', 'p3'] },
  ]);
});

test('four different stacks all in build a main pot and two side pots', () => {
  const state = play(table([100, 300, 500, 1000]), ALL_IN, ALL_IN, ALL_IN, ALL_IN);
  assert.deepEqual(toView(state).pots, [
    { label: 'Main pot', amount: 400, eligibleIds: ['p1', 'p2', 'p3', 'p4'] },
    { label: 'Side pot 1', amount: 600, eligibleIds: ['p2', 'p3', 'p4'] },
    { label: 'Side pot 2', amount: 400, eligibleIds: ['p3', 'p4'] },
  ]);
  assert.equal(toView(state).pot.total, 1400);

  const done = play(tapToShowdown(state), award(['p1'], ['p2'], ['p3', 'p4']));
  assert.deepEqual(stacks(done), [400, 600, 200, 700]);
  assert.equal(allChips(done), 1900);
});

test('folded chips fall into the layers they reach', () => {
  const state = play(table([1000, 1000, 1000, 100]), ALL_IN, raise(300), FOLD, CALL, NEXT_STREET);
  // Dan is all in for 100. Alice and Cara have 300 in. Bob folded his 5.
  assert.equal(acting(state), 'Cara');
  const finished = play(state, bet(100), FOLD);
  assert.deepEqual(toView(finished).pots, [
    { label: 'Main pot', amount: 305, eligibleIds: ['p3', 'p4'] },
    { label: 'Side pot 1', amount: 400, eligibleIds: ['p3'] },
  ]);
  assert.equal(person(finished, 'Cara').committed, 300);
  assert.equal(allChips(finished), 3100);
});

test('folded chips above a level fill the layers above it', () => {
  const state = play(table([1000, 1000, 1000, 100]), ALL_IN, raise(300), raise(500), CALL, FOLD);
  // Dan 100 all in, Alice folds at 300 between Bob and Cara's 500.
  assert.equal(state.phase, 'streetClosed');
  const view = toView(play(state, NEXT_STREET));
  assert.deepEqual(view.pots, [
    { label: 'Main pot', amount: 400, eligibleIds: ['p2', 'p3', 'p4'] },
    { label: 'Side pot 1', amount: 1000, eligibleIds: ['p2', 'p3'] },
  ]);
});

// Betting rules stop a folded player from ever being the single highest, so these two states are
// built by hand. They pin what the rules say chips should do if it ever happened.
function deadMoney(phase, [aliceStatus, caraStatus]) {
  const state = table([1000, 1000, 1000]);
  const contributions = [
    { committed: 10, stack: 0, status: aliceStatus },
    { committed: 60, stack: 940, status: 'folded' },
    { committed: 8, stack: 0, status: caraStatus },
  ];
  const players = state.players.map((player, i) => ({ ...player, bet: 0, ...contributions[i] }));
  return { ...state, phase, actingId: null, players };
}

test('folded chips above the top level go to the top pot', () => {
  const { pots } = toView(deadMoney('showdown', ['allIn', 'allIn']));
  assert.deepEqual(pots, [
    { label: 'Main pot', amount: 24, eligibleIds: ['p1', 'p3'] },
    { label: 'Side pot 1', amount: 54, eligibleIds: ['p1'] },
  ]);
});

test('an uncalled bet from a folded player stays in the pot', () => {
  const live = deadMoney('betting', ['allIn', 'active']);
  const players = live.players.map((player) => ({
    ...player,
    bet: player.status === 'folded' ? 50 : 0,
    stack: player.status === 'active' ? 992 : player.stack,
  }));
  const state = { ...live, players, actingId: 'p3', currentBet: 0, street: 'river' };
  const done = play(state, CHECK);
  assert.equal(toView(done).phase, 'showdown');
  assert.equal(person(done, 'Bob').stack, 940);
  assert.equal(person(done, 'Bob').committed, 60);
});

test('side pots with one player left are decided and need no pick', () => {
  const state = play(table([1000, 1000, 1000, 100]), ALL_IN, raise(300), FOLD, CALL, NEXT_STREET);
  const finished = tapToShowdown(play(state, bet(100), FOLD));
  assert.equal(toView(finished).phase, 'showdown');
  for (const action of [award(['p4']), award(['p4'], []), award(['p4'], ['p3'])]) {
    const done = play(finished, action);
    assert.equal(toView(done).phase, 'handComplete');
    assert.equal(person(done, 'Dan').payout, 305);
    assert.equal(person(done, 'Cara').payout, 400);
  }
  rejects(finished, award(['p3'], ['p4']), 'bad-award');
});

test('the pots add up to the pot total at every stage', () => {
  let state = table([1000, 1000, 1000, 100]);
  for (const action of [ALL_IN, raise(300), CALL, FOLD, NEXT_STREET, bet(50), raise(100)]) {
    state = play(state, action);
    const { pots, pot } = toView(state);
    assert.equal(sum(pots.map(({ amount }) => amount)), pot.total);
  }
});

test('a top bettor refunded to a folded bet leaves that money in a decided side pot', () => {
  const state = play(
    table([1000, 1000, 400, 200]),
    ALL_IN, // Dan shoves 200
    raise(600), // Alice
    ALL_IN, // Bob shoves 1000
    ALL_IN, // Cara calls for 400
    FOLD, // Alice folds her 600
  );
  assert.equal(state.phase, 'streetClosed');
  const bob = person(state, 'Bob');
  assert.equal(bob.status, 'active');
  assert.equal(bob.committed, 600);
  assert.equal(bob.stack, 400);
  assert.deepEqual(toView(state).pots, [
    { label: 'Main pot', amount: 800, eligibleIds: ['p2', 'p3', 'p4'] },
    { label: 'Side pot 1', amount: 600, eligibleIds: ['p2', 'p3'] },
    { label: 'Side pot 2', amount: 400, eligibleIds: ['p2'] },
  ]);
});

// Awarding

test('one tap awards a fold out with no picks at all', () => {
  const state = play(table([1000, 1000, 1000]), raise(30), FOLD, FOLD);
  for (const action of [{ type: 'award' }, award(), award([]), award(['p1'])]) {
    const done = toView(play(state, action));
    assert.equal(done.phase, 'handComplete');
    assert.equal(done.result.foldOut, true);
    assert.deepEqual(done.result.pots, [
      { label: 'Main pot', amount: 25, winnerIds: ['p1'], shares: { p1: 25 } },
    ]);
    assert.equal(done.players[0].payout, 25);
    assert.equal(done.players[1].payout, 0);
  }
});

test('a contested pot needs a winner who is still in it', () => {
  const state = checkDown(play(table([1000, 1000, 1000]), CALL, FOLD, CHECK));
  assert.equal(toView(state).phase, 'showdown');
  rejects(state, { type: 'award' }, 'bad-award');
  rejects(state, award(), 'bad-award');
  rejects(state, award([]), 'bad-award');
  rejects(state, award(['p2']), 'bad-award');
  rejects(state, award(['nobody']), 'bad-award');
  rejects(state, award(['p1', 'p1']), 'bad-award');
  rejects(state, award(['p1'], ['p3']), 'bad-award');
  rejects(state, award('p1'), 'bad-award');
  rejects(state, { type: 'award', pots: 'p1' }, 'bad-award');
  rejects(state, { type: 'award', pots: null }, 'bad-award');
  rejects(state, { type: 'award', pots: {} }, 'bad-award');
  const done = toView(play(state, award(['p3'])));
  assert.equal(done.result.foldOut, false);
  assert.equal(done.players[2].payout, 25);
});

test('every contested pot needs a winner', () => {
  const state = tapToShowdown(play(table([100, 300, 500, 1000]), ALL_IN, ALL_IN, ALL_IN, ALL_IN));
  rejects(state, award(['p1']), 'bad-award');
  rejects(state, award(['p1'], ['p2']), 'bad-award');
  rejects(state, award(['p2'], ['p1'], ['p3']), 'bad-award');
});

test('a split pot pays equal shares', () => {
  const state = checkDown(play(table([1000, 1000, 1000]), CALL, CALL, CHECK));
  const done = toView(play(state, award(['p1', 'p2', 'p3'])));
  assert.deepEqual(done.result.pots[0].shares, { p2: 10, p3: 10, p1: 10 });
  assert.deepEqual(
    done.players.map((player) => player.stack),
    [1000, 1000, 1000],
  );
});

test('an odd chip goes to the first winner clockwise from the dealer', () => {
  const state = checkDown(play(table([1000, 1000, 1000]), CALL, FOLD, CHECK));
  assert.equal(toView(state).pot.total, 25);
  const done = toView(play(state, award(['p1', 'p3'])));
  assert.deepEqual(done.result.pots[0].shares, { p3: 13, p1: 12 });
  assert.deepEqual(done.result.pots[0].winnerIds, ['p3', 'p1']);
});

test('several odd chips go out one at a time from the dealer clockwise', () => {
  const hand = table([1000, 1000, 1000, 1000], { dealer: 1 });
  const state = checkDown(play(hand, CALL, CALL, FOLD, CHECK));
  assert.equal(toView(state).pot.total, 35);
  const done = toView(play(state, award(['p2', 'p1', 'p4'])));
  assert.deepEqual(done.result.pots[0].shares, { p4: 12, p1: 12, p2: 11 });
});

test('the dealer is last in line for an odd chip', () => {
  const state = checkDown(play(table([1000, 1000, 1000], { dealer: 2 }), CALL, FOLD, CHECK));
  assert.equal(toView(state).pot.total, 25);
  const done = toView(play(state, award(['p3', 'p2'])));
  assert.deepEqual(done.result.pots[0].shares, { p2: 13, p3: 12 });
});

test('each pot is split by its own winners', () => {
  const state = tapToShowdown(play(table([100, 300, 500, 1000]), ALL_IN, ALL_IN, ALL_IN, ALL_IN));
  const done = toView(play(state, award(['p1', 'p4'], ['p2', 'p3', 'p4'], ['p4'])));
  assert.deepEqual(
    done.result.pots.map((pot) => [pot.label, pot.amount, pot.winnerIds, pot.shares]),
    [
      ['Main pot', 400, ['p4', 'p1'], { p4: 200, p1: 200 }],
      ['Side pot 1', 600, ['p2', 'p3', 'p4'], { p2: 200, p3: 200, p4: 200 }],
      ['Side pot 2', 400, ['p4'], { p4: 400 }],
    ],
  );
  assert.deepEqual(
    done.players.map((player) => player.payout),
    [200, 200, 200, 800],
  );
});

test('an award empties the pot, keeps the result and marks the busted', () => {
  const state = tapToShowdown(play(table([100, 300, 500, 1000]), ALL_IN, ALL_IN, ALL_IN, ALL_IN));
  const done = play(state, award(['p4'], ['p4'], ['p4']));
  const view = toView(done);
  assert.equal(view.phase, 'gameOver');
  assert.equal(view.gameWinnerId, 'p4');
  assert.deepEqual(view.pot, { total: 0, collected: 0 });
  assert.deepEqual(view.pots, []);
  assert.deepEqual(statuses(done), ['out', 'out', 'out', 'active']);
  assert.equal(allChips(done), 1900);
});

test('all in winners stop being all in once they hold chips again', () => {
  const state = tapToShowdown(play(table([100, 100, 1000]), ALL_IN, ALL_IN, CALL));
  const done = play(state, award(['p1']));
  assert.equal(toView(done).phase, 'handComplete');
  assert.equal(person(done, 'Alice').status, 'active');
  assert.equal(person(done, 'Bob').status, 'out');
  assert.equal(person(done, 'Cara').status, 'active');
});

test('award is refused twice and in the wrong phase', () => {
  const done = play(table([1000, 1000]), FOLD, award());
  rejects(done, award(), 'wrong-phase');
});

// Game over and the moving dealer chip

test('the game ends when one player holds all the chips', () => {
  const state = tapToShowdown(play(table([1000, 1000]), ALL_IN, CALL));
  const view = toView(play(state, award(['p2'])));
  assert.equal(view.phase, 'gameOver');
  assert.equal(view.gameWinnerId, 'p2');
  assert.equal(view.legal, null);
  assert.equal(view.actingId, null);
  for (const action of [NEXT_HAND, FOLD, NEXT_STREET, award(['p2']), START]) {
    rejects(play(state, award(['p2'])), action, 'wrong-phase');
  }
});

test('nextHand moves the dealer clockwise and wraps around', () => {
  let state = table([1000, 1000, 1000]);
  const dealers = [];
  for (let i = 0; i < 4; i += 1) {
    dealers.push(toView(state).dealerId);
    state = play(state, FOLD, FOLD, award(), NEXT_HAND);
  }
  assert.deepEqual(dealers, ['p1', 'p2', 'p3', 'p1']);
  assert.equal(toView(state).handNumber, 5);
  assert.equal(toView(state).smallBlindId, 'p3');
  assert.equal(toView(state).bigBlindId, 'p1');
});

test('nextHand clears the last hand', () => {
  const state = play(table([1000, 1000, 1000]), FOLD, FOLD, award(), NEXT_HAND);
  const view = toView(state);
  assert.equal(view.result, null);
  assert.equal(view.phase, 'betting');
  assert.equal(view.street, 'preflop');
  assert.equal(view.currentBet, 10);
  assert.deepEqual(
    view.players.map((player) => player.payout),
    [0, 0, 0],
  );
  assert.equal(view.players[0].lastAction, 'bb');
});

test('the dealer chip, blinds and action all skip busted players', () => {
  const state = table([1000, 5, 1000, 1000]);
  const finished = checkDown(play(state, CALL, CALL, CHECK));
  const everyone = ['p1', 'p3', 'p4'];
  const done = play(finished, award(everyone, everyone));
  assert.equal(person(done, 'Bob').stack, 0);
  assert.equal(person(done, 'Bob').status, 'out');

  const next = play(done, NEXT_HAND);
  const view = toView(next);
  assert.equal(view.dealerId, 'p3');
  assert.equal(view.smallBlindId, 'p4');
  assert.equal(view.bigBlindId, 'p1');
  assert.equal(view.actingId, 'p3');
  assert.equal(person(next, 'Bob').status, 'out');
  assert.equal(person(next, 'Bob').bet, 0);

  const onFlop = play(next, CALL, CALL, CHECK, NEXT_STREET);
  assert.equal(acting(onFlop), 'Dan');
  assert.equal(acting(play(onFlop, CHECK)), 'Alice');
  assert.equal(acting(play(onFlop, CHECK, CHECK)), 'Cara');
  assert.equal(play(onFlop, CHECK, CHECK, CHECK).phase, 'streetClosed');
});

test('blinds wrap past a busted player next to the dealer', () => {
  const state = table([1000, 5, 1000]);
  const done = play(checkDown(play(state, CALL, CHECK)), award(['p1'], ['p1']));
  assert.equal(person(done, 'Bob').status, 'out');
  const view = toView(play(done, NEXT_HAND));
  assert.equal(view.dealerId, 'p3');
  assert.equal(view.smallBlindId, 'p3');
  assert.equal(view.bigBlindId, 'p1');
  assert.equal(view.actingId, 'p3');
});

test('heads up rules start as soon as only two players hold chips', () => {
  const state = table([1000, 1000, 5]);
  const done = play(checkDown(play(state, CALL, CALL)), award(['p1'], ['p1']));
  assert.equal(person(done, 'Cara').stack, 0);
  const next = play(done, NEXT_HAND);
  const view = toView(next);
  assert.equal(view.dealerId, 'p2');
  assert.equal(view.smallBlindId, 'p2');
  assert.equal(view.bigBlindId, 'p1');
  assert.equal(view.actingId, 'p2');
  const onFlop = play(next, CALL, CHECK, NEXT_STREET);
  assert.equal(acting(onFlop), 'Alice');
});

test('a short big blind can win back chips and the game carries on', () => {
  const state = table([1000, 1000, 3]);
  const closed = tapToShowdown(checkDown(play(state, CALL, CALL)));
  assert.equal(toView(closed).phase, 'showdown');
  const done = play(closed, award(['p3'], ['p1']));
  assert.equal(person(done, 'Cara').stack, 9);
  assert.equal(person(done, 'Cara').status, 'active');
  assert.equal(toView(done).phase, 'handComplete');
});

// Ending the game

test('endGame works from every running phase and resets the stacks', () => {
  const betting = table([1000, 1000, 1000]);
  const closed = play(betting, CALL, CALL, CHECK);
  const showdown = checkDown(closed);
  const complete = play(showdown, award(['p1']));
  const gameOver = play(tapToShowdown(play(table([1000, 1000]), ALL_IN, CALL)), award(['p1']));
  for (const state of [betting, closed, showdown, complete, gameOver]) {
    const view = toView(applyAction(state, END_GAME));
    assert.equal(view.phase, 'lobby');
    assert.equal(view.handNumber, 0);
    assert.equal(view.street, null);
    assert.equal(view.nextStreet, null);
    assert.equal(view.smallBlindId, null);
    assert.equal(view.bigBlindId, null);
    assert.equal(view.actingId, null);
    assert.equal(view.currentBet, 0);
    assert.equal(view.result, null);
    assert.equal(view.gameWinnerId, null);
    assert.equal(view.legal, null);
    assert.deepEqual(view.pots, []);
    assert.deepEqual(view.pot, { total: 0, collected: 0 });
    for (const player of view.players) {
      assert.equal(player.stack, view.options.startingChips);
      assert.equal(player.status, 'active');
      assert.equal(player.bet, 0);
      assert.equal(player.committed, 0);
      assert.equal(player.payout, 0);
      assert.equal(player.lastAction, null);
    }
  }
  rejects(createGame(), END_GAME, 'wrong-phase');
});

test('after endGame the same players can start again and edit the lobby', () => {
  const state = play(table([1000, 1000, 1000]), FOLD, END_GAME);
  const view = toView(state);
  assert.deepEqual(
    view.players.map((player) => player.name),
    ['Alice', 'Bob', 'Cara'],
  );
  const edited = play(state, { type: 'addPlayer', name: 'Dan' }, START);
  assert.equal(toView(edited).handNumber, 1);
  assert.equal(person(edited, 'Dan').id, 'p4');
});

test('endGame keeps the dealer where the chip was', () => {
  const state = play(table([1000, 1000, 1000]), FOLD, FOLD, award(), NEXT_HAND, END_GAME);
  assert.equal(toView(state).dealerId, 'p2');
});

// Descriptions

test('describeAction reads the state before the action', () => {
  const state = table([1000, 1000, 1000]);
  assert.equal(describeAction(state, raise(40)), 'Alice raised to 40');
  assert.equal(describeAction(state, CALL), 'Alice called 10');
  assert.equal(describeAction(state, FOLD), 'Alice folded');
  assert.equal(describeAction(state, ALL_IN), 'Alice raised to 1,000, all in');
  const onFlop = flop([1000, 1000, 1000]);
  assert.equal(describeAction(onFlop, CHECK), 'Bob checked');
  assert.equal(describeAction(onFlop, bet(50)), 'Bob bet 50');
  assert.equal(describeAction(onFlop, bet(990)), 'Bob bet 990, all in');
  assert.equal(describeAction(onFlop, ALL_IN), 'Bob bet 990, all in');
  assert.equal(describeAction(play(state, raise(40)), CALL), 'Bob called 35');
});

test('describeAction says when a call puts the player all in', () => {
  const state = play(table([500, 100, 1000]), raise(200));
  assert.equal(describeAction(state, CALL), 'Bob called 95, all in');
  assert.equal(describeAction(state, ALL_IN), 'Bob called 95, all in');
});

test('describeAction covers the steps between the betting', () => {
  const closed = play(table([1000, 1000]), CALL, CHECK);
  assert.equal(describeAction(closed, NEXT_STREET), 'Dealt the flop');
  assert.equal(describeAction(lobby(2), START), 'Started the game');
  assert.equal(describeAction(closed, END_GAME), 'Ended the game');

  const showdown = checkDown(closed);
  assert.equal(describeAction(showdown, award(['p2'])), 'Bob won 20');
  assert.equal(describeAction(showdown, award(['p1', 'p2'])), 'Split 20 between Alice, Bob');
  const foldOut = play(table([1000, 1000]), FOLD);
  assert.equal(describeAction(foldOut, { type: 'award' }), 'Bob won 10');
  const done = play(foldOut, award());
  assert.equal(describeAction(done, NEXT_HAND), 'Started hand 2');
  const several = tapToShowdown(play(table([100, 300, 500, 1000]), ALL_IN, ALL_IN, ALL_IN, ALL_IN));
  assert.equal(describeAction(several, award(['p1'], ['p2'], ['p3'])), 'Awarded 3 pots');
});

test('describeAction names the lobby edits', () => {
  const state = lobby(2);
  assert.equal(describeAction(state, { type: 'addPlayer', name: ' Cara ' }), 'Added Cara');
  assert.equal(describeAction(state, { type: 'removePlayer', id: 'p2' }), 'Removed Bob');
  const down = { type: 'movePlayer', id: 'p1', direction: 1 };
  const up = { type: 'movePlayer', id: 'p2', direction: -1 };
  assert.equal(describeAction(state, down), 'Moved Alice down');
  assert.equal(describeAction(state, up), 'Moved Bob up');
  assert.equal(describeAction(state, { type: 'setDealer', id: 'p2' }), 'Bob starts as dealer');
  assert.equal(describeAction(state, { type: 'setOptions' }), 'Changed the game options');
});

// Purity

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test('applyAction never changes the state it was given, even when it refuses', () => {
  const state = deepFreeze(table([1000, 1000, 100]));
  const before = JSON.stringify(state);
  const next = applyAction(state, raise(30));
  assert.equal(JSON.stringify(state), before);
  assert.notEqual(next, state);
  assert.notEqual(next.players, state.players);
  rejects(state, CHECK, 'cannot-check');
  assert.equal(JSON.stringify(state), before);
});

test('a view shares nothing with the state', () => {
  const state = play(table([1000, 1000]), FOLD, award());
  const copy = JSON.stringify(state);
  const view = toView(state);
  view.players[0].stack = -1;
  view.options.bigBlind = -1;
  view.result.pots[0].amount = -1;
  assert.equal(JSON.stringify(state), copy);
});

// Seeded random play. The referee below never reads engine state beyond the view: it works out
// from the rules alone whose turn it is and what is legal, then checks the engine agrees.

const SIMULATED_HANDS = 15000;
const MAX_GAME_STEPS = 20000;

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
const isLive = (player) => player.status === 'active' || player.status === 'allIn';
const seatOf = (view, id) => view.players.findIndex((player) => player.id === id);
const playerById = (view, id) => view.players[seatOf(view, id)];
const nextStreetAfter = { preflop: 'flop', flop: 'turn', turn: 'river' };

// Moves chips around the table so the first hand has mixed stacks with the same total.
function scatterChips(rng, players) {
  for (let i = between(rng, 0, players.length * 2); i > 0; i -= 1) {
    const from = pick(rng, players);
    const amount = between(rng, 0, from.stack - 1);
    from.stack -= amount;
    pick(rng, players).stack += amount;
  }
}

// Short stacks around the big blind next to deep ones. Random stacks almost never line up so
// that several short all ins add up to a full raise, and this is the shape that does it.
function dealLadderStacks(rng, players, bigBlind) {
  const shuffled = players
    .map((player) => ({ player, order: rng() }))
    .sort((a, b) => a.order - b.order)
    .map(({ player }) => player);
  const shortCount = between(rng, 2, players.length - 2);
  let spare = sum(players.map(({ stack }) => stack));
  for (const player of shuffled.slice(0, shortCount)) {
    player.stack = between(rng, 1, 3 * bigBlind);
    spare -= player.stack;
  }
  shuffled.slice(shortCount).forEach((player, i, deep) => {
    player.stack = i === deep.length - 1 ? spare : Math.floor(spare / (deep.length - i));
    spare -= player.stack;
  });
}

function randomLobby(rng, count, useLadder) {
  const bigBlind = pick(rng, [1, 2, 5, 10, 25, 100]);
  const halfBlind = Math.max(1, Math.floor(bigBlind / 2));
  const smallBlind = rng() < 0.7 ? halfBlind : between(rng, 1, bigBlind);
  const depth = pick(rng, useLadder ? [10, 20, 50] : [1, 2, 3, 5, 10, 20, 50, 100]);
  const startingChips = bigBlind * depth + between(rng, 0, bigBlind - 1);

  let state = NAMES.slice(0, count).reduce(
    (current, name) => applyAction(current, { type: 'addPlayer', name }),
    createGame(),
  );
  state = play(
    state,
    { type: 'setOptions', startingChips, smallBlind, bigBlind },
    { type: 'setDealer', id: pick(rng, state.players).id },
  );

  const players = state.players.map((player) => ({ ...player }));
  if (useLadder) dealLadderStacks(rng, players, bigBlind);
  else scatterChips(rng, players);
  return { ...state, players };
}

// Ladder tables play a few hands of short stacks shoving into deep stacks that mostly call.
function randomSetup(rng) {
  const count = between(rng, MIN_PLAYERS, MAX_PLAYERS);
  const useLadder = count >= 4 && rng() < 0.6;
  return {
    lobby: randomLobby(rng, count, useLadder),
    maxHands: useLadder ? between(rng, 1, 3) : between(rng, 1, 30),
    style: useLadder
      ? { fold: 0.05, allIn: 0.02, raise: 0.05, shove: 0.85 }
      : {
          fold: pick(rng, [0.02, 0.15, 0.35]),
          allIn: pick(rng, [0.02, 0.1, 0.3]),
          raise: pick(rng, [0.05, 0.2, 0.5]),
          shove: 0,
        },
  };
}

function chooseBettingAction(rng, view, style) {
  const { legal, options } = view;
  const { stack } = playerById(view, view.actingId);
  const isShort = stack <= 3 * options.bigBlind;
  if (isShort && legal.allIn !== null && rng() < style.shove) return ALL_IN;
  const roll = rng();
  if (roll < style.fold) return FOLD;
  if (roll < style.fold + style.allIn && legal.allIn !== null) return ALL_IN;
  const range = legal.bet ?? legal.raise;
  if (roll < style.fold + style.allIn + style.raise && range) {
    const to = rng() < 0.5 ? range.min : between(rng, range.min, range.max);
    return { type: legal.bet ? 'bet' : 'raise', to };
  }
  return legal.check ? CHECK : CALL;
}

function randomAward(rng, view) {
  const picks = view.pots.map(({ eligibleIds }) => {
    if (eligibleIds.length === 1) return rng() < 0.5 ? [] : [...eligibleIds];
    const winners = eligibleIds.filter(() => rng() < 0.35);
    return winners.length > 0 ? winners.reverse() : [pick(rng, eligibleIds)];
  });
  return award(...picks);
}

function offeredActions(rng, view) {
  const { legal } = view;
  switch (view.phase) {
    case 'betting': {
      const actions = [FOLD];
      if (legal.check) actions.push(CHECK);
      if (legal.call > 0) actions.push(CALL);
      if (legal.allIn !== null) actions.push(ALL_IN);
      for (const type of ['bet', 'raise']) {
        if (legal[type]) {
          const { min, max } = legal[type];
          actions.push({ type, to: min }, { type, to: max }, { type, to: between(rng, min, max) });
        }
      }
      return actions;
    }
    case 'streetClosed':
      return [NEXT_STREET];
    case 'showdown':
      return [randomAward(rng, view)];
    case 'handComplete':
      return [NEXT_HAND];
    default:
      return [];
  }
}

function refusedBetSizes(view, type) {
  const range = view.legal[type];
  const me = playerById(view, view.actingId);
  if (!range) {
    const sizes = [1, view.options.bigBlind, view.currentBet + 1, me.bet + me.stack];
    return sizes.map((to) => ({ type, to }));
  }
  return [range.min - 1, range.max + 1, range.min + 0.5, String(range.min)].map((to) => ({
    type,
    to,
  }));
}

function refusedActions(view) {
  const refused = [
    START,
    { type: 'addPlayer', name: 'Late' },
    { type: 'removePlayer', id: view.players[0].id },
    { type: 'movePlayer', id: view.players[0].id, direction: 1 },
    { type: 'setDealer', id: view.players[0].id },
    { type: 'setOptions', startingChips: 10, smallBlind: 1, bigBlind: 2 },
    { type: 'nope' },
  ];
  if (view.phase !== 'streetClosed') refused.push(NEXT_STREET);
  if (view.phase !== 'handComplete') refused.push(NEXT_HAND);
  if (view.phase !== 'showdown') refused.push(award(...view.pots.map((pot) => pot.eligibleIds)));
  if (view.phase === 'betting') {
    const { legal } = view;
    if (!legal.check) refused.push(CHECK);
    if (legal.call === 0) refused.push(CALL);
    if (legal.allIn === null) refused.push(ALL_IN);
    refused.push(...refusedBetSizes(view, 'bet'), ...refusedBetSizes(view, 'raise'));
  } else {
    refused.push(FOLD, CHECK, CALL, ALL_IN, bet(view.options.bigBlind), raise(view.currentBet + 1));
  }
  if (view.phase === 'showdown') {
    const contested = view.pots.findIndex(({ eligibleIds }) => eligibleIds.length > 1);
    const outsider = view.players.find((player) => !isLive(player));
    if (contested >= 0) {
      const empty = view.pots.map(() => []);
      refused.push(award(...empty), { type: 'award' });
      if (outsider) {
        const picks = view.pots.map((pot) => [pot.eligibleIds[0]]);
        picks[contested] = [outsider.id];
        refused.push(award(...picks));
      }
    }
    refused.push(award(...view.pots.map((pot) => pot.eligibleIds), ['p1']));
    refused.push(award(...view.pots.map(({ eligibleIds: [id] }) => [id, id])));
  }
  return refused;
}

// Thousands of refusals run here, and building their stack traces would dominate the test.
function assertRefused(state, action) {
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  let refusal = null;
  try {
    applyAction(state, action);
  } catch (error) {
    refusal = error;
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
  assert.ok(refusal, `${JSON.stringify(action)} should be refused in ${state.phase}`);
  assert.ok(refusal instanceof GameError, String(refusal));
  assert.match(refusal.code, /^[a-z]+(-[a-z]+)*$/);
}

function checkNumbers(view) {
  const numbers = [view.currentBet, view.pot.total, view.pot.collected, view.handNumber];
  for (const player of view.players) {
    numbers.push(player.seat, player.stack, player.bet, player.committed, player.payout);
  }
  for (const pot of view.pots) numbers.push(pot.amount);
  for (const number of numbers) {
    assert.ok(Number.isSafeInteger(number) && number >= 0, `bad number ${number}`);
  }
}

function checkStatuses(view) {
  view.players.forEach((player, i) => {
    assert.equal(player.seat, i);
    if (player.status === 'allIn') assert.equal(player.stack, 0);
    if (player.status === 'active') assert.ok(player.stack > 0);
    if (player.status === 'out') assert.equal(player.stack, 0);
    assert.ok(player.bet <= player.committed);
  });
}

// The rule as written: levels from unfolded totals, folded chips into the layers they reach,
// chips over the top level into the top pot, and pots with the same eligible set merged.
function potsByTheBook(view) {
  const live = view.players.filter(isLive);
  const levels = [...new Set(live.map((player) => player.committed))].sort((a, b) => a - b);
  const pots = [];
  let floor = 0;
  levels.forEach((level, i) => {
    const isTop = i === levels.length - 1;
    const amount = sum(
      view.players.map(
        ({ committed }) =>
          Math.max(0, Math.min(committed, level) - floor) +
          (isTop ? Math.max(0, committed - level) : 0),
      ),
    );
    const eligibleIds = live.filter((player) => player.committed >= level).map(({ id }) => id);
    const last = pots.at(-1);
    if (last?.eligibleIds.join() === eligibleIds.join()) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligibleIds });
    floor = level;
  });
  return pots.map((pot, i) => ({ label: i === 0 ? 'Main pot' : `Side pot ${i}`, ...pot }));
}

function checkPots(view, seen) {
  const live = view.players.filter(isLive).map(({ id }) => id);
  assert.ok(view.pots.length > 0);
  assert.equal(sum(view.pots.map(({ amount }) => amount)), view.pot.total);
  assert.deepEqual(view.pots[0].eligibleIds, live);
  view.pots.forEach(({ label, amount, eligibleIds }, i) => {
    assert.equal(label, i === 0 ? 'Main pot' : `Side pot ${i}`);
    assert.ok(amount > 0);
    assert.ok(eligibleIds.length > 0);
    assert.ok(eligibleIds.every((id) => live.includes(id)));
    if (i > 0) {
      const wider = view.pots[i - 1].eligibleIds;
      assert.ok(eligibleIds.length < wider.length);
      assert.ok(eligibleIds.every((id) => wider.includes(id)));
    }
  });
  if (view.pots.length > 1) seen.sidePots += 1;
  if (view.pots.some((pot, i) => i > 0 && pot.eligibleIds.length === 1)) seen.decidedSidePots += 1;
}

// Once betting stops, no unfolded player can have chips that nobody matched.
function checkClosedPots(view) {
  assert.deepEqual(view.pots, potsByTheBook(view));
  const totals = view.players.map(({ committed }) => committed).sort((a, b) => b - a);
  assert.equal(totals[0], totals[1], 'uncalled chips were left in the pot');
  for (const player of view.players.filter(isLive)) {
    const mine = view.pots.filter(({ eligibleIds }) => eligibleIds.includes(player.id));
    const reachable = sum(mine.map(({ amount }) => amount));
    const matched = sum(view.players.map(({ committed }) => Math.min(committed, player.committed)));
    assert.equal(reachable, matched);
  }
}

function checkPhase(view, totalChips, seen) {
  const { phase } = view;
  const withChips = view.players.filter((player) => player.stack > 0);
  assert.equal(sum(view.players.map(({ stack }) => stack)) + view.pot.total, totalChips);
  assert.ok(view.pot.collected <= view.pot.total);
  assert.equal(view.pot.total - view.pot.collected, sum(view.players.map(({ bet: b }) => b)));
  if (phase !== 'betting') {
    assert.equal(view.actingId, null);
    assert.equal(view.legal, null);
  }
  if (phase !== 'streetClosed') assert.equal(view.nextStreet, null);

  if (phase === 'betting') {
    assert.notEqual(view.legal, null, 'betting phase with nothing legal');
    assert.equal(playerById(view, view.actingId).status, 'active');
    checkPots(view, seen);
  } else if (phase === 'streetClosed') {
    assert.equal(view.nextStreet, nextStreetAfter[view.street]);
    assert.ok(view.players.filter(isLive).length > 1);
    checkPots(view, seen);
    checkClosedPots(view);
  } else if (phase === 'showdown') {
    assert.equal(view.result, null);
    assert.equal(view.pot.total, view.pot.collected);
    assert.equal(view.currentBet, 0);
    checkPots(view, seen);
    checkClosedPots(view);
  } else {
    assert.deepEqual(view.pot, { total: 0, collected: 0 });
    assert.deepEqual(view.pots, []);
    assert.notEqual(view.result, null);
    assert.ok(view.players.every((player) => player.status !== 'allIn'));
    if (phase === 'gameOver') {
      assert.equal(withChips.length, 1);
      assert.equal(view.gameWinnerId, withChips[0].id);
    } else {
      assert.ok(withChips.length >= 2);
      assert.equal(view.gameWinnerId, null);
    }
  }
}

// The betting round as the rules describe it, tracked apart from the engine.
function startStreetModel(view) {
  return {
    key: `${view.handNumber}/${view.street}`,
    fullRaise: view.options.bigBlind,
    fullRaises: 0,
    acted: new Map(),
    lastActorId: view.street === 'preflop' ? view.bigBlindId : view.dealerId,
  };
}

// The street total an action takes its player to.
function wagerTo(view, action) {
  const me = playerById(view, view.actingId);
  if (action.type === 'check') return me.bet;
  if (action.type === 'call') return me.bet + view.legal.call;
  if (action.type === 'allIn') return me.bet + me.stack;
  return action.to;
}

function amountOwed(view, player) {
  const others = view.players.filter((other) => other.id !== player.id && isLive(other));
  const reach = Math.max(...others.map(({ bet: b, stack }) => b + stack));
  return Math.min(player.stack, Math.min(view.currentBet, reach) - player.bet);
}

function nextToAct(view, model) {
  const start = seatOf(view, model.lastActorId);
  const { length } = view.players;
  for (let offset = 1; offset <= length; offset += 1) {
    const player = view.players[(start + offset) % length];
    const someoneElse = view.players.some((p) => p.id !== player.id && p.status === 'active');
    const isFresh = !model.acted.has(player.id);
    if (player.status === 'active' && (amountOwed(view, player) > 0 || (isFresh && someoneElse))) {
      return player.id;
    }
  }
  return null;
}

function checkLegal(view, model, seen) {
  const { legal, currentBet, options } = view;
  const me = playerById(view, view.actingId);
  const owed = Math.max(0, amountOwed(view, me));
  const allInTo = me.bet + me.stack;
  const acted = model.acted.get(me.id);
  const reopened = !acted || currentBet - acted.level >= model.fullRaise;
  const answerable = view.players.some(
    (other) =>
      other.id !== me.id && other.status === 'active' && other.bet + other.stack > currentBet,
  );
  const canGoOver = reopened && answerable && allInTo > currentBet;
  const min = currentBet === 0 ? options.bigBlind : currentBet + model.fullRaise;
  const sizing = canGoOver && allInTo >= min ? { min, max: allInTo } : null;

  assert.equal(legal.fold, true);
  assert.equal(legal.call, owed);
  assert.equal(legal.check, owed === 0);
  assert.deepEqual(legal.bet, currentBet === 0 ? sizing : null);
  assert.deepEqual(legal.raise, currentBet > 0 ? sizing : null);
  assert.equal(legal.allIn, canGoOver || owed === me.stack ? allInTo : null);

  if (owed < Math.min(me.stack, currentBet - me.bet)) seen.cappedCalls += 1;
  if (!reopened && answerable && allInTo > currentBet) seen.notReopened += 1;
  if (canGoOver && acted?.fullRaises === model.fullRaises) seen.stackedReopen += 1;
  if (canGoOver && allInTo < min) seen.shortAllInOffered += 1;
}

function recordTurn(model, before, action, seen) {
  const me = playerById(before, before.actingId);
  model.lastActorId = me.id;
  if (action.type === 'fold') return;
  const to = wagerTo(before, action);
  const raisedBy = to - before.currentBet;
  if (raisedBy >= model.fullRaise) {
    model.fullRaise = raisedBy;
    model.fullRaises += 1;
  } else if (raisedBy > 0) {
    seen.shortAllIns += 1;
  }
  model.acted.set(me.id, {
    level: Math.max(before.currentBet, to),
    fullRaises: model.fullRaises,
  });
}

function checkChipMovement(before, action, after) {
  const me = playerById(before, before.actingId);
  const mine = playerById(after, me.id);
  if (action.type === 'fold') {
    assert.equal(mine.status, 'folded');
    assert.equal(mine.lastAction, 'fold');
    return;
  }
  if (after.phase !== 'betting') return;
  const to = wagerTo(before, action);
  assert.equal(mine.bet, to);
  assert.equal(mine.stack, me.stack - (to - me.bet));
  assert.equal(mine.committed, me.committed + (to - me.bet));
  assert.equal(mine.status, mine.stack === 0 ? 'allIn' : 'active');
  assert.equal(after.currentBet, Math.max(before.currentBet, to));
  if (mine.stack === 0) assert.equal(mine.lastAction, 'allIn');
}

function checkRefund(before, after, seen) {
  if (before.phase !== 'betting' || after.phase === 'betting') return;
  const refunded = after.players.find(
    (player) => player.committed < playerById(before, player.id).committed,
  );
  if (!refunded) return;
  seen.refunds += 1;
  assert.notEqual(refunded.status, 'allIn');
  assert.ok(isLive(refunded));
  if (playerById(before, refunded.id).status === 'allIn') seen.allInRefunds += 1;
}

function nextDealerAfter(previous, seats) {
  const start = seats.findIndex(({ id }) => id === previous.dealerId);
  const clockwise = seats.map((_, i) => seats[(start + 1 + i) % seats.length]);
  const withChips = clockwise.filter(({ stack }) => stack > 0);
  const adjusted = withChips.length === 2 && withChips[1].id === previous.bigBlindId;
  return withChips[adjusted ? 1 : 0].id;
}

function checkHandStart(view, seats, previous) {
  const { smallBlind, bigBlind } = view.options;
  const stackAt = (id) => seats.find((seat) => seat.id === id).stack;
  const dealerId = previous ? nextDealerAfter(previous, seats) : view.dealerId;
  assert.equal(view.dealerId, dealerId);
  if (previous) {
    assert.equal(previous.nextDealerId, dealerId);
    assert.notEqual(view.bigBlindId, previous.bigBlindId, 'big blind twice in a row');
  }

  const fromDealer = seatOf(view, dealerId);
  const seated = seats
    .map((_, i) => seats[(fromDealer + 1 + i) % seats.length])
    .filter(({ stack }) => stack > 0);
  const [small, big] = seated.length === 2 ? [seated[1], seated[0]] : seated;
  assert.equal(view.smallBlindId, small.id);
  assert.equal(view.bigBlindId, big.id);
  assert.equal(view.street, 'preflop');
  assert.equal(view.result, null);

  for (const player of view.players) {
    assert.equal(player.payout, 0);
    if (stackAt(player.id) === 0) assert.equal(player.status, 'out');
    if (player.id === small.id) assert.equal(player.lastAction, 'sb');
    else if (player.id === big.id) assert.equal(player.lastAction, 'bb');
    else assert.equal(player.lastAction, null);
  }
  if (view.phase === 'betting') {
    assert.equal(playerById(view, small.id).bet, Math.min(smallBlind, small.stack));
    assert.equal(playerById(view, big.id).bet, Math.min(bigBlind, big.stack));
    assert.equal(view.currentBet, bigBlind);
    assert.deepEqual(view.pot, {
      total: Math.min(smallBlind, small.stack) + Math.min(bigBlind, big.stack),
      collected: 0,
    });
  }
}

function checkAward(before, action, after, seen) {
  const { result } = after;
  assert.equal(result.foldOut, before.players.filter(isLive).length === 1);
  assert.equal(result.pots.length, before.pots.length);
  const paid = {};
  const start = seatOf(before, before.dealerId);
  const clockwise = before.players.map(
    (_, i) => before.players[(start + 1 + i) % before.players.length].id,
  );
  result.pots.forEach(({ label, amount, winnerIds, shares }, i) => {
    const pot = before.pots[i];
    assert.equal(label, pot.label);
    assert.equal(amount, pot.amount);
    assert.ok(winnerIds.every((id) => pot.eligibleIds.includes(id)));
    assert.equal(sum(Object.values(shares)), amount);
    assert.deepEqual(Object.keys(shares).sort(), [...winnerIds].sort());
    const ordered = clockwise.filter((id) => winnerIds.includes(id));
    const amounts = ordered.map((id) => shares[id]);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), 'odd chips went out of order');
    assert.ok(amounts[0] - amounts.at(-1) <= 1);
    if (ordered.length > 1) seen.splits += 1;
    if (amounts[0] !== amounts.at(-1)) seen.oddChips += 1;
    for (const id of winnerIds) paid[id] = (paid[id] ?? 0) + shares[id];
  });
  for (const player of after.players) {
    assert.equal(player.payout, paid[player.id] ?? 0);
    assert.equal(player.stack, playerById(before, player.id).stack + player.payout);
    if (player.stack === 0) {
      assert.equal(player.status, 'out');
      seen.busted += 1;
    }
  }
}

function deepCopyThroughJson(state, view) {
  const copy = JSON.parse(JSON.stringify(state));
  assert.deepEqual(copy, state);
  assert.deepEqual(toView(copy), view);
  return deepFreeze(copy);
}

function createCoverage() {
  return {
    hands: 0,
    headsUpHands: 0,
    fullRingHands: 0,
    sidePots: 0,
    decidedSidePots: 0,
    shortAllIns: 0,
    shortAllInOffered: 0,
    notReopened: 0,
    stackedReopen: 0,
    cappedCalls: 0,
    refunds: 0,
    allInRefunds: 0,
    foldOuts: 0,
    splits: 0,
    oddChips: 0,
    busted: 0,
    gameOvers: 0,
    tapThroughs: 0,
    turnlessHands: 0,
  };
}

function noteHand(view, seen) {
  const seated = view.players.filter((player) => player.status !== 'out').length;
  seen.hands += 1;
  if (seated === 2) seen.headsUpHands += 1;
  if (seated === 9) seen.fullRingHands += 1;
  if (view.phase !== 'betting') seen.turnlessHands += 1;
}

// Plays one game from a random lobby.
function simulateGame(rng, seen) {
  const { lobby: lobbyState, maxHands, style } = randomSetup(rng);
  deepFreeze(lobbyState);
  const lobbyView = toView(lobbyState);
  const totalChips = sum(lobbyView.players.map(({ stack }) => stack));
  assert.equal(totalChips, lobbyView.players.length * lobbyView.options.startingChips);

  for (const action of [FOLD, CHECK, CALL, ALL_IN, NEXT_STREET, NEXT_HAND, END_GAME, award()]) {
    assertRefused(lobbyState, action);
  }

  let state = deepFreeze(applyAction(lobbyState, START));
  checkHandStart(toView(state), lobbyView.players, null);
  noteHand(toView(state), seen);
  let model = startStreetModel(toView(state));

  for (let step = 0; step < MAX_GAME_STEPS; step += 1) {
    let view = toView(state);
    checkNumbers(view);
    checkStatuses(view);
    checkPhase(view, totalChips, seen);
    state = deepCopyThroughJson(state, view);
    view = toView(state);

    if (`${view.handNumber}/${view.street}` !== model.key) model = startStreetModel(view);
    if (view.phase === 'betting') {
      assert.equal(view.actingId, nextToAct(view, model));
      checkLegal(view, model, seen);
    } else if (view.phase === 'streetClosed' || view.phase === 'showdown') {
      assert.equal(nextToAct(view, model), null, 'betting closed with someone still to act');
    }

    const offered = offeredActions(rng, view);
    assert.ok(offered.length > 0 || view.phase === 'gameOver', `stuck in ${view.phase}`);
    for (const action of offered) {
      const next = toView(applyAction(state, action));
      checkNumbers(next);
      checkPhase(next, totalChips, seen);
    }
    for (const action of refusedActions(view)) assertRefused(state, action);
    const ended = toView(applyAction(state, END_GAME));
    assert.equal(ended.phase, 'lobby');
    assert.equal(sum(ended.players.map(({ stack }) => stack)), totalChips);

    if (view.phase === 'gameOver') {
      seen.gameOvers += 1;
      return;
    }
    if (view.phase === 'handComplete' && view.handNumber >= maxHands) return;

    const action = view.phase === 'betting' ? chooseBettingAction(rng, view, style) : offered[0];
    const nextState = applyAction(state, action);
    assert.deepEqual(applyAction(state, action), nextState, 'same action gave a different result');
    const after = toView(nextState);

    if (view.phase === 'betting') {
      checkChipMovement(view, action, after);
      recordTurn(model, view, action, seen);
      checkRefund(view, after, seen);
      if (after.phase === 'showdown' && after.pots.length === 1) {
        if (after.pots[0].eligibleIds.length === 1) seen.foldOuts += 1;
      }
    }
    if (view.phase === 'streetClosed') {
      if (after.phase === 'streetClosed') seen.tapThroughs += 1;
      for (const player of after.players.filter(({ status }) => status === 'active')) {
        assert.equal(player.lastAction, null);
      }
    }
    if (view.phase === 'showdown') checkAward(view, action, after, seen);
    if (view.phase === 'handComplete') {
      checkHandStart(after, view.players, view);
      noteHand(after, seen);
    }
    state = deepFreeze(nextState);
  }
  assert.fail('the game never finished');
}

test(`${SIMULATED_HANDS} random hands keep every rule`, () => {
  const rng = mulberry32(20261104);
  const seen = createCoverage();
  while (seen.hands < SIMULATED_HANDS) simulateGame(rng, seen);

  // A simulation that never reached the hard cases would prove nothing about them.
  for (const [name, count] of Object.entries(seen)) {
    assert.ok(count >= 50, `only ${count} of ${name}`);
  }
});

test('the simulation is repeatable from its seed', () => {
  const run = () => {
    const seen = createCoverage();
    const rng = mulberry32(7);
    while (seen.hands < 200) simulateGame(rng, seen);
    return seen;
  };
  assert.deepEqual(run(), run());
});
