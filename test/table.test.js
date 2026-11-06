// Changes between hands: rebuys, chip corrections, seats and blinds. As in the rules tests, every
// hand here was worked out on paper first, so the numbers are the expected answer. Seats are Ann,
// Ben, Cal... with Ann dealing first and blinds of 5 and 10 unless a test says otherwise.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_PLAYERS, applyAction, createGame, describeAction, toView } from '../game/engine.js';
import { createSession } from '../game/session.js';

const [A, B, C, D] = ['p1', 'p2', 'p3', 'p4'];
const NAMES = ['Ann', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida', 'Jon'];

const FOLD = { type: 'fold' };
const CALL = { type: 'call' };
const ALL_IN = { type: 'allIn' };
const DEAL = { type: 'nextStreet' };
const NEXT_HAND = { type: 'nextHand' };
const END_GAME = { type: 'endGame' };
const addChips = (id, amount) => ({ type: 'addChips', id, amount });
const setStack = (id, stack) => ({ type: 'setStack', id, stack });
const seat = (name) => ({ type: 'seatPlayer', name });
const unseat = (id) => ({ type: 'unseatPlayer', id });
const moveSeat = (id, direction) => ({ type: 'moveSeat', id, direction });
const setBlinds = (smallBlind, bigBlind) => ({ type: 'setBlinds', smallBlind, bigBlind });
const award = (...pots) => ({ type: 'award', pots });

const play = (state, ...actions) => actions.reduce(applyAction, state);
const stacks = (state) => toView(state).players.map((player) => player.stack);
const statuses = (state) => toView(state).players.map((player) => player.status);
const namesOf = (state) => toView(state).players.map((player) => player.name);

function throwsCode(run, code) {
  assert.throws(run, (error) => error.code === code, `expected ${code}`);
}

function lobby(count, startingChips = 1000) {
  const options = { type: 'setOptions', startingChips, smallBlind: 5, bigBlind: 10 };
  const seated = NAMES.slice(0, count).map((name) => ({ type: 'addPlayer', name }));
  return play(createGame(), ...seated, options);
}

const started = (count, startingChips) => play(lobby(count, startingChips), { type: 'startGame' });

// Ann and Ben fold to Cal's big blind. Ben's 5 is the whole pot once Cal's extra 5 comes back:
// Ann 1000, Ben 995, Cal 1005.
const afterFolds = () => play(started(3), FOLD, FOLD, award());

// At 100 chips Ann goes all in, Ben folds his 5 and Cal calls. Ann wins 100 + 100 + 5:
// Ann 205, Ben 95, Cal 0.
const afterBust = () =>
  play(started(3, 100), ALL_IN, FOLD, CALL, DEAL, DEAL, DEAL, award([A]));

// Heads up at 100 chips, Ann takes everything: Ann 200, Ben 0.
const afterHeadsUpWin = () => play(started(2, 100), ALL_IN, CALL, DEAL, DEAL, DEAL, award([A]));

describe('rebuys', () => {
  test('a busted player rebuys and is dealt the next hand', () => {
    const state = afterBust();
    assert.deepEqual(stacks(state), [205, 95, 0]);
    assert.equal(statuses(state)[2], 'out');

    const rebought = play(state, addChips(C, 100));
    assert.deepEqual(stacks(rebought), [205, 95, 100]);
    assert.deepEqual(statuses(rebought), ['active', 'active', 'active']);
    assert.equal(rebought.phase, 'betweenHands');
    assert.equal(rebought.tableChips, 400);

    // The chip moves to Ben, so Cal posts 5 and Ann posts 10, and Ben acts first.
    const next = play(rebought, NEXT_HAND);
    assert.deepEqual(stacks(next), [195, 95, 95]);
    assert.equal(next.dealerId, B);
    assert.equal(next.actingId, B);
  });

  test('a rebuy at game over brings the game back', () => {
    const state = afterHeadsUpWin();
    assert.equal(state.phase, 'gameOver');
    assert.equal(state.gameWinnerId, A);

    const rebought = play(state, addChips(B, 100));
    assert.equal(rebought.phase, 'betweenHands');
    assert.equal(rebought.gameWinnerId, null);
    assert.equal(rebought.tableChips, 300);
    assert.equal(toView(rebought).nextDealerId, B);

    // Heads up the dealer posts the small blind, so Ben posts 5 and Ann posts 10.
    assert.deepEqual(stacks(play(rebought, NEXT_HAND)), [190, 95]);
  });

  test('a player with chips can add more', () => {
    const state = play(afterFolds(), addChips(A, 500));
    assert.deepEqual(stacks(state), [1500, 995, 1005]);
    assert.equal(state.tableChips, 3500);
  });

  test('only whole, positive amounts and real players', () => {
    const state = afterFolds();
    for (const amount of [0, -5, 1.5, '100', null, undefined, Infinity, NaN]) {
      throwsCode(() => play(state, addChips(A, amount)), 'bad-amount');
    }
    throwsCode(() => play(state, addChips('p99', 100)), 'unknown-player');
  });

  test('a table too big to count exactly is refused', () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PLAYERS);
    let state = afterFolds();
    for (let i = 0; i < MAX_PLAYERS - 1; i += 1) state = play(state, addChips(A, huge));
    throwsCode(() => play(state, addChips(B, huge)), 'too-many-chips');
  });

  test('the undo label says what happened', () => {
    assert.equal(describeAction(afterBust(), addChips(C, 100)), 'Cal rebought 100');
    assert.equal(describeAction(afterFolds(), addChips(A, 500)), 'Ann added 500');
  });
});

describe('chip corrections', () => {
  test('a stack can go up or down, and the table total follows', () => {
    const state = play(afterFolds(), setStack(C, 1100), setStack(B, 900));
    assert.deepEqual(stacks(state), [1000, 900, 1100]);
    assert.equal(state.tableChips, 3000);
    assert.equal(state.phase, 'betweenHands');
  });

  test('a corrected stack is what the next hand plays with', () => {
    // The chip moves to Ben. Ben is corrected to 3, then Cal posts 5 and Ann posts 10.
    const state = play(afterFolds(), setStack(B, 3), NEXT_HAND);
    assert.deepEqual(stacks(state), [990, 3, 1000]);
  });

  test('a stack set to zero is out', () => {
    const state = play(afterFolds(), setStack(B, 0));
    assert.deepEqual(statuses(state), ['active', 'out', 'active']);
    assert.equal(state.phase, 'betweenHands');
  });

  test('setting the last opponent to zero ends the game', () => {
    const state = play(afterFolds(), setStack(B, 0), setStack(A, 0));
    assert.equal(state.phase, 'gameOver');
    assert.equal(state.gameWinnerId, C);
  });

  test('the last chips on the table can not be taken away', () => {
    throwsCode(() => play(afterHeadsUpWin(), setStack(A, 0)), 'no-chips');
  });

  test('nothing changes, nothing happens', () => {
    throwsCode(() => play(afterFolds(), setStack(A, 1000)), 'no-change');
  });

  test('only whole, non-negative stacks and real players', () => {
    const state = afterFolds();
    for (const stack of [-1, 1.5, '100', null, undefined, Infinity, NaN]) {
      throwsCode(() => play(state, setStack(A, stack)), 'bad-amount');
    }
    throwsCode(() => play(state, setStack('p99', 100)), 'unknown-player');
  });

  test('the undo label says what happened', () => {
    assert.equal(describeAction(afterFolds(), setStack(B, 1500)), 'Ben set to 1,500');
  });
});

describe('seating and removing players', () => {
  test('a new player sits last with the starting chips and plays the next hand', () => {
    const state = play(afterFolds(), seat('Dee'));
    assert.deepEqual(namesOf(state), ['Ann', 'Ben', 'Cal', 'Dee']);
    assert.deepEqual(stacks(state), [1000, 995, 1005, 1000]);
    assert.equal(state.tableChips, 4000);

    // The chip moves to Ben, Cal posts 5, Dee posts 10, and Ann is first to act.
    const next = play(state, NEXT_HAND);
    assert.deepEqual(stacks(next), [1000, 995, 1000, 990]);
    assert.equal(next.actingId, A);
  });

  test('a seat at game over brings the game back', () => {
    const state = play(afterHeadsUpWin(), seat('Cal'));
    assert.equal(state.phase, 'betweenHands');
    assert.equal(state.gameWinnerId, null);
  });

  test('names follow the same rules as the lobby', () => {
    const state = afterFolds();
    throwsCode(() => play(state, seat('ann')), 'duplicate-name');
    throwsCode(() => play(state, seat('   ')), 'bad-name');
    const full = NAMES.slice(3, 9).reduce((table, name) => play(table, seat(name)), state);
    assert.equal(full.players.length, MAX_PLAYERS);
    throwsCode(() => play(full, seat('Jon')), 'table-full');
  });

  test('a player who leaves takes their chips with them', () => {
    const state = play(afterFolds(), unseat(B));
    assert.deepEqual(namesOf(state), ['Ann', 'Cal']);
    assert.equal(state.tableChips, 2005);
    assert.equal(state.dealerId, A);
  });

  test('a name is free again once its player has left', () => {
    const state = play(afterFolds(), unseat(B), seat('Ben'));
    assert.deepEqual(namesOf(state), ['Ann', 'Cal', 'Ben']);
    assert.equal(state.players[2].id, D, 'a returning player is a new player');
  });

  test('when the dealer leaves, the next hand goes to the seat after them', () => {
    const state = play(started(4), FOLD, FOLD, FOLD, award(), unseat(A));
    assert.deepEqual(namesOf(state), ['Ben', 'Cal', 'Dee']);
    assert.equal(toView(state).dealerId, D, 'the chip goes back a seat');
    assert.equal(toView(state).nextDealerId, B);

    const next = play(state, NEXT_HAND);
    assert.equal(next.dealerId, B);
    assert.equal(next.smallBlindId, C);
    assert.equal(next.bigBlindId, D);
  });

  test('going heads up never makes the big blind post it twice', () => {
    // Cal was the big blind. Ann leaves, so the chip goes to Cal and Ben posts the big blind:
    // Cal 1005 - 5, Ben 995 - 10.
    const state = play(afterFolds(), unseat(A), NEXT_HAND);
    assert.equal(state.dealerId, C);
    assert.equal(state.bigBlindId, B);
    assert.deepEqual(stacks(state), [985, 1000]);
  });

  test('a winner who leaves takes the result with them', () => {
    const view = toView(play(afterFolds(), unseat(C)));
    assert.equal(view.result, null);
    assert.ok(view.players.every(({ payout }) => payout === 0));
    assert.equal(view.phase, 'betweenHands');
  });

  test('the last opponent leaving ends the game', () => {
    const state = play(afterFolds(), unseat(A), unseat(B));
    assert.equal(state.phase, 'gameOver');
    assert.equal(state.gameWinnerId, C);
    assert.equal(toView(state).result, null);
  });

  test('a busted player can be cleared away at game over', () => {
    const state = play(afterHeadsUpWin(), unseat(B));
    assert.equal(state.phase, 'gameOver');
    assert.deepEqual(namesOf(state), ['Ann']);
  });

  test('the only player with chips can not leave', () => {
    throwsCode(() => play(afterHeadsUpWin(), unseat(A)), 'no-chips');
    throwsCode(() => play(afterFolds(), unseat('p99')), 'unknown-player');
  });

  test('seats can be swapped, and the chip stays with its player', () => {
    const state = play(afterFolds(), moveSeat(C, -1));
    assert.deepEqual(namesOf(state), ['Ann', 'Cal', 'Ben']);
    assert.equal(state.dealerId, A);
    assert.equal(toView(state).nextDealerId, C, 'Cal now sits after Ann');
    throwsCode(() => play(afterFolds(), moveSeat(A, -1)), 'cannot-move');
    throwsCode(() => play(afterFolds(), moveSeat(A, 2)), 'bad-direction');
  });
});

describe('raising the blinds', () => {
  test('the next hand posts them, and sizing follows', () => {
    const state = play(afterFolds(), setBlinds(25, 50), NEXT_HAND);
    // The chip moves to Ben, Cal posts 25, Ann posts 50.
    assert.deepEqual(stacks(state), [950, 995, 980]);
    assert.equal(toView(state).legal.raise.min, 100);
    assert.equal(toView(state).options.bigBlind, 50);
  });

  test('a bet after the flop starts from the new big blind', () => {
    // Ben calls 50, Cal adds 25, Ann checks.
    const state = play(
      afterFolds(),
      setBlinds(25, 50),
      NEXT_HAND,
      CALL,
      CALL,
      { type: 'check' },
      DEAL,
    );
    assert.equal(toView(state).legal.bet.min, 50);
  });

  test('the wall and phone see them straight away', () => {
    const view = toView(play(afterFolds(), setBlinds(25, 50)));
    assert.deepEqual(view.options, { startingChips: 1000, smallBlind: 25, bigBlind: 50 });
    assert.equal(view.phase, 'betweenHands');
  });

  test('a new game goes back to the lobby blinds, however often they were raised', () => {
    const state = play(afterFolds(), setBlinds(25, 50), setBlinds(100, 200), END_GAME);
    assert.deepEqual(state.options, { startingChips: 1000, smallBlind: 5, bigBlind: 10 });
    assert.equal(state.lobbyBlinds, null);
  });

  test('blinds can pass the starting chips without touching a new game', () => {
    const raised = play(afterFolds(), setBlinds(1000, 2000));
    assert.deepEqual(stacks(play(raised, END_GAME)), [1000, 1000, 1000]);
    assert.equal(play(raised, END_GAME).options.bigBlind, 10);
  });

  test('the blinds have to make sense', () => {
    const state = afterFolds();
    for (const [small, big] of [[0, 10], [5, 0], [-5, 10], [2.5, 5], ['5', 10], [null, 10]]) {
      throwsCode(() => play(state, setBlinds(small, big)), 'bad-options');
    }
    throwsCode(() => play(state, setBlinds(20, 10)), 'bad-options');
    assert.deepEqual(toView(play(state, setBlinds(10, 10))).options.bigBlind, 10);
  });

  test('the undo label says what happened', () => {
    const label = describeAction(afterFolds(), setBlinds(1000, 2000));
    assert.equal(label, 'Blinds set to 1,000 / 2,000');
  });
});

describe('when the table can change', () => {
  const changes = [
    addChips(A, 100),
    setStack(A, 500),
    seat('Dee'),
    unseat(A),
    moveSeat(B, 1),
    setBlinds(25, 50),
  ];

  test('never in the lobby or during a hand', () => {
    const betting = started(3);
    const streetClosed = play(started(3), CALL, CALL, { type: 'check' });
    const showdown = play(started(3), FOLD, FOLD);
    assert.equal(streetClosed.phase, 'streetClosed');
    assert.equal(showdown.phase, 'showdown');
    for (const state of [lobby(3), betting, streetClosed, showdown]) {
      for (const change of changes) throwsCode(() => play(state, change), 'wrong-phase');
    }
  });

  test('after a hand, between hands and at game over', () => {
    for (const change of changes) {
      assert.equal(play(afterFolds(), change).phase, 'betweenHands');
      assert.equal(play(afterFolds(), setBlinds(5, 10), change).phase, 'betweenHands');
    }
    const cameBack = play(afterHeadsUpWin(), addChips(B, 100), setBlinds(25, 50));
    assert.equal(cameBack.phase, 'betweenHands');
  });

  test('every change clears the last hand off the table', () => {
    for (const change of changes) {
      const view = toView(play(afterFolds(), change));
      assert.equal(view.result, null);
      assert.ok(view.players.every(({ payout, status }) => payout === 0 && status === 'active'));
      assert.equal(view.smallBlindId, null);
      assert.equal(view.bigBlindId, null);
    }
  });

  test('a hand can follow a change, but not a game over', () => {
    assert.equal(play(afterFolds(), setBlinds(25, 50), NEXT_HAND).phase, 'betting');
    throwsCode(() => play(afterHeadsUpWin(), NEXT_HAND), 'wrong-phase');
    throwsCode(() => play(afterHeadsUpWin(), unseat(B), NEXT_HAND), 'wrong-phase');
  });

  test('End game resets everyone who is left to the starting chips', () => {
    const state = play(afterFolds(), addChips(A, 500), seat('Dee'), unseat(B), END_GAME);
    assert.equal(state.phase, 'lobby');
    assert.deepEqual(namesOf(state), ['Ann', 'Cal', 'Dee']);
    assert.deepEqual(stacks(state), [1000, 1000, 1000]);
    assert.equal(state.tableChips, null);
  });
});

describe('undo and saves', () => {
  function sessionAfterFolds() {
    const session = createSession();
    const script = [
      ...NAMES.slice(0, 3).map((name) => ({ type: 'addPlayer', name })),
      { type: 'startGame' },
      FOLD,
      FOLD,
      award(),
    ];
    for (const action of script) session.dispatch(action, session.version);
    return session;
  }

  test('undo walks back through table changes and brings the result back', () => {
    const session = sessionAfterFolds();
    const before = session.view;
    session.dispatch(addChips(A, 500), session.version);
    session.dispatch(setBlinds(25, 50), session.version);
    assert.equal(session.undoLabel, 'Blinds set to 25 / 50');

    session.undo(session.version);
    assert.equal(session.undoLabel, 'Ann added 500');
    assert.equal(session.view.options.bigBlind, 10);
    session.undo(session.version);
    assert.deepEqual(session.view, before);
    assert.equal(session.view.phase, 'handComplete');
    assert.equal(session.view.result.pots[0].amount, 10);
  });

  test('undo puts a player back in their seat with their chips', () => {
    const session = sessionAfterFolds();
    const before = session.view;
    session.dispatch(unseat(A), session.version);
    assert.equal(session.undoLabel, 'Removed Ann');
    session.undo(session.version);
    assert.deepEqual(session.view, before);
  });

  test('table changes keep the undo history, unlike lobby edits', () => {
    const session = sessionAfterFolds();
    const label = session.undoLabel;
    session.dispatch(seat('Dee'), session.version);
    session.undo(session.version);
    assert.equal(session.undoLabel, label);
  });

  test('a game with table changes survives a restart', () => {
    const session = sessionAfterFolds();
    session.dispatch(addChips(A, 500), session.version);
    session.dispatch(seat('Dee'), session.version);
    session.dispatch(unseat(B), session.version);
    session.dispatch(setBlinds(25, 50), session.version);
    const restored = createSession(JSON.parse(JSON.stringify(session.serialize())));
    assert.equal(restored.damage, null);
    assert.deepEqual(restored.view, session.view);
    assert.equal(restored.undoLabel, session.undoLabel);
  });

  test('a stack damaged after a rebuy still fails the chip count', () => {
    const session = sessionAfterFolds();
    session.dispatch(addChips(A, 500), session.version);
    const saved = JSON.parse(JSON.stringify(session.serialize()));
    saved.state.players[0].stack += 1;
    assert.equal(createSession(saved).damage, 'game');
  });

  test('a save from before table changes existed still loads and takes them', () => {
    const session = sessionAfterFolds();
    const saved = JSON.parse(JSON.stringify(session.serialize()));
    delete saved.state.tableChips;
    delete saved.state.lobbyBlinds;
    for (const entry of saved.history) {
      delete entry.state.tableChips;
      delete entry.state.lobbyBlinds;
    }
    const restored = createSession(saved);
    assert.equal(restored.damage, null);
    restored.dispatch(setBlinds(25, 50), restored.version);
    restored.dispatch(addChips(A, 500), restored.version);
    restored.dispatch(END_GAME, restored.version);
    assert.equal(restored.view.options.bigBlind, 10);
  });
});

/* ---------- Random play ---------- */

function mulberry32(seed) {
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, items) => items[Math.floor(rng() * items.length)];
const someOf = (rng, ids) => {
  const chosen = ids.filter(() => rng() < 0.5);
  return chosen.length > 0 ? chosen : [pick(rng, ids)];
};

function randomBet(rng, view) {
  const { legal } = view;
  const options = [FOLD];
  if (legal.check) options.push({ type: 'check' });
  if (legal.call > 0) options.push(CALL, CALL);
  if (legal.allIn !== null) options.push(ALL_IN);
  if (legal.bet) options.push({ type: 'bet', to: legal.bet.min });
  if (legal.raise) options.push({ type: 'raise', to: legal.raise.min });
  return pick(rng, options);
}

function randomChange(rng, view, nextName) {
  const { id, stack } = pick(rng, view.players);
  const direction = rng() < 0.5 ? -1 : 1;
  const amount = 1 + Math.floor(rng() * 3000);
  return pick(rng, [
    addChips(id, amount),
    setStack(id, stack === 0 ? amount : Math.floor(rng() * 3000)),
    seat(nextName()),
    unseat(id),
    moveSeat(id, direction),
    setBlinds(1 + Math.floor(rng() * 50), 50 + Math.floor(rng() * 200)),
  ]);
}

function randomStep(rng, view, nextName) {
  switch (view.phase) {
    case 'lobby':
      if (view.players.length < 2) return { type: 'addPlayer', name: nextName() };
      return { type: 'startGame' };
    case 'betting':
      return randomBet(rng, view);
    case 'streetClosed':
      return DEAL;
    case 'showdown':
      return award(...view.pots.map((pot) => someOf(rng, pot.eligibleIds)));
    case 'gameOver':
      return rng() < 0.75 ? randomChange(rng, view, nextName) : END_GAME;
    default:
      return rng() < 0.5 ? randomChange(rng, view, nextName) : NEXT_HAND;
  }
}

// What a change does to the chips on the table, worked out here apart from the engine.
function chipsAfter(chips, action, view) {
  const player = view.players.find(({ id }) => id === action.id);
  switch (action.type) {
    case 'addChips':
      return chips + action.amount;
    case 'setStack':
      return chips + action.stack - player.stack;
    case 'addPlayer':
    case 'seatPlayer':
      return chips + view.options.startingChips;
    case 'unseatPlayer':
      return chips - player.stack;
    case 'endGame':
      return view.players.length * view.options.startingChips;
    default:
      return chips;
  }
}

function checkTable(view, chips) {
  const onTable = view.players.reduce((total, { stack }) => total + stack, view.pot.total);
  assert.equal(onTable, chips, `chips lost in ${view.phase}`);
  const ids = view.players.map(({ id }) => id);
  assert.ok(ids.includes(view.dealerId), 'the dealer chip is on someone at the table');
  const withChips = view.players.filter(({ stack }) => stack > 0);
  if (view.phase === 'gameOver') {
    assert.equal(withChips.length, 1);
    assert.equal(view.gameWinnerId, withChips[0].id);
  }
  if (view.phase === 'handComplete' || view.phase === 'betweenHands') {
    assert.ok(withChips.length >= 2);
    assert.ok(withChips.some(({ id }) => id === view.nextDealerId), 'the next dealer has chips');
  }
  if (view.phase === 'betweenHands') {
    assert.equal(view.result, null);
    assert.ok(view.players.every(({ status }) => status === 'active' || status === 'out'));
  }
  if (view.result) {
    for (const { winnerIds } of view.result.pots) {
      assert.ok(winnerIds.every((id) => ids.includes(id)), 'every winner shown is at the table');
    }
  }
}

test('random games with table changes never lose track of a chip or a dealer', () => {
  const rng = mulberry32(2026);
  let names = 0;
  const nextName = () => {
    names += 1;
    return `P${names}`;
  };
  let changes = 0;
  let rebuysAtGameOver = 0;

  for (let game = 0; game < 150; game += 1) {
    const session = createSession();
    const count = 2 + Math.floor(rng() * 8);
    for (let i = 0; i < count; i += 1) {
      session.dispatch({ type: 'addPlayer', name: nextName() }, session.version);
    }
    let chips = count * session.view.options.startingChips;
    const undoStack = [];

    for (let turn = 0; turn < 400; turn += 1) {
      const view = session.view;
      if (undoStack.length > 0 && rng() < 0.08) {
        session.undo(session.version);
        chips = undoStack.pop();
      } else {
        const action = randomStep(rng, view, nextName);
        try {
          session.dispatch(action, session.version);
          undoStack.push(chips);
          if (undoStack.length > 300) undoStack.shift();
          // A lobby edit clears the history in the session, too.
          if (action.type === 'addPlayer') undoStack.length = 0;
          chips = chipsAfter(chips, action, view);
          if (action.id !== undefined || action.type === 'setBlinds') changes += 1;
          if (view.phase === 'gameOver' && session.view.phase === 'betweenHands') {
            rebuysAtGameOver += 1;
          }
        } catch (error) {
          // Only the refusals a dealer could really run into.
          const refused = ['no-chips', 'no-change', 'table-full', 'cannot-move', 'bad-options'];
          assert.ok(refused.includes(error.code), `${error.code} for ${action.type}`);
        }
      }
      checkTable(session.view, chips);
    }
    const restored = createSession(JSON.parse(JSON.stringify(session.serialize())));
    assert.equal(restored.damage, null);
    assert.deepEqual(restored.view, session.view);
  }
  assert.ok(changes > 1000, `only ${changes} changes ran`);
  assert.ok(rebuysAtGameOver > 10, `only ${rebuysAtGameOver} games came back`);
});
