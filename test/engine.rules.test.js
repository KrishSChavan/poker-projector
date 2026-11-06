// An adversarial check of the betting rules. Every hand here was worked out on paper from the
// spec and from standard no-limit rules before it was ever run, so the numbers are the expected
// answer, not a copy of what the engine printed. Each test says how its numbers were reached. The
// TDA block goes further and uses published rulings, with the published numbers.
//
// Seats are A, B, C... in play order. Blinds are 5 and 10 unless a test says otherwise.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GameError,
  MAX_PLAYERS,
  MIN_PLAYERS,
  applyAction,
  createGame,
  describeAction,
  toView,
} from '../game/engine.js';
import { createSession } from '../game/session.js';

const [A, B, C, D, E, F] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const NAMES = ['Ann', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida'];

const fold = { type: 'fold' };
const check = { type: 'check' };
const call = { type: 'call' };
const allIn = { type: 'allIn' };
const deal = { type: 'nextStreet' };
const nextHand = { type: 'nextHand' };
const endGame = { type: 'endGame' };
const startGame = { type: 'startGame' };
const bet = (to) => ({ type: 'bet', to });
const raise = (to) => ({ type: 'raise', to });
const award = (...pots) => ({ type: 'award', pots });

const sum = (values) => values.reduce((total, value) => total + value, 0);
const seats = (state, field) => toView(state).players.map((player) => player[field]);
const stacks = (state) => seats(state, 'stack');
const bets = (state) => seats(state, 'bet');
const committed = (state) => seats(state, 'committed');
const statuses = (state) => seats(state, 'status');
const payouts = (state) => seats(state, 'payout');
const lastActions = (state) => seats(state, 'lastAction');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function checkLegal({ legal, currentBet }, acting) {
  const reach = acting.bet + acting.stack;
  assert.equal(legal.fold, true);
  assert.equal(legal.check, legal.call === 0, 'check is legal exactly when nothing is owed');
  assert.ok(Number.isInteger(legal.call) && legal.call >= 0 && legal.call <= acting.stack);
  assert.ok(legal.bet === null || legal.raise === null, 'never both bet and raise');
  if (legal.bet) assert.equal(currentBet, 0, 'bet needs no bet on the street');
  if (legal.raise) assert.ok(currentBet > 0, 'raise needs a bet on the street');
  for (const range of [legal.bet, legal.raise]) {
    if (!range) continue;
    assert.ok(range.min <= range.max, 'the range is not empty');
    assert.equal(range.max, reach, 'the top of the range is the whole stack');
    assert.equal(legal.allIn, reach, 'a range always comes with all in');
  }
  if (legal.allIn !== null) assert.equal(legal.allIn, reach);
}

function checkInvariants(state) {
  const view = toView(state);
  const running = ['betting', 'streetClosed', 'showdown'].includes(view.phase);
  for (const player of view.players) {
    for (const field of ['stack', 'bet', 'committed', 'payout']) {
      const value = player[field];
      assert.ok(Number.isInteger(value) && value >= 0, `${player.name} ${field} is ${value}`);
    }
    if (player.status === 'allIn') assert.equal(player.stack, 0, `${player.name} has chips`);
    if (player.status === 'out') assert.equal(player.stack, 0, `${player.name} out with chips`);
    if (running && player.status === 'active') {
      assert.ok(player.stack > 0, `${player.name} is active with no chips`);
    }
  }
  assert.equal(view.actingId !== null, view.phase === 'betting', 'actingId matches the phase');
  assert.equal(view.legal !== null, view.phase === 'betting', 'legal matches the phase');
  assert.equal(view.nextStreet !== null, view.phase === 'streetClosed', 'nextStreet matches');
  if (view.actingId !== null) {
    const acting = view.players.find((player) => player.id === view.actingId);
    assert.equal(acting.status, 'active', `${acting.name} cannot act`);
    checkLegal(view, acting);
  }
  if (running) {
    assert.equal(sum(view.pots.map((pot) => pot.amount)), view.pot.total, 'pots add up to the pot');
    assert.equal(sum(seats(state, 'committed')), view.pot.total, 'committed adds up to the pot');
    assert.equal(sum(seats(state, 'bet')), view.pot.total - view.pot.collected);
    for (const pot of view.pots) {
      assert.ok(pot.amount > 0 && pot.eligibleIds.length > 0, `${pot.label} is empty`);
      for (const id of pot.eligibleIds) {
        const status = view.players.find((player) => player.id === id).status;
        assert.ok(status === 'active' || status === 'allIn', `${id} is ${status} in ${pot.label}`);
      }
    }
  } else {
    assert.deepEqual(view.pots, []);
  }
}

const chipsInPlay = (state) => {
  const view = toView(state);
  return sum(view.players.map((player) => player.stack)) + view.pot.total;
};

// Applies actions with the checks that belong on every step: the engine must never touch its
// input, the result must survive JSON, and no chip may appear or vanish.
function play(state, ...actions) {
  return actions.reduce((current, action) => {
    const before = chipsInPlay(current);
    const next = applyAction(deepFreeze(current), action);
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next, 'state must survive JSON');
    checkInvariants(next);
    if (action.type !== 'endGame') assert.equal(chipsInPlay(next), before, 'chips are conserved');
    return next;
  }, state);
}

// Unequal stacks stand in for hands already played, so a test can start on the exact hand it wants.
function table(startingStacks, { dealer = 0, smallBlind = 5, bigBlind = 10 } = {}) {
  let state = createGame();
  const startingChips = Math.max(...startingStacks, bigBlind);
  state = applyAction(state, { type: 'setOptions', startingChips, smallBlind, bigBlind });
  for (let seat = 0; seat < startingStacks.length; seat += 1) {
    state = applyAction(state, { type: 'addPlayer', name: NAMES[seat] });
  }
  state = applyAction(state, { type: 'setDealer', id: `p${dealer + 1}` });
  state = {
    ...state,
    players: state.players.map((player, seat) => ({ ...player, stack: startingStacks[seat] })),
  };
  return play(state, startGame);
}

function checkDown(state) {
  let current = state;
  while (current.phase !== 'showdown') {
    current = play(current, current.phase === 'betting' ? check : deal);
  }
  return current;
}

function assertTurn(state, id) {
  const view = toView(state);
  assert.equal(view.phase, 'betting');
  assert.equal(view.actingId, id);
}

// Lists only what differs from "fold or nothing", so a stray legal move fails the test.
function assertLegal(state, expected) {
  const legal = { fold: true, check: false, call: 0, bet: null, raise: null, allIn: null };
  assert.deepEqual(toView(state).legal, { ...legal, ...expected });
}

function assertClosed(state, nextStreet) {
  const view = toView(state);
  assert.equal(view.phase, 'streetClosed');
  assert.equal(view.nextStreet, nextStreet);
  assert.equal(view.actingId, null);
  assert.equal(view.legal, null);
}

function assertShowdown(state) {
  const view = toView(state);
  assert.equal(view.phase, 'showdown');
  assert.equal(view.nextStreet, null);
  assert.equal(view.actingId, null);
  assert.equal(view.legal, null);
  assert.equal(view.result, null);
  assert.ok(view.players.every(({ bet: amount }) => amount === 0), 'street bets are collected');
  assert.equal(view.pot.collected, view.pot.total);
}

// Each expected pot is [amount, eligible ids]. Labels follow from the position.
function assertPots(state, expected) {
  const actual = toView(state).pots.map(({ label, amount, eligibleIds }) => ({
    label,
    amount,
    eligibleIds: [...eligibleIds].sort(),
  }));
  const wanted = expected.map(([amount, eligibleIds], index) => ({
    label: index === 0 ? 'Main pot' : `Side pot ${index}`,
    amount,
    eligibleIds: [...eligibleIds].sort(),
  }));
  assert.deepEqual(actual, wanted);
}

function assertRejected(state, action) {
  const before = JSON.stringify(state);
  assert.throws(
    () => applyAction(deepFreeze(state), action),
    (error) => {
      assert.ok(error instanceof GameError, `expected a GameError, got ${error}`);
      assert.match(error.code, /^[a-z]+(-[a-z]+)*$/);
      return true;
    },
    `${JSON.stringify(action)} should be refused`,
  );
  assert.equal(JSON.stringify(state), before);
}

describe('heads up', () => {
  test('the dealer posts the small blind, acts first preflop and last on later streets', () => {
    let state = table([1000, 1000]);
    let view = toView(state);
    assert.equal(view.handNumber, 1);
    assert.equal(view.street, 'preflop');
    assert.equal(view.dealerId, A);
    assert.equal(view.smallBlindId, A);
    assert.equal(view.bigBlindId, B);
    assert.equal(view.currentBet, 10);
    assert.deepEqual(stacks(state), [995, 990]);
    assert.deepEqual(bets(state), [5, 10]);
    assert.deepEqual(lastActions(state), ['sb', 'bb']);
    assert.deepEqual(view.pot, { total: 15, collected: 0 });
    assertTurn(state, A);
    assertLegal(state, { call: 5, raise: { min: 20, max: 1000 }, allIn: 1000 });

    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });

    state = play(state, check);
    assertClosed(state, 'flop');
    assert.deepEqual(toView(state).pot, { total: 20, collected: 0 });

    state = play(state, deal);
    view = toView(state);
    assert.equal(view.street, 'flop');
    assert.equal(view.currentBet, 0);
    assert.deepEqual(view.pot, { total: 20, collected: 20 });
    assert.deepEqual(bets(state), [0, 0]);
    assertTurn(state, B);
    assertLegal(state, { check: true, bet: { min: 10, max: 990 }, allIn: 990 });

    state = play(state, check);
    assertTurn(state, A);
    state = play(state, check);
    assertClosed(state, 'turn');

    // B bets 20, A makes it 60 (a raise of 40), so a re-raise must reach 60 + 40 = 100.
    state = play(state, deal);
    assertTurn(state, B);
    state = play(state, bet(20));
    assertTurn(state, A);
    assertLegal(state, { call: 20, raise: { min: 40, max: 990 }, allIn: 990 });
    state = play(state, raise(60));
    assertTurn(state, B);
    assertLegal(state, { call: 40, raise: { min: 100, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertClosed(state, 'river');
    assert.deepEqual(toView(state).pot, { total: 140, collected: 20 });

    // No tap after the river: betting closes straight into the showdown.
    state = play(state, deal);
    assertTurn(state, B);
    state = play(state, check);
    assertTurn(state, A);
    state = play(state, check);
    assertShowdown(state);
    assert.equal(toView(state).street, 'river');
    assertPots(state, [[140, [A, B]]]);

    // Each put in 10 + 60 = 70, so 930 behind plus the 140 pot.
    state = play(state, award([A]));
    view = toView(state);
    assert.equal(view.phase, 'handComplete');
    assert.deepEqual(stacks(state), [1070, 930]);
    assert.deepEqual(payouts(state), [140, 0]);
    assert.equal(view.result.foldOut, false);
    assert.deepEqual(view.result.pots, [
      { label: 'Main pot', amount: 140, winnerIds: [A], shares: { [A]: 140 } },
    ]);

    state = play(state, nextHand);
    view = toView(state);
    assert.equal(view.handNumber, 2);
    assert.equal(view.dealerId, B);
    assert.equal(view.smallBlindId, B);
    assert.equal(view.bigBlindId, A);
    assert.equal(view.result, null);
    assert.deepEqual(payouts(state), [0, 0]);
    assert.deepEqual(stacks(state), [1060, 925]);
    assertTurn(state, B);
  });

  test('the small blind folding hands the big blind the pot, with its uncalled 5 back', () => {
    // BB put in 10 against 5, so 5 comes back. The pot is 10 and BB is up exactly 5.
    let state = play(table([1000, 1000]), fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [995, 995]);
    assert.deepEqual(committed(state), [5, 5]);
    assertPots(state, [[10, [B]]]);
    state = play(state, award());
    assert.deepEqual(stacks(state), [995, 1005]);
    assert.equal(toView(state).result.foldOut, true);
  });
});

describe('a three handed game dropping to heads up', () => {
  test('the big blind busts: the button goes to the old small blind', () => {
    // Ann (dealer) folds, Ben shoves 100, Cal calls 90 more. Ben wins 200.
    let state = table([100, 100, 100]);
    state = play(state, fold, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 90, allIn: 100 });
    state = play(state, call, deal, deal, deal, award([B]));
    assert.deepEqual(stacks(state), [100, 200, 0]);

    state = play(state, nextHand);
    let view = toView(state);
    assert.equal(view.dealerId, B);
    assert.equal(view.smallBlindId, B);
    assert.equal(view.bigBlindId, A);
    assert.deepEqual(stacks(state), [90, 195, 0]);
    assert.deepEqual(bets(state), [10, 5, 0]);
    assert.deepEqual(statuses(state), ['active', 'active', 'out']);
    assertTurn(state, B);

    // The non dealer opens every later street and the empty seat is never reached.
    state = play(state, call);
    assertTurn(state, A);
    state = play(state, check, deal);
    assertTurn(state, A);
    state = play(state, check);
    assertTurn(state, B);
    state = play(state, bet(10), fold);
    assertShowdown(state);
    state = play(state, award());
    assert.deepEqual(stacks(state), [90, 210, 0]);

    // The button keeps alternating over the empty seat, wrapping back to A.
    state = play(state, nextHand);
    view = toView(state);
    assert.equal(view.dealerId, A);
    assert.equal(view.smallBlindId, A);
    assert.equal(view.bigBlindId, B);
    assert.deepEqual(stacks(state), [85, 200, 0]);
    assertTurn(state, A);
  });

  test('the small blind busts: the button skips the empty seat to the old big blind', () => {
    let state = table([100, 100, 100]);
    state = play(state, fold, allIn, call, deal, deal, deal, award([C]));
    assert.deepEqual(stacks(state), [100, 0, 200]);

    state = play(state, nextHand);
    const view = toView(state);
    assert.equal(view.dealerId, C);
    assert.equal(view.smallBlindId, C);
    assert.equal(view.bigBlindId, A);
    assert.deepEqual(stacks(state), [90, 0, 195]);
    assert.deepEqual(statuses(state), ['active', 'out', 'active']);
    assertTurn(state, C);
  });

  test('the dealer busts into heads up: the button adjusts so nobody posts the big blind twice', () => {
    // Ann shoves 100, Ben folds his 5, Cal calls 90 more. The pot is 205 and Cal wins it. Moving
    // one seat would make Ben the dealer and Cal the big blind again, so as in TDA Rule 36-C the
    // button goes on to Cal and Ben posts the big blind.
    let state = table([100, 100, 100]);
    state = play(state, allIn, fold, call, deal, deal, deal);
    assertPots(state, [[205, [A, C]]]);
    state = play(state, award([C]));
    assert.deepEqual(stacks(state), [0, 95, 205]);
    assert.equal(toView(state).nextDealerId, C);

    state = play(state, nextHand);
    const view = toView(state);
    assert.equal(view.dealerId, C);
    assert.equal(view.smallBlindId, C);
    assert.equal(view.bigBlindId, B);
    assert.deepEqual(stacks(state), [0, 85, 200]);
    assertTurn(state, C);

    // After that one adjustment the button alternates as usual.
    state = play(state, fold, award(), nextHand);
    assert.equal(toView(state).dealerId, B);
    assert.equal(toView(state).bigBlindId, C);
  });
});

describe('big blind option', () => {
  test('limpers and a completed small blind leave the option, and a raise reopens them all', () => {
    let state = table([1000, 1000, 1000]);
    assertTurn(state, A);
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 5, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, C);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });

    // The big blind makes it 30, a raise of 20. Both limpers may re-raise to at least 50.
    state = play(state, raise(30));
    assertTurn(state, A);
    assertLegal(state, { call: 20, raise: { min: 50, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 20, raise: { min: 50, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(toView(state).pot, { total: 90, collected: 0 });
  });

  test('a small blind who only completes still gives the big blind the option', () => {
    let state = play(table([1000, 1000, 1000]), fold, call);
    assertTurn(state, C);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, check);
    assertClosed(state, 'flop');
    assert.deepEqual(toView(state).pot, { total: 20, collected: 0 });
    state = play(state, deal);
    assertTurn(state, B);
  });

  test('after the option raise the completed small blind sizes off that raise', () => {
    // Cal raises from 10 to 40, a raise of 30, so Ben must reach 70 to re-raise.
    const state = play(table([1000, 1000, 1000]), fold, call, raise(40));
    assertTurn(state, B);
    assertLegal(state, { call: 30, raise: { min: 70, max: 1000 }, allIn: 1000 });
  });

  test('there is no second option once a raise has been called', () => {
    const state = play(table([1000, 1000, 1000]), raise(30), call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(bets(state), [30, 30, 30]);
  });

  test('a big blind who is all in from posting gets no option', () => {
    // Stack of exactly 10. Ann and Ben match it and nobody else needs to act.
    const state = play(table([1000, 1000, 10]), call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [990, 990, 0]);
    assert.deepEqual(statuses(state), ['active', 'active', 'allIn']);
    assert.equal(lastActions(state)[2], 'bb');
    assertPots(state, [[30, [A, B, C]]]);
  });

  test('a big blind with chips gets no option when everyone else is all in', () => {
    // Ann calls all in for 10, Ben completes all in for 10, so Cal has nobody to play against.
    let state = table([10, 10, 1000]);
    assertLegal(state, { call: 10, allIn: 10 });
    state = play(state, call);
    assertLegal(state, { call: 5, allIn: 10 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 990]);
    assertPots(state, [[30, [A, B, C]]]);
  });

  test('a short limper does not take away the option while someone can still answer', () => {
    // Ann is all in for 7. Ben completes to 10. Cal can still check or raise against Ben.
    let state = play(table([7, 1000, 1000]), call, call);
    assertTurn(state, C);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, check);
    assertClosed(state, 'flop');
    assert.deepEqual(bets(state), [7, 10, 10]);
    assertPots(state, [[21, [A, B, C]], [6, [B, C]]]);
  });

  test('with equal blinds the small blind owes nothing but still gets a turn', () => {
    let state = table([1000, 1000], { smallBlind: 10, bigBlind: 10 });
    assertTurn(state, A);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, check);
    assertTurn(state, B);
    state = play(state, check);
    assertClosed(state, 'flop');
  });
});

describe('short blinds heads up', () => {
  test('a small blind all in for 3 closes preflop and the big blind takes 7 back', () => {
    const state = table([3, 1000]);
    assertClosed(state, 'flop');
    const view = toView(state);
    assert.equal(view.smallBlindId, A);
    assert.equal(view.bigBlindId, B);
    assert.deepEqual(stacks(state), [0, 997]);
    assert.deepEqual(bets(state), [3, 3]);
    assert.deepEqual(committed(state), [3, 3]);
    assert.deepEqual(statuses(state), ['allIn', 'active']);
    assert.deepEqual(lastActions(state), ['sb', 'bb']);
    assertPots(state, [[6, [A, B]]]);

    const showdown = play(state, deal, deal, deal);
    assertShowdown(showdown);
    assert.deepEqual(stacks(play(showdown, award([A]))), [6, 997]);

    const over = play(showdown, award([B]));
    assert.deepEqual(stacks(over), [0, 1003]);
    assert.equal(toView(over).phase, 'gameOver');
    assert.equal(toView(over).gameWinnerId, B);
  });

  test('a big blind all in for less than the small blind gets the small blind 2 back', () => {
    const state = table([1000, 3]);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [997, 0]);
    assert.deepEqual(bets(state), [3, 3]);
    assert.deepEqual(committed(state), [3, 3]);
    assert.deepEqual(statuses(state), ['active', 'allIn']);
    assertPots(state, [[6, [A, B]]]);
  });

  test('a big blind all in between the blinds leaves 2 to call and no raise', () => {
    const state = table([1000, 7]);
    assertTurn(state, A);
    assertLegal(state, { call: 2 });
    assertRejected(state, raise(20));
    assertRejected(state, allIn);

    const called = play(state, call);
    assertClosed(called, 'flop');
    assert.deepEqual(stacks(called), [993, 0]);
    assert.deepEqual(bets(called), [7, 7]);
    assertPots(called, [[14, [A, B]]]);

    // A fold leaves the 5 dead. The big blind's top 2 were never called, so they come back and
    // the big blind is not all in any more.
    const folded = play(state, fold);
    assertShowdown(folded);
    assert.deepEqual(stacks(folded), [995, 2]);
    assert.deepEqual(committed(folded), [5, 5]);
    assert.deepEqual(statuses(folded), ['folded', 'active']);
    assertPots(folded, [[10, [B]]]);
    assert.deepEqual(stacks(play(folded, award())), [995, 12]);
  });

  test('a big blind all in for exactly 10 is called for 5 with no raise', () => {
    const state = table([1000, 10]);
    assertLegal(state, { call: 5 });
    const called = play(state, call);
    assertClosed(called, 'flop');
    assert.deepEqual(stacks(called), [990, 0]);
    assertPots(called, [[20, [A, B]]]);
  });

  test('a small blind all in for exactly 5 closes preflop with 5 back to the big blind', () => {
    const state = table([5, 1000]);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 995]);
    assert.deepEqual(bets(state), [5, 5]);
    assertPots(state, [[10, [A, B]]]);
  });

  test('both blinds short: the bigger one is not left all in with chips back', () => {
    // A posts 3, B posts 7. B's top 4 were never matched.
    const state = table([3, 7]);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 4]);
    assert.deepEqual(bets(state), [3, 3]);
    assert.deepEqual(statuses(state), ['allIn', 'active']);
    assertPots(state, [[6, [A, B]]]);
  });

  test('a small blind who can only part complete is all in and the big blind gets 2 back', () => {
    // A posts 5 with 3 behind and owes 5, so the call is capped at 3.
    const state = table([8, 1000]);
    assertLegal(state, { call: 3, allIn: 8 });
    for (const action of [call, allIn]) {
      const shoved = play(state, action);
      assertClosed(shoved, 'flop');
      assert.deepEqual(stacks(shoved), [0, 992]);
      assert.deepEqual(bets(shoved), [8, 8]);
      assertPots(shoved, [[16, [A, B]]]);
    }
  });
});

describe('short blinds multi way', () => {
  test('a short big blind still leaves everyone else owing and raising off the full 10', () => {
    let state = table([1000, 1000, 4]);
    assert.equal(toView(state).currentBet, 10);
    assertTurn(state, A);
    assertLegal(state, { call: 10, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 5, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [990, 990, 0]);
    assert.deepEqual(bets(state), [10, 10, 4]);
    assertPots(state, [[12, [A, B, C]], [12, [A, B]]]);

    // Later streets open on the small blind and skip the all in player.
    state = play(state, deal);
    assertTurn(state, B);
    state = play(state, check);
    assertTurn(state, A);
  });

  test('the minimum raise over a short big blind is still one full big blind', () => {
    // Ann raises to the minimum 20, a raise of 10 over the nominal 10.
    const state = play(table([1000, 1000, 4]), raise(20));
    assertTurn(state, B);
    assertLegal(state, { call: 15, raise: { min: 30, max: 1000 }, allIn: 1000 });
  });

  test('big blind all in for 3: a fold to the small blind closes with 2 back to it', () => {
    const state = play(table([1000, 1000, 3]), fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [1000, 997, 0]);
    assert.deepEqual(bets(state), [0, 3, 3]);
    assert.deepEqual(committed(state), [0, 3, 3]);
    assert.deepEqual(statuses(state), ['folded', 'active', 'allIn']);
    assertPots(state, [[6, [B, C]]]);
  });

  test('big blind all in for 3: a caller gets back what the small blind did not match', () => {
    // Ann calls 10, Ben folds his 5. Ann's top 5 went unmatched. Totals are 5, 5, 3.
    // Main is 3 x 3 = 9 for Ann and Cal, and the other 2 + 2 is Ann's alone.
    const state = play(table([1000, 1000, 3]), call, fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [995, 995, 0]);
    assert.deepEqual(bets(state), [5, 5, 3]);
    assertPots(state, [[9, [A, C]], [4, [A]]]);
  });

  test('big blind all in for 3: two callers build a side pot over it', () => {
    const state = play(table([1000, 1000, 3]), call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [990, 990, 0]);
    assert.deepEqual(bets(state), [10, 10, 3]);
    assertPots(state, [[9, [A, B, C]], [14, [A, B]]]);
  });

  test('a raise over a short big blind is cut back to what the small blind put in', () => {
    // Ann raises to 30, Ben folds. Only Ben's 5 is above Cal's 4, so Ann keeps 25 of the 30.
    // Totals 5, 5, 4 give a main of 12 and 2 more that only Ann can win.
    const state = play(table([1000, 1000, 4]), raise(30), fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [995, 995, 0]);
    assert.deepEqual(bets(state), [5, 5, 4]);
    assertPots(state, [[12, [A, C]], [2, [A]]]);
  });

  test('a short small blind leaves the big blind its option', () => {
    let state = table([1000, 3, 1000]);
    assertTurn(state, A);
    assertLegal(state, { call: 10, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, C);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, check);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [990, 0, 990]);
    assert.deepEqual(bets(state), [10, 3, 10]);
    assertPots(state, [[9, [A, B, C]], [14, [A, C]]]);
  });

  test('with only a short small blind left, the big blind takes back its excess', () => {
    // Ann folds, Ben is all in for 3 posting, Cal is the only live chips above that.
    const state = play(table([1000, 3, 1000]), fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [1000, 0, 997]);
    assert.deepEqual(bets(state), [0, 3, 3]);
    assert.deepEqual(statuses(state), ['folded', 'allIn', 'active']);
    assertPots(state, [[6, [B, C]]]);
  });

  test('both blinds short: nobody owes more than the most one opponent can match', () => {
    // Blinds post 3 and 7. The most anyone can match is 7, not 10, and a raise means nothing.
    const state = table([1000, 3, 7]);
    assertTurn(state, A);
    assertLegal(state, { call: 7 });
    assertRejected(state, raise(20));
    assertRejected(state, allIn);

    const called = play(state, call);
    assertClosed(called, 'flop');
    assert.deepEqual(stacks(called), [993, 0, 0]);
    assert.deepEqual(bets(called), [7, 3, 7]);
    assertPots(called, [[9, [A, B, C]], [8, [A, C]]]);

    // With Ann gone, Cal's top 4 were never matched.
    const folded = play(state, fold);
    assertClosed(folded, 'flop');
    assert.deepEqual(stacks(folded), [1000, 0, 4]);
    assert.deepEqual(bets(folded), [0, 3, 3]);
    assert.deepEqual(statuses(folded), ['folded', 'allIn', 'active']);
    assertPots(folded, [[6, [B, C]]]);
  });

  test('every stack under the big blind: the top one is matched only as far as the second', () => {
    // Ann calls all in for 6. Cal's 7 is 1 above that, so 1 comes back.
    const state = table([6, 3, 7]);
    assertLegal(state, { call: 6, allIn: 6 });
    const called = play(state, call);
    assertClosed(called, 'flop');
    assert.deepEqual(stacks(called), [0, 0, 1]);
    assert.deepEqual(bets(called), [6, 3, 6]);
    assert.deepEqual(statuses(called), ['allIn', 'allIn', 'active']);
    assertPots(called, [[9, [A, B, C]], [6, [A, C]]]);
  });

  test('the small blind only owes up to the all in it faces once the big blind is covered', () => {
    // Ann calls all in for 8, Cal posted 4 all in. Ben owes 8 - 5 = 3, not 5.
    const state = table([8, 1000, 4]);
    assertLegal(state, { call: 8, allIn: 8 });
    const shoved = play(state, call);
    assertTurn(shoved, B);
    assertLegal(shoved, { call: 3 });

    const called = play(shoved, call);
    assertClosed(called, 'flop');
    assert.deepEqual(stacks(called), [0, 992, 0]);
    assert.deepEqual(bets(called), [8, 8, 4]);
    assertPots(called, [[12, [A, B, C]], [8, [A, B]]]);

    // Ben folds his 5. Ann's top 3 are uncalled, so she is back to active with 3 behind.
    const folded = play(shoved, fold);
    assertClosed(folded, 'flop');
    assert.deepEqual(stacks(folded), [3, 995, 0]);
    assert.deepEqual(bets(folded), [5, 5, 4]);
    assert.deepEqual(statuses(folded), ['active', 'folded', 'allIn']);
    assertPots(folded, [[12, [A, C]], [2, [A]]]);
  });

  test('a small blind all in from posting still gets its excess over a shorter big blind', () => {
    // Stack of exactly 5 posted, big blind all in for 3, Ann folds. The top 2 come back.
    const state = play(table([1000, 5, 3]), fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [1000, 2, 0]);
    assert.deepEqual(statuses(state), ['folded', 'active', 'allIn']);
    assertPots(state, [[6, [B, C]]]);
  });

  test('a one chip dealer and a one chip small blind leave the big blind 9 back', () => {
    // Ben posts his 1 and Cal posts 10. Ann calls all in for 1. Cal owes nothing and has nobody
    // left to bet into, so he never gets a turn and 9 of his 10 come back.
    let state = table([1, 1, 1000]);
    assert.equal(toView(state).dealerId, A);
    assert.equal(toView(state).smallBlindId, B);
    assert.equal(toView(state).bigBlindId, C);
    assertLegal(state, { call: 1, allIn: 1 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 999]);
    assert.deepEqual(bets(state), [1, 1, 1]);
    assertPots(state, [[3, [A, B, C]]]);
  });
});

describe('minimum raises', () => {
  test('each re-raise must match the biggest raise so far', () => {
    // Ann deals, so Dee opens: 30 (raise 20), Ann 50 (raise 20), Ben 120 (raise 70), Cal 190.
    let state = table([1000, 1000, 1000, 1000]);
    assertTurn(state, D);
    assertLegal(state, { call: 10, raise: { min: 20, max: 1000 }, allIn: 1000 });
    assertRejected(state, raise(19));
    state = play(state, raise(30));
    assertTurn(state, A);
    assertLegal(state, { call: 30, raise: { min: 50, max: 1000 }, allIn: 1000 });
    assertRejected(state, raise(49));
    state = play(state, raise(50));
    assertTurn(state, B);
    assertLegal(state, { call: 45, raise: { min: 70, max: 1000 }, allIn: 1000 });
    state = play(state, raise(120));
    assertTurn(state, C);
    assertLegal(state, { call: 110, raise: { min: 190, max: 1000 }, allIn: 1000 });
    assertRejected(state, raise(189));
    state = play(state, raise(190));
    assertTurn(state, D);
    assertLegal(state, { call: 160, raise: { min: 260, max: 1000 }, allIn: 1000 });
  });

  test('the sizing starts again at the big blind on every street', () => {
    // Flop: B bets 25, A raises to 60 (raise 35). B needs 95. The turn starts over at 10.
    let state = play(table([1000, 1000]), call, check, deal);
    assertRejected(state, bet(9));
    state = play(state, bet(25));
    assertLegal(state, { call: 25, raise: { min: 50, max: 990 }, allIn: 990 });
    assertRejected(state, raise(49));
    state = play(state, raise(60));
    assertLegal(state, { call: 35, raise: { min: 95, max: 990 }, allIn: 990 });
    state = play(state, call, deal);
    assertTurn(state, B);
    assertLegal(state, { check: true, bet: { min: 10, max: 930 }, allIn: 930 });
  });

  test('a short all in lifts the bet but the next raise still adds the last full raise', () => {
    // Ann 30 (raise 20), Ben all in 40 (short), so Cal must reach 40 + 20 = 60. Cal's 60 is a full
    // raise of 20, which reopens Ann, who must reach 80. Dee folds and Ann calls.
    let state = table([1000, 40, 1000, 1000], { dealer: 1 });
    assertTurn(state, A);
    state = play(state, raise(30));
    assertTurn(state, B);
    assertLegal(state, { call: 30, allIn: 40 });
    state = play(state, allIn);
    assert.equal(toView(state).currentBet, 40);
    assertTurn(state, C);
    assertLegal(state, { call: 35, raise: { min: 60, max: 1000 }, allIn: 1000 });
    assertRejected(state, raise(59));
    state = play(state, raise(60));
    assertTurn(state, D);
    assertLegal(state, { call: 50, raise: { min: 80, max: 1000 }, allIn: 1000 });
    state = play(state, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 30, raise: { min: 80, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(bets(state), [60, 40, 60, 10]);
    assert.deepEqual(stacks(state), [940, 0, 940, 990]);
    assertPots(state, [[130, [A, B, C]], [40, [A, C]]]);
  });

  test('an opening bet below the big blind needs the all in button', () => {
    // Three limp, leaving Ben 7. He can't bet that, only shove it. Cal must then call 7 or reach
    // 7 + 10 = 17. Ann checked and 7 is less than a full bet, so she may only call or fold.
    let state = table([1000, 17, 1000], { dealer: 2 });
    state = play(state, call, call, check, deal);
    assertTurn(state, A);
    state = play(state, check);
    assertTurn(state, B);
    assertLegal(state, { check: true, allIn: 7 });
    assertRejected(state, bet(7));
    assertRejected(state, bet(10));
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 7, raise: { min: 17, max: 990 }, allIn: 990 });
    assertRejected(state, raise(16));

    const called = play(state, call);
    assertTurn(called, A);
    assertLegal(called, { call: 7 });
    assertRejected(called, raise(17));
    const closed = play(called, call);
    assertClosed(closed, 'turn');
    assert.deepEqual(stacks(closed), [983, 0, 983]);
    assertPots(closed, [[51, [A, B, C]]]);

    // A raise to 17 adds a full 10 to the short 7, so Ann can come back over the top to 27.
    const raised = play(state, raise(17));
    assertTurn(raised, A);
    assertLegal(raised, { call: 17, raise: { min: 27, max: 990 }, allIn: 990 });
  });

  test('a whole stack raise that is exactly full counts as all in and reopens', () => {
    // Ann 30. Ben has 50 and the minimum is 50, so the raise button can do it. Cal calls.
    let state = table([1000, 50, 1000]);
    state = play(state, raise(30));
    assertLegal(state, { call: 25, raise: { min: 50, max: 50 }, allIn: 50 });
    state = play(state, raise(50));
    assert.equal(statuses(state)[1], 'allIn');
    assert.equal(lastActions(state)[1], 'allIn');
    assertTurn(state, C);
    assertLegal(state, { call: 40, raise: { min: 70, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 20, raise: { min: 70, max: 1000 }, allIn: 1000 });
  });

  test('one chip short of a full raise does not reopen', () => {
    // Ann 30. Ben all in 49 adds 19, under the 20 needed. Cal must reach 49 + 20 = 69.
    let state = table([1000, 49, 1000]);
    state = play(state, raise(30));
    assertLegal(state, { call: 25, allIn: 49 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 39, raise: { min: 69, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 19 });
    assertRejected(state, raise(69));
    assertRejected(state, allIn);
  });

  test('an all in that is more than a full raise sets the new size', () => {
    // Ann 30, Ben all in 100 raises by 70, so Cal must reach 170.
    const state = play(table([1000, 100, 1000]), raise(30), allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 90, raise: { min: 170, max: 1000 }, allIn: 1000 });
  });

  test('the top of the range is the stack and one chip more is refused', () => {
    const state = table([1000, 1000]);
    assertRejected(state, raise(1001));
    const shoved = play(state, raise(1000));
    assert.equal(statuses(shoved)[0], 'allIn');
    assert.equal(stacks(shoved)[0], 0);
  });
});

describe('short all ins and reopening', () => {
  test('a short all in over a bet lets the bettor only call or fold', () => {
    // All limp for 10. Flop: Ann bets 100, Ben all in 120 adds 20 of a needed 100. Cal and Dee have
    // not acted and may raise to 220. Ann acted at 100 and faces only 20, so she calls or folds.
    let state = table([1000, 130, 1000, 1000], { dealer: 3 });
    state = play(state, call, call, call, check, deal);
    assertTurn(state, A);
    state = play(state, bet(100));
    assertTurn(state, B);
    assertLegal(state, { call: 100, allIn: 120 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 120, raise: { min: 220, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertTurn(state, D);
    assertLegal(state, { call: 120, raise: { min: 220, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 20 });
    assertRejected(state, raise(220));
    assertRejected(state, allIn);
    assertRejected(state, bet(220));

    state = play(state, call);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [870, 0, 870, 870]);
    assertPots(state, [[520, [A, B, C, D]]]);
  });

  test('a full raise after a short all in reopens the original bettor', () => {
    // Same flop. Cal raises to 220, a raise of 100, and Dee folds. Ann may now re-raise to 320.
    // Totals A 230, B 130, C 230, D 10: main 3 x 130 + 10 = 400, side 100 + 100 = 200.
    let state = table([1000, 130, 1000, 1000], { dealer: 3 });
    state = play(state, call, call, call, check, deal, bet(100), allIn, raise(220));
    assertTurn(state, D);
    assertLegal(state, { call: 220, raise: { min: 320, max: 990 }, allIn: 990 });
    state = play(state, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 120, raise: { min: 320, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [770, 0, 770, 990]);
    assertPots(state, [[400, [A, B, C]], [200, [A, C]]]);
  });

  test('two short all ins that add up to a full raise reopen everyone who faces it all', () => {
    // Ann 30 (raise 20), Ben calls. Cal all in 40, Dee all in 50, each short by 10. Eli folds his
    // blind. Ann and Ben acted at 30 and face 20 more, which is a full raise. Ann makes it 70.
    // Totals A 70, B 70, C 40, D 50, E 10. Main 4 x 40 + 10 = 170. Side 1 is 3 x 10 = 30.
    // Side 2 is 2 x 20 = 40.
    let state = table([1000, 1000, 40, 50, 1000], { dealer: 2 });
    assertTurn(state, A);
    state = play(state, raise(30), call);
    assertTurn(state, C);
    assertLegal(state, { call: 30, allIn: 40 });
    state = play(state, allIn);
    assertTurn(state, D);
    assertLegal(state, { call: 35, allIn: 50 });
    state = play(state, allIn);
    assertTurn(state, E);
    assertLegal(state, { call: 40, raise: { min: 70, max: 1000 }, allIn: 1000 });
    state = play(state, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 20, raise: { min: 70, max: 1000 }, allIn: 1000 });
    assertRejected(state, raise(69));
    state = play(state, raise(70));
    assertTurn(state, B);
    assertLegal(state, { call: 40, raise: { min: 90, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [930, 930, 0, 0, 990]);
    assertPots(state, [[170, [A, B, C, D]], [30, [A, B, D]], [40, [A, B]]]);

    state = play(state, deal);
    assertTurn(state, A);
    state = checkDown(state);
    state = play(state, award([C], [D], [A]));
    assert.deepEqual(stacks(state), [970, 930, 170, 30, 990]);
  });

  test('two short all ins that fall short of a full raise together do not reopen', () => {
    // Ann 30, Ben calls, Cal all in 38 (+8), Dee all in 45 (+7). Together 15, under 20.
    // Totals 45, 45, 38, 45, 10. Main 4 x 38 + 10 = 162, side 3 x 7 = 21.
    let state = table([1000, 1000, 38, 45, 1000], { dealer: 2 });
    state = play(state, raise(30), call, allIn, allIn);
    assertTurn(state, E);
    assertLegal(state, { call: 35, raise: { min: 65, max: 1000 }, allIn: 1000 });
    state = play(state, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 15 });
    assertRejected(state, allIn);
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 15 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [955, 955, 0, 0, 990]);
    assertPots(state, [[162, [A, B, C, D]], [21, [A, B, D]]]);
  });

  test('a call between two short all ins only counts what came after it', () => {
    // Ann 30, Ben calls, Cal all in 40, Dee calls 40, Eli all in 50, Fay folds. Ann and Ben face
    // 20 more and may raise. Dee faces only 10 and may not.
    // Totals 50, 50, 40, 50, 50, 10. Main 5 x 40 + 10 = 210, side 4 x 10 = 40.
    let state = table([1000, 1000, 40, 1000, 50, 1000], { dealer: 3 });
    state = play(state, raise(30), call, allIn, call, allIn, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 20, raise: { min: 70, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 20, raise: { min: 70, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, D);
    assertLegal(state, { call: 10 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [950, 950, 0, 950, 0, 990]);
    assertPots(state, [[210, [A, B, C, D, E]], [40, [A, B, D, E]]]);
  });

  test('a short all in over the big blind shuts out limpers but not the blinds', () => {
    // Ann limps. Ben all in 15 adds 5. The blinds have not acted, so they can reach 15 + 10 = 25.
    // Ann acted at 10 and faces only 5.
    let state = table([1000, 15, 1000, 1000], { dealer: 1 });
    assertTurn(state, A);
    state = play(state, call);
    assertLegal(state, { call: 10, allIn: 15 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 10, raise: { min: 25, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, D);
    assertLegal(state, { call: 5, raise: { min: 25, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 5 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assertPots(state, [[60, [A, B, C, D]]]);
  });

  test('a raiser facing a short all in with nobody left behind can only call or fold', () => {
    let state = table([1000, 40, 1000]);
    state = play(state, raise(30), allIn, fold);
    assertTurn(state, A);
    assertLegal(state, { call: 10 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(bets(state), [40, 40, 10]);
    assertPots(state, [[90, [A, B]]]);
  });

  test('two short flop all ins add up to a full bet for a player who checked', () => {
    // Everyone limps. Flop: Ann checks, Ben all in 6, Cal all in 12, Dee calls 12. Ann checked at 0
    // and now faces 12, which is at least the big blind, so she may raise to 12 + 10 = 22.
    // Totals 22, 16, 22, 22. Main 4 x 16 = 64, side 3 x 6 = 18.
    let state = table([1000, 16, 22, 1000], { dealer: 3 });
    state = play(state, call, call, call, check, deal, check);
    assertTurn(state, B);
    assertLegal(state, { check: true, allIn: 6 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 6, allIn: 12 });
    state = play(state, allIn);
    assertTurn(state, D);
    assertLegal(state, { call: 12, raise: { min: 22, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 12, raise: { min: 22, max: 990 }, allIn: 990 });
    state = play(state, call);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [978, 0, 0, 978]);
    assertPots(state, [[64, [A, B, C, D]], [18, [A, C, D]]]);
  });

  test('limpers stay shut out by one short all in and are let back in by a second', () => {
    // Blinds 1000 and 2000. Two limp, Cal all in 2500 adds only 500.
    const start = table([20000, 20000, 2500, 4000, 20000, 20000], {
      dealer: 3,
      smallBlind: 1000,
      bigBlind: 2000,
    });
    assertTurn(start, A);
    const shoved = play(start, call, call, allIn);
    assertTurn(shoved, D);
    assertLegal(shoved, { call: 2500, allIn: 4000 });

    // Everyone behind folds: the limpers face 500, so they may only call.
    const shut = play(shoved, fold, fold, fold);
    assertTurn(shut, A);
    assertLegal(shut, { call: 500 });

    // Dee all in 4000 adds 1500. Short alone, but 2000 in total over the limpers is a full raise.
    const reopened = play(shoved, allIn, fold, fold);
    assertTurn(reopened, A);
    assertLegal(reopened, { call: 2000, raise: { min: 6000, max: 20000 }, allIn: 20000 });
  });
});

// The worked rulings in the Poker TDA Illustration Addendum (2019 Rules, Version 1.0), under Rule
// 16 Face Up for All-Ins, Rule 43 Raise Amounts and Rule 47 Re-opening the Bet. Same blinds, same
// amounts, same answers, so these are published results and not anyone's reading of the rules.
describe('TDA illustration addendum', () => {
  describe('Rule 43, raise amounts', () => {
    test('example 1: the minimum is the last raise of 2000, not C\'s total of 3600', () => {
      // Blinds 100-200. Post-flop A bets 600, B raises 1000 to 1600, C raises 2000 to 3600.
      // D must raise at least 2000 more, for a total of 5600.
      let state = table([20000, 20000, 20000, 20000], {
        dealer: 3,
        smallBlind: 100,
        bigBlind: 200,
      });
      state = play(state, call, call, call, check, deal);
      assertTurn(state, A);
      state = play(state, bet(600), raise(1600), raise(3600));
      assertTurn(state, D);
      assertLegal(state, { call: 3600, raise: { min: 5600, max: 19800 }, allIn: 19800 });
    });

    test('example 2: a preflop all in for 150 leaves the 100 blind as the largest bet', () => {
      // Blinds 50-100. A is under the gun, all in for 150. B must raise 100, to 250.
      let state = table([150, 5000, 5000, 5000], { dealer: 1, smallBlind: 50, bigBlind: 100 });
      assertTurn(state, A);
      state = play(state, allIn);
      assertTurn(state, B);
      assertLegal(state, { call: 150, raise: { min: 250, max: 5000 }, allIn: 5000 });
    });

    test('example 3: a raise to 1000 over 300 means C needs 1700, not 2000', () => {
      // Blinds 100-200. On the turn A bets 300, B makes it 1000, a raise of 700.
      let state = table([20000, 20000, 20000], { dealer: 2, smallBlind: 100, bigBlind: 200 });
      state = play(state, call, call, check, deal, check, check, check, deal);
      assertTurn(state, A);
      state = play(state, bet(300), raise(1000));
      assertTurn(state, C);
      assertLegal(state, { call: 1000, raise: { min: 1700, max: 19800 }, allIn: 19800 });
    });

    test('example 4-A: the largest raise so far sets the size, 300 here', () => {
      // Blinds 25-50. A raises 75 to 125, B raises the minimum 75 to 200, C raises 300 to 500.
      // D must raise at least 300 more, to 800.
      let state = table([20000, 20000, 20000, 20000, 20000, 20000], {
        dealer: 3,
        smallBlind: 25,
        bigBlind: 50,
      });
      assertTurn(state, A);
      state = play(state, raise(125));
      assertTurn(state, B);
      assertLegal(state, { call: 125, raise: { min: 200, max: 20000 }, allIn: 20000 });
      state = play(state, raise(200), raise(500));
      assertTurn(state, D);
      assertLegal(state, { call: 500, raise: { min: 800, max: 20000 }, allIn: 20000 });
    });

    test('example 4-B: the same 500 reached in one raise of 450 needs 950', () => {
      let state = table([20000, 20000, 20000, 20000, 20000, 20000], {
        dealer: 3,
        smallBlind: 25,
        bigBlind: 50,
      });
      state = play(state, raise(500), call, call);
      assertTurn(state, D);
      assertLegal(state, { call: 500, raise: { min: 950, max: 20000 }, allIn: 20000 });
    });
  });

  describe('Rule 47, re-opening the bet', () => {
    // Blinds 50-100, all in for the blind. Post-flop A opens 100, B all in 125, C calls 125,
    // D all in 200, E calls 200. Neither increment is a full raise but together they are.
    const example1 = () => {
      const state = table([5000, 225, 5000, 300, 5000], {
        dealer: 4,
        smallBlind: 50,
        bigBlind: 100,
      });
      return play(state, call, call, call, call, check, deal, bet(100), allIn, call, allIn, call);
    };

    test('example 1: A faces a total raise of 100, so A can fold, call or raise', () => {
      const state = example1();
      assertTurn(state, A);
      assertLegal(state, { call: 100, raise: { min: 300, max: 4900 }, allIn: 4900 });
    });

    test('example 1-A: after A calls, C faces only the 75 and cannot raise', () => {
      const state = play(example1(), call);
      assertTurn(state, C);
      assertLegal(state, { call: 75 });
      assertRejected(state, raise(300));
      assertRejected(state, allIn);
    });

    test('example 1-B: after A raises to 300, C faces 175 and can raise', () => {
      const state = play(example1(), raise(300));
      assertTurn(state, C);
      assertLegal(state, { call: 175, raise: { min: 400, max: 4900 }, allIn: 4900 });
    });

    test('example 2: three short all ins leave the minimum raise at the opening 300', () => {
      // Blinds 50-100. Post-flop A opens 300, B all in 500, C all in 650, D all in 800, E calls.
      // No single all in added 300, so F can call 800 or raise to at least 1100.
      let state = table([5000, 600, 750, 900, 5000, 5000], {
        dealer: 5,
        smallBlind: 50,
        bigBlind: 100,
      });
      state = play(state, call, call, call, call, call, check, deal);
      assertTurn(state, A);
      state = play(state, bet(300), allIn, allIn, allIn, call);
      assertTurn(state, F);
      assertLegal(state, { call: 800, raise: { min: 1100, max: 4900 }, allIn: 4900 });
    });

    // Blinds 2000-4000. A calls 4000, B folds, C all in 7500, the small blind folds.
    const example3 = () => {
      const state = table([50000, 50000, 7500, 50000, 50000], {
        dealer: 2,
        smallBlind: 2000,
        bigBlind: 4000,
      });
      return play(state, call, fold, allIn, fold);
    };

    test('example 3: the big blind on its option can raise by 4000 to 11500', () => {
      const state = example3();
      assertTurn(state, E);
      assertLegal(state, { call: 3500, raise: { min: 11500, max: 50000 }, allIn: 50000 });
    });

    test('example 3-A: after the big blind calls, A faces 3500 and cannot raise', () => {
      const state = play(example3(), call);
      assertTurn(state, A);
      assertLegal(state, { call: 3500 });
      assertRejected(state, raise(15500));
      assertRejected(state, allIn);
    });

    test('example 3-B: after the big blind raises to 11500, A faces 7500 and can raise', () => {
      const state = play(example3(), raise(11500));
      assertTurn(state, A);
      assertLegal(state, { call: 7500, raise: { min: 15500, max: 50000 }, allIn: 50000 });
    });
  });

  test('Rule 16, example 3: the 700 all in and the 2000 side pot behind it', () => {
    // A all in 700, B and C call. Flop checks, B bets 1000 on the turn, C calls, river checks.
    let state = table([700, 5000, 5000], { smallBlind: 50, bigBlind: 100 });
    state = play(state, allIn, call, call, deal, check, check, deal, bet(1000), call);
    state = play(state, deal, check, check);
    assertShowdown(state);
    assertPots(state, [[2100, [A, B, C]], [2000, [B, C]]]);
  });
});

describe('all in for less than the call', () => {
  test('a short call does not lower the bet for the players behind it', () => {
    // All limp, Ben has 60 left. Flop: Ann bets 100, Ben calls all in for 60, Cal still owes 100.
    // Totals 110, 70, 110. Main 3 x 70 = 210, side 40 + 40 = 80. Ann is not asked again.
    let state = table([1000, 70, 1000], { dealer: 2 });
    state = play(state, call, call, check, deal, bet(100));
    assertTurn(state, B);
    assertLegal(state, { call: 60, allIn: 60 });
    state = play(state, call);
    assert.equal(toView(state).currentBet, 100);
    assertTurn(state, C);
    assertLegal(state, { call: 100, raise: { min: 200, max: 990 }, allIn: 990 });

    const called = play(state, call);
    assertClosed(called, 'turn');
    assert.deepEqual(stacks(called), [890, 0, 890]);
    assert.deepEqual(bets(called), [100, 60, 100]);
    assertPots(called, [[210, [A, B, C]], [80, [A, C]]]);
  });

  test('if the last player folds, the bet above the short call comes back', () => {
    // Cal folds to Ann's 100 after Ben's 60. Ann's top 40 were never matched.
    let state = table([1000, 70, 1000], { dealer: 2 });
    state = play(state, call, call, check, deal, bet(100), call, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [930, 0, 990]);
    assert.deepEqual(bets(state), [60, 60, 0]);
    assert.deepEqual(committed(state), [70, 70, 10]);
    assertPots(state, [[150, [A, B]]]);
  });

  test('a raise over a short call that the bettor folds to is cut back to the bet', () => {
    // Cal raises to 300, Ann folds her 100. Only 100 of Cal's 300 was matched, so 200 returns.
    // Totals 110, 70, 110. Main 210 for Ben and Cal, then 40 + 40 = 80 for Cal alone.
    let state = table([1000, 70, 1000], { dealer: 2 });
    state = play(state, call, call, check, deal, bet(100), call, raise(300));
    assertTurn(state, A);
    assertLegal(state, { call: 200, raise: { min: 500, max: 990 }, allIn: 990 });
    state = play(state, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [890, 0, 890]);
    assert.deepEqual(bets(state), [100, 60, 100]);
    assertPots(state, [[210, [B, C]], [80, [C]]]);
  });

  test('a short stack under the gun does not change what the others owe preflop', () => {
    // Dee is all in for 7. Ann owes 10, Ben 5, Cal keeps the option.
    // Main 4 x 7 = 28, side 3 x 3 = 9.
    let state = table([1000, 1000, 1000, 7]);
    assertTurn(state, D);
    assertLegal(state, { call: 7, allIn: 7 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 10, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 5, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, call);
    assertTurn(state, C);
    assertLegal(state, { check: true, raise: { min: 20, max: 1000 }, allIn: 1000 });
    state = play(state, check);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [990, 990, 990, 0]);
    assertPots(state, [[28, [A, B, C, D]], [9, [A, B, C]]]);
  });
});

describe('uncalled bets', () => {
  test('everyone folds to a flop bet: it comes back and the pot is only what was called', () => {
    let state = table([1000, 1000, 1000]);
    state = play(state, call, call, check, deal, bet(100), fold, fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [990, 990, 990]);
    assert.deepEqual(bets(state), [0, 0, 0]);
    assert.deepEqual(committed(state), [10, 10, 10]);
    assert.deepEqual(toView(state).pot, { total: 30, collected: 30 });
    assertPots(state, [[30, [B]]]);

    state = play(state, award());
    assert.deepEqual(stacks(state), [990, 1020, 990]);
    assert.deepEqual(payouts(state), [0, 30, 0]);
    assert.deepEqual(toView(state).result, {
      foldOut: true,
      pots: [{ label: 'Main pot', amount: 30, winnerIds: [B], shares: { [B]: 30 } }],
    });
  });

  test('everyone folds to a preflop raise: it drops to the most anyone else put in', () => {
    // Ann 30, Ben folds 5, Cal folds 10. Ann's 20 above Cal's 10 come back. The pot is 25.
    let state = play(table([1000, 1000, 1000]), raise(30), fold, fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [990, 995, 990]);
    assert.deepEqual(committed(state), [10, 5, 10]);
    assertPots(state, [[25, [A]]]);
    state = play(state, award());
    assert.deepEqual(stacks(state), [1015, 995, 990]);
  });

  test('a re-raise that is folded to returns only the part above the bet', () => {
    // Pot 30. Ben bets 100, Cal folds, Ann raises to 300, Ben folds. 200 back to Ann.
    // Totals 110, 110, 10, pot 230.
    let state = table([1000, 1000, 1000]);
    state = play(state, call, call, check, deal, bet(100), fold, raise(300), fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [890, 890, 990]);
    assert.deepEqual(committed(state), [110, 110, 10]);
    state = play(state, award());
    assert.deepEqual(stacks(state), [1120, 890, 990]);
  });

  test('all folded to the big blind: the blind is cut back to the small blind', () => {
    let state = play(table([1000, 1000, 1000]), fold, fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [1000, 995, 995]);
    assert.deepEqual(committed(state), [0, 5, 5]);
    assertPots(state, [[10, [C]]]);
    state = play(state, award());
    assert.deepEqual(stacks(state), [1000, 995, 1005]);
  });

  test('a covering all in called short gets the rest back and is active again', () => {
    // A shoves 500 and B can only reach 200. 300 returns. Nobody is left to bet.
    let state = table([500, 200]);
    state = play(state, allIn);
    assertTurn(state, B);
    assertLegal(state, { call: 190, allIn: 200 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [300, 0]);
    assert.deepEqual(bets(state), [200, 200]);
    assert.deepEqual(committed(state), [200, 200]);
    assert.deepEqual(statuses(state), ['active', 'allIn']);
    assertPots(state, [[400, [A, B]]]);

    const showdown = play(state, deal, deal, deal);
    assertShowdown(showdown);

    const shortWins = play(showdown, award([B]));
    assert.deepEqual(stacks(shortWins), [300, 400]);
    assert.equal(toView(shortWins).phase, 'handComplete');

    const bigWins = play(showdown, award([A]));
    assert.deepEqual(stacks(bigWins), [700, 0]);
    assert.equal(toView(bigWins).phase, 'gameOver');
    assert.equal(toView(bigWins).gameWinnerId, A);
  });

  test('a river shove called short returns the rest and still goes straight to showdown', () => {
    // Limp, check to the river. A shoves 290, B calls all in for 90. 200 goes back.
    let state = table([300, 100]);
    state = play(state, call, check, deal, check, check, deal, check, check, deal, check, allIn);
    assertLegal(state, { call: 90, allIn: 90 });
    state = play(state, call);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [200, 0]);
    assert.deepEqual(committed(state), [100, 100]);
    assert.deepEqual(statuses(state), ['active', 'allIn']);
    assertPots(state, [[200, [A, B]]]);
  });

  test('the second highest bet can belong to a player who has folded', () => {
    // Limped for 10. Flop: Ann bets 100, Ben all in 150, Cal calls all in 60, Ann folds. Ben's top
    // 50 sit above Ann's dead 100, so they return and Ben is active again.
    // Totals 110, 110, 70. Main 3 x 70 = 210 for Ben and Cal, then 40 + 40 = 80 for Ben alone.
    let state = table([1000, 160, 70], { dealer: 2 });
    state = play(state, call, call, check, deal, bet(100));
    assertLegal(state, { call: 100, allIn: 150 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 60, allIn: 60 });
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 50 });
    state = play(state, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [890, 50, 0]);
    assert.deepEqual(bets(state), [100, 100, 60]);
    assert.deepEqual(committed(state), [110, 110, 70]);
    assert.deepEqual(statuses(state), ['folded', 'active', 'allIn']);
    assertPots(state, [[210, [B, C]], [80, [B]]]);
  });

  test('a short raise that everyone folds to gets its short part back', () => {
    // Heads up on the flop: Ann bets 100, Ben all in 120, Ann folds. Ben keeps 20 and the pot.
    let state = table([1000, 130]);
    state = play(state, call, check, deal, check, bet(100), allIn);
    assertTurn(state, A);
    assertLegal(state, { call: 20 });
    state = play(state, fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [890, 20]);
    assert.deepEqual(statuses(state), ['folded', 'active']);
    assertPots(state, [[220, [B]]]);
    state = play(state, award());
    assert.deepEqual(stacks(state), [890, 240]);
  });

  test('nothing comes back when two players share the top bet', () => {
    let state = table([100, 100, 1000]);
    state = play(state, allIn, call);
    assertTurn(state, C);
    state = play(state, fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 990]);
    assert.deepEqual(statuses(state), ['allIn', 'allIn', 'folded']);
    assertPots(state, [[210, [A, B]]]);
  });

  test('an all in nobody calls comes back whole beyond the blinds', () => {
    // Ann shoves 1000, Ben and Cal fold. Ann keeps all but 10, so she is not left all in.
    let state = play(table([1000, 1000, 1000]), allIn, fold, fold);
    assertShowdown(state);
    assert.deepEqual(stacks(state), [990, 995, 990]);
    assert.deepEqual(statuses(state), ['active', 'folded', 'folded']);
    assertPots(state, [[25, [A]]]);
  });
});

describe('side pots', () => {
  test('while betting runs only an all in player caps a pot', () => {
    // Blinds alone are not side pots, even though 0, 5 and 10 are three different totals.
    // Ann can still call, so all three are in one pot of 5 + 10.
    assertPots(table([1000, 1000, 1000]), [[15, [A, B, C]]]);

    // Cal is all in for 4, which stops the main pot at 4 a player. Ben's fifth chip is already
    // past that cap, so it is a real side pot before anyone has acted: main 4 + 4, side 1.
    let state = table([1000, 1000, 4]);
    assertPots(state, [[8, [A, B, C]], [1, [A, B]]]);

    // Ann's 10 is 4 to the main pot and 6 to the side pot.
    state = play(state, call);
    assertPots(state, [[12, [A, B, C]], [7, [A, B]]]);

    // Ben's last 5 are all above the cap.
    state = play(state, call);
    assertPots(state, [[12, [A, B, C]], [12, [A, B]]]);
  });

  test('three way 100, 200, 300: each player can only win what they matched', () => {
    // Ann all in 100, Ben all in 200, Cal calls 190 more and has 100 behind.
    // Main 3 x 100 = 300, side 2 x 100 = 200.
    let state = table([100, 200, 300]);
    state = play(state, allIn);
    assertTurn(state, B);
    assertLegal(state, { call: 95, raise: { min: 190, max: 200 }, allIn: 200 });
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 190 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 100]);
    assertPots(state, [[300, [A, B, C]], [200, [B, C]]]);

    const showdown = play(state, deal, deal, deal);
    assertShowdown(showdown);

    const mixed = play(showdown, award([A], [B]));
    assert.deepEqual(stacks(mixed), [300, 200, 100]);
    assert.deepEqual(payouts(mixed), [300, 200, 0]);
    assert.equal(toView(mixed).phase, 'handComplete');

    const sweep = play(showdown, award([C], [C]));
    assert.deepEqual(stacks(sweep), [0, 0, 600]);
    assert.equal(toView(sweep).phase, 'gameOver');
    assert.equal(toView(sweep).gameWinnerId, C);
  });

  test('four way 100, 250, 400, 1000: main and two side pots', () => {
    // Cal shoves 400, Dee calls, the blinds call all in for what they have.
    // Main 4 x 100 = 400. Side 1 is 3 x 150 = 450. Side 2 is 2 x 150 = 300.
    let state = table([100, 250, 400, 1000], { dealer: 3 });
    assertTurn(state, C);
    state = play(state, allIn);
    assertTurn(state, D);
    state = play(state, call);
    assertTurn(state, A);
    assertLegal(state, { call: 95, allIn: 100 });
    state = play(state, call);
    assertTurn(state, B);
    assertLegal(state, { call: 240, allIn: 250 });
    state = play(state, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 0, 600]);
    assertPots(state, [[400, [A, B, C, D]], [450, [B, C, D]], [300, [C, D]]]);

    state = play(state, deal, deal, deal, award([A], [B], [C]));
    assert.deepEqual(stacks(state), [400, 450, 300, 600]);
    assert.deepEqual(toView(state).result.pots.map(({ label }) => label), [
      'Main pot',
      'Side pot 1',
      'Side pot 2',
    ]);
  });

  test('five way 100 to 500 stacks: a main and three side pots', () => {
    // Totals 100, 200, 300, 400, 400. Eli's last 100 are never in play.
    // Main 5 x 100 = 500. Then 4 x 100 = 400, 3 x 100 = 300, 2 x 100 = 200.
    let state = table([100, 200, 300, 400, 500], { dealer: 4 });
    assertTurn(state, C);
    state = play(state, allIn);
    assertTurn(state, D);
    state = play(state, allIn);
    assertTurn(state, E);
    state = play(state, call, call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 0, 0, 100]);
    assertPots(state, [
      [500, [A, B, C, D, E]],
      [400, [B, C, D, E]],
      [300, [C, D, E]],
      [200, [D, E]],
    ]);
    state = play(state, deal, deal, deal, award([A], [B], [C], [D]));
    assert.deepEqual(stacks(state), [500, 400, 300, 200, 100]);
  });

  test('nine players all in make a main pot and seven side pots', () => {
    // Stacks 100 to 900, Ida deals. Cal shoves 300 and each player to Hal shoves over it. Ida
    // calls 800, leaving 100, and the blinds call for what they have. Totals 100 to 800, then 800.
    // Each 100 layer loses one player: 9 x 100, 8 x 100 and so on down to 2 x 100.
    let state = table([100, 200, 300, 400, 500, 600, 700, 800, 900], { dealer: 8 });
    assertTurn(state, C);
    state = play(state, allIn, allIn, allIn, allIn, allIn, allIn, call, call, call);
    assertClosed(state, 'flop');
    const ids = (from) => ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'].slice(from);
    const layers = [900, 800, 700, 600, 500, 400, 300, 200];
    assertPots(state, layers.map((amount, i) => [amount, ids(i)]));
    state = play(state, deal, deal, deal);
    state = play(state, award(...[0, 1, 2, 3, 4, 5, 6, 7].map((seat) => [`p${seat + 1}`])));
    assert.deepEqual(stacks(state), [900, 800, 700, 600, 500, 400, 300, 200, 100]);
    assert.equal(toView(state).result.pots.at(-1).label, 'Side pot 7');
  });

  test('a player folding after reaching two all in levels leaves chips in three layers', () => {
    // Ann opens 300, Ben calls all in 100, Cal calls all in 200, Dee makes it 600, Ann folds.
    // Dee's top 300 went unmatched and return. Totals 300, 100, 200, 300.
    // Main 4 x 100 = 400 for Ben, Cal, Dee. Side 1 is 3 x 100 = 300 for Cal, Dee.
    // Side 2 is 2 x 100 = 200, Ann's dead chips and Dee's, which only Dee can win.
    let state = table([1000, 100, 200, 1000], { dealer: 1 });
    assertTurn(state, A);
    state = play(state, raise(300));
    assertTurn(state, B);
    assertLegal(state, { call: 100, allIn: 100 });
    state = play(state, call);
    assertTurn(state, C);
    assertLegal(state, { call: 195, allIn: 200 });
    state = play(state, call);
    assertTurn(state, D);
    assertLegal(state, { call: 290, raise: { min: 590, max: 1000 }, allIn: 1000 });
    state = play(state, raise(600));
    assertTurn(state, A);
    state = play(state, fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [700, 0, 0, 700]);
    assert.deepEqual(committed(state), [300, 100, 200, 300]);
    assert.deepEqual(statuses(state), ['folded', 'allIn', 'allIn', 'active']);
    assertPots(state, [[400, [B, C, D]], [300, [C, D]], [200, [D]]]);

    const showdown = play(state, deal, deal, deal);
    assertShowdown(showdown);
    for (const action of [award([B], [C]), award([B], [C], []), award([B], [C], [D])]) {
      const paid = play(showdown, action);
      assert.deepEqual(stacks(paid), [700, 400, 300, 900]);
    }
  });

  test('a folder between two levels does not split the pot above them', () => {
    // Everyone is at 100 and Ann is all in. Flop: Ben 50, Cal calls, Dee makes it 100, Ben calls,
    // Cal folds. Totals 100, 200, 150, 200. Cal's 150 sets no level, so there is one side pot:
    // 100 + 50 + 100 = 250. Taking Cal's total as a level would wrongly split it in two.
    let state = table([100, 1000, 1000, 1000]);
    state = play(state, call, allIn, call, call, call);
    assertClosed(state, 'flop');
    assertPots(state, [[400, [A, B, C, D]]]);
    state = play(state, deal);
    assertTurn(state, B);
    state = play(state, bet(50), call, raise(100));
    assertTurn(state, B);
    assertLegal(state, { call: 50, raise: { min: 150, max: 900 }, allIn: 900 });
    state = play(state, call);
    assertTurn(state, C);
    state = play(state, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [0, 800, 850, 800]);
    assert.deepEqual(committed(state), [100, 200, 150, 200]);
    assertPots(state, [[400, [A, B, D]], [250, [B, D]]]);
  });

  test('two players all in for the same amount share one level', () => {
    // Cal 200, Dee calls, both blinds all in for 100. Main 400, side 200, and no empty pot.
    let state = table([100, 100, 1000, 1000], { dealer: 3 });
    assertTurn(state, C);
    state = play(state, raise(200), call, call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 0, 800, 800]);
    assertPots(state, [[400, [A, B, C, D]], [200, [C, D]]]);
  });

  test('an all in called exactly leaves no empty side pot', () => {
    const state = play(table([100, 1000]), allIn, call);
    assertPots(state, [[200, [A, B]]]);
  });

  test('all ins on different streets stack up in order', () => {
    // Preflop everyone reaches 100 and Ann is all in. Flop: Ben shoves his last 200, Cal calls,
    // Dee folds. Totals 100, 300, 300, 100. Main 400 for Ann, Ben, Cal. Side 400 for Ben, Cal.
    let state = table([100, 300, 1000, 1000], { dealer: 3 });
    state = play(state, call, call, allIn, call, call, call);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [0, 200, 900, 900]);
    state = play(state, deal);
    assertTurn(state, B);
    state = play(state, allIn);
    assertTurn(state, C);
    assertLegal(state, { call: 200, raise: { min: 400, max: 900 }, allIn: 900 });
    state = play(state, call);
    assertTurn(state, D);
    state = play(state, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [0, 0, 700, 900]);
    assertPots(state, [[400, [A, B, C]], [400, [B, C]]]);
    state = play(state, deal, deal);
    assertShowdown(state);
    state = play(state, award([A], [C]));
    assert.deepEqual(stacks(state), [400, 0, 1100, 900]);
  });

  test('side betting across streets adds to one side pot, not a new one each street', () => {
    // Ann all in 100 preflop. Ben and Cal bet 50 on the flop and 80 on the turn.
    // Totals 100, 230, 230. Main 300, side 130 + 130 = 260.
    let state = table([100, 1000, 1000]);
    state = play(state, allIn, call, call, deal);
    assertTurn(state, B);
    state = play(state, bet(50), call, deal);
    assertTurn(state, B);
    state = play(state, bet(80), call);
    assertClosed(state, 'river');
    assertPots(state, [[300, [A, B, C]], [260, [B, C]]]);
    state = play(state, deal, check, check);
    assertShowdown(state);
    assertPots(state, [[300, [A, B, C]], [260, [B, C]]]);
  });

  test('a side pot bet folded to comes back and the all in player still reaches showdown', () => {
    // Ann all in 100, Ben and Cal call. Flop: Ben bets 200, Cal folds. Ben's 200 return, so one
    // pot of 300 for Ann and Ben. Two players remain, so it is not a fold out.
    let state = table([100, 1000, 1000]);
    state = play(state, allIn, call, call, deal, bet(200), fold);
    assertClosed(state, 'turn');
    assert.deepEqual(stacks(state), [0, 900, 900]);
    assertPots(state, [[300, [A, B]]]);
    state = play(state, deal, deal);
    assertShowdown(state);
    state = play(state, award([A]));
    assert.deepEqual(stacks(state), [300, 900, 900]);
    assert.equal(toView(state).result.foldOut, false);
  });

  test('chips a folded player put in above the top level go to the top pot', () => {
    // No legal hand gets here because uncalled chips come back first, so this edits the totals
    // of a real showdown. Levels 100 and 200. Cal's 300 fill both, and his last 100 sit above the
    // top level. Main 3 x 100 = 300, then 100 + 100 + the dead 100 = 300 for Ben.
    const showdown = play(table([100, 200, 300]), allIn, allIn, call, deal, deal, deal);
    const state = {
      ...showdown,
      players: showdown.players.map((player, seat) => ({
        ...player,
        committed: [100, 200, 300][seat],
        status: seat === 2 ? 'folded' : 'allIn',
      })),
    };
    assertPots(state, [[300, [A, B]], [300, [B]]]);
  });
});

describe('split pots and odd chips', () => {
  test('the odd chip goes to the first winner left of the dealer, not to the dealer', () => {
    // Ann limps, Ben folds 5, Cal checks. Pot 25 split between Ann (dealer) and Cal.
    // Clockwise from Ann: Ben, Cal, Ann. So Cal 13, Ann 12.
    let state = table([1000, 1000, 1000]);
    state = checkDown(play(state, call, fold, check));
    assertPots(state, [[25, [A, C]]]);
    for (const winners of [[A, C], [C, A]]) {
      const paid = play(state, award(winners));
      assert.deepEqual(stacks(paid), [1002, 995, 1003]);
      assert.deepEqual(payouts(paid), [12, 0, 13]);
      assert.deepEqual(toView(paid).result.pots[0].shares, { [A]: 12, [C]: 13 });
    }
  });

  test('the dealer need not be a winner', () => {
    // Dee limps, Ann folds, Ben folds 5, Cal checks. Pot 25 for Cal and Dee.
    // Clockwise from Ann: Ben, Cal, Dee. So Cal 13, Dee 12.
    let state = table([1000, 1000, 1000, 1000]);
    state = checkDown(play(state, call, fold, fold, check));
    state = play(state, award([D, C]));
    assert.deepEqual(stacks(state), [1000, 995, 1003, 1002]);
  });

  test('two odd chips go one at a time around the table', () => {
    // Dee and Ann limp, Ben folds 5, Cal checks. Pot 35 split three ways: 11 each and 2 left.
    // Clockwise from Ann: Cal, Dee, then Ann. So Cal 12, Dee 12, Ann 11.
    let state = table([1000, 1000, 1000, 1000]);
    state = checkDown(play(state, call, call, fold, check));
    state = play(state, award([A, C, D]));
    assert.deepEqual(stacks(state), [1001, 995, 1002, 1002]);
    assert.deepEqual(toView(state).result.pots[0].shares, { [A]: 11, [C]: 12, [D]: 12 });
  });

  test('the order wraps past the last seat, so seat number does not decide it', () => {
    // Cal deals, Dee small, Ann big, Ben under the gun. All in for 10.
    // Flop: Dee 15, Ann and Ben call, Cal folds. Turn: Dee 10, Ann calls, Ben folds.
    // Totals A 35, B 25, C 10, D 35, pot 105 for Ann and Dee: 52 each with 1 over.
    // Clockwise from Cal: Dee, Ann. So Dee 53 and Ann 52, though Ann has the lower seat.
    let state = table([1000, 1000, 1000, 1000], { dealer: 2 });
    assertTurn(state, B);
    state = play(state, call, call, call, check, deal);
    assertTurn(state, D);
    state = play(state, bet(15), call, call, fold, deal);
    assertTurn(state, D);
    state = play(state, bet(10), call, fold, deal, check, check);
    assertShowdown(state);
    assertPots(state, [[105, [A, D]]]);
    state = play(state, award([A, D]));
    assert.deepEqual(stacks(state), [1017, 975, 990, 1018]);
  });

  test('the order counts from the dealer of that hand, so it moves with the button', () => {
    // Ben deals, Cal small, Dee big, Ann under the gun. Ann and Ben limp, Cal folds, Dee checks.
    // Pot 35 for Ann and Dee. Clockwise from Ben: Cal, Dee, Ann. So Dee 18, Ann 17.
    let state = table([1000, 1000, 1000, 1000], { dealer: 1 });
    assertTurn(state, A);
    state = checkDown(play(state, call, call, fold, check));
    state = play(state, award([A, D]));
    assert.deepEqual(stacks(state), [1007, 990, 995, 1008]);
  });

  test('a busted seat is passed over when counting from the dealer', () => {
    // Ben has no chips. Ann deals, Cal small, Dee big, and Ann opens. Cal folds 5. Pot 25.
    // Clockwise from Ann: Ben (out), Cal (folded), Dee. So Dee 13, Ann 12.
    let state = table([1000, 0, 1000, 1000]);
    assert.equal(toView(state).smallBlindId, C);
    assert.equal(toView(state).bigBlindId, D);
    assertTurn(state, A);
    state = checkDown(play(state, call, fold, check));
    state = play(state, award([A, D]));
    assert.deepEqual(stacks(state), [1002, 0, 995, 1003]);
  });

  test('main and side pots each settle their own odd chip from the dealer', () => {
    // Ben deals, Cal small, Dee big, Eli under the gun. Ann has 31.
    // Preflop: Eli 31, Ann calls all in, Ben folds, Cal and Dee call. Four at 31.
    // Flop: Cal 15, Dee and Eli call. Turn: Cal 20, Dee folds, Eli calls. River checks through.
    // Totals A 31, B 0, C 66, D 46, E 66.
    // Main 4 x 31 = 124 for Ann, Cal, Eli. Side 35 + 15 + 35 = 85 for Cal, Eli.
    // Clockwise from Ben: Cal, Dee, Eli, Ann, Ben.
    // Main splits 41 each with 1 over, to Cal: Cal 42, Eli 41, Ann 41.
    // Side splits 42 each with 1 over, to Cal: Cal 43, Eli 42.
    let state = table([31, 1000, 1000, 1000, 1000], { dealer: 1 });
    assertTurn(state, E);
    state = play(state, raise(31), call, fold, call, call, deal);
    assertTurn(state, C);
    state = play(state, bet(15), call, call, deal);
    assertTurn(state, C);
    state = play(state, bet(20), fold, call, deal);
    assertTurn(state, C);
    state = play(state, check);
    assertTurn(state, E);
    state = play(state, check);
    assertShowdown(state);
    assert.deepEqual(committed(state), [31, 0, 66, 46, 66]);
    assertPots(state, [[124, [A, C, E]], [85, [C, E]]]);

    state = play(state, award([A, C, E], [C, E]));
    assert.deepEqual(stacks(state), [41, 1000, 1019, 954, 1017]);
    assert.deepEqual(payouts(state), [41, 0, 85, 0, 83]);
    const [main, side] = toView(state).result.pots;
    assert.deepEqual(main.shares, { [A]: 41, [C]: 42, [E]: 41 });
    assert.deepEqual(side.shares, { [C]: 43, [E]: 42 });
  });

  test('an even split of a side pot with a different winner set in each pot', () => {
    // Totals 100, 200, 200. Main 300 goes to Ann alone, side 200 splits evenly.
    let state = table([100, 200, 300]);
    state = play(state, allIn, allIn, call, deal, deal, deal, award([A], [B, C]));
    assert.deepEqual(stacks(state), [300, 100, 200]);
  });
});

describe('busted players', () => {
  test('a busted seat is skipped for the button, both blinds and the action', () => {
    // Dee and Ann fold, Ben shoves, Cal calls and loses. Stacks 100, 200, 0, 100.
    // Next hand: button Ben, then Cal is empty, so Dee small and Ann big. Ben opens.
    let state = table([100, 100, 100, 100]);
    state = play(state, fold, fold, allIn, call, deal, deal, deal, award([B]));
    assert.deepEqual(stacks(state), [100, 200, 0, 100]);

    state = play(state, nextHand);
    let view = toView(state);
    assert.equal(view.dealerId, B);
    assert.equal(view.smallBlindId, D);
    assert.equal(view.bigBlindId, A);
    assert.deepEqual(statuses(state), ['active', 'active', 'out', 'active']);
    assert.deepEqual(stacks(state), [90, 200, 0, 95]);
    assertTurn(state, B);

    state = play(state, call);
    assertTurn(state, D);
    state = play(state, call);
    assertTurn(state, A);
    state = play(state, check, deal);
    assertTurn(state, D);
    state = play(state, check);
    assertTurn(state, A);
    state = play(state, check);
    assertTurn(state, B);
    state = checkDown(play(state, check));
    state = play(state, award([B]));
    assert.deepEqual(stacks(state), [90, 220, 0, 90]);

    // The button walks past the empty seat to Dee, and wraps to Ann and Ben for the blinds.
    state = play(state, nextHand);
    view = toView(state);
    assert.equal(view.dealerId, D);
    assert.equal(view.smallBlindId, A);
    assert.equal(view.bigBlindId, B);
    assertTurn(state, D);
  });

  test('two players busting at once takes the button past both', () => {
    // Dee shoves, Ann folds, Ben and Cal call all in. Dee wins 300.
    // Next hand: heads up, Dee on the button and small blind, Ann big.
    let state = table([100, 100, 100, 100]);
    state = play(state, allIn, fold, call, call, deal, deal, deal);
    assertPots(state, [[300, [B, C, D]]]);
    state = play(state, award([D]));
    assert.deepEqual(stacks(state), [100, 0, 0, 300]);

    state = play(state, nextHand);
    const view = toView(state);
    assert.equal(view.dealerId, D);
    assert.equal(view.smallBlindId, D);
    assert.equal(view.bigBlindId, A);
    assert.deepEqual(stacks(state), [90, 0, 0, 295]);
    assert.deepEqual(statuses(state), ['active', 'out', 'out', 'active']);
    assertTurn(state, D);
  });

  test('the game ends when one player has all the chips, and only endGame leaves', () => {
    let state = table([100, 100, 100]);
    state = play(state, allIn, call, call, deal, deal, deal, award([A]));
    const view = toView(state);
    assert.equal(view.phase, 'gameOver');
    assert.equal(view.gameWinnerId, A);
    assert.deepEqual(stacks(state), [300, 0, 0]);
    assert.deepEqual(statuses(state).slice(1), ['out', 'out']);
    assert.deepEqual(toView(state).pots, []);
    assertRejected(state, nextHand);
    assertRejected(state, deal);
    assertRejected(state, award([A]));

    state = play(state, endGame);
    assert.equal(toView(state).phase, 'lobby');
    assert.equal(toView(state).handNumber, 0);
    assert.equal(toView(state).gameWinnerId, null);
    assert.equal(toView(state).smallBlindId, null);
    assert.deepEqual(stacks(state), [100, 100, 100]);
    assert.deepEqual(statuses(state), ['active', 'active', 'active']);
    assert.deepEqual(committed(state), [0, 0, 0]);
    assert.deepEqual(seats(state, 'name'), ['Ann', 'Ben', 'Cal']);
  });

  test('a split all in leaves both players alive and the game running', () => {
    let state = play(table([100, 100]), allIn, call, deal, deal, deal, award([A, B]));
    assert.equal(toView(state).phase, 'handComplete');
    assert.equal(toView(state).gameWinnerId, null);
    assert.deepEqual(stacks(state), [100, 100]);
    state = play(state, nextHand);
    assert.equal(toView(state).dealerId, B);
  });

  test('a player down to 1 chip posts it as the blind and is all in', () => {
    // Ben is the big blind for 1 chip heads up. Ann's small blind of 5 is cut back to 1.
    const state = table([1000, 1], { dealer: 0 });
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [999, 0]);
    assert.deepEqual(bets(state), [1, 1]);
    assertPots(state, [[2, [A, B]]]);
  });
});

describe('everyone all in', () => {
  test('all three in preflop: the dealer taps each street and nobody acts', () => {
    let state = play(table([100, 100, 100]), allIn, call, call);
    assertClosed(state, 'flop');
    assert.equal(toView(state).street, 'preflop');
    assert.deepEqual(bets(state), [100, 100, 100]);
    assert.deepEqual(toView(state).pot, { total: 300, collected: 0 });

    state = play(state, deal);
    assertClosed(state, 'turn');
    assert.equal(toView(state).street, 'flop');
    assert.deepEqual(bets(state), [0, 0, 0]);
    assert.deepEqual(toView(state).pot, { total: 300, collected: 300 });

    state = play(state, deal);
    assertClosed(state, 'river');
    assert.equal(toView(state).street, 'turn');

    state = play(state, deal);
    assertShowdown(state);
    assert.equal(toView(state).street, 'river');
    assertPots(state, [[300, [A, B, C]]]);
  });

  test('exactly one player with chips left: still no betting on any street', () => {
    // Cal covers the others and has 100 behind, but nobody is left for him to bet into.
    let state = play(table([100, 200, 300]), allIn, allIn, call);
    assert.deepEqual(stacks(state), [0, 0, 100]);
    for (const nextStreet of ['flop', 'turn', 'river']) {
      assertClosed(state, nextStreet);
      state = play(state, deal);
    }
    assertShowdown(state);
    assert.deepEqual(stacks(state), [0, 0, 100]);
  });

  test('all in on the flop leaves two taps', () => {
    let state = play(table([100, 100]), call, check, deal, allIn, call);
    assertClosed(state, 'turn');
    state = play(state, deal);
    assertClosed(state, 'river');
    state = play(state, deal);
    assertShowdown(state);
    assertPots(state, [[200, [A, B]]]);
  });

  test('all in on the turn leaves one tap', () => {
    let state = play(table([100, 100]), call, check, deal, check, check, deal, allIn, call);
    assertClosed(state, 'river');
    state = play(state, deal);
    assertShowdown(state);
  });

  test('all in on the river needs no tap at all', () => {
    let state = play(table([100, 100]), call, check, deal, check, check, deal, check, check);
    state = play(state, deal, allIn, call);
    assertShowdown(state);
  });

  test('two blinds all in and the third player folded: no action, just the runout', () => {
    // Ann folds. Ben posted all in 5, Cal posted all in 10. Cal's top 5 come back.
    let state = play(table([1000, 5, 10]), fold);
    assertClosed(state, 'flop');
    assert.deepEqual(stacks(state), [1000, 0, 5]);
    assert.deepEqual(bets(state), [0, 5, 5]);
    assert.deepEqual(statuses(state), ['folded', 'allIn', 'active']);
    state = play(state, deal, deal, deal);
    assertShowdown(state);
    assertPots(state, [[10, [B, C]]]);
  });

  test('two players with chips keep betting beside an all in player', () => {
    // Ann is all in 100. Flop opens on Ben and his bet of 20 needs Cal's answer.
    let state = play(table([100, 1000, 1000]), allIn, call, call, deal);
    assertTurn(state, B);
    assertLegal(state, { check: true, bet: { min: 10, max: 900 }, allIn: 900 });
    state = play(state, bet(20));
    assertTurn(state, C);
    assertLegal(state, { call: 20, raise: { min: 40, max: 900 }, allIn: 900 });
  });

  test('a fold that leaves one player with chips stops the betting mid street', () => {
    // Ann all in 100, Ben and Cal at 100. Flop: Ben folds, so Cal has nobody to bet into and
    // never gets a turn, even though he has not acted on this street.
    let state = play(table([100, 1000, 1000]), allIn, call, call, deal, fold);
    assertClosed(state, 'turn');
    assert.deepEqual(bets(state), [0, 0, 0]);
    assertPots(state, [[300, [A, C]]]);
  });
});

describe('undo', () => {
  const seated = (names = ['Alice', 'Bob', 'Cara'], options) => {
    const session = createSession();
    if (options) session.dispatch({ type: 'setOptions', ...options }, session.version);
    for (const name of names) session.dispatch({ type: 'addPlayer', name }, session.version);
    return session;
  };
  const send = (session, ...actions) => {
    for (const action of actions) session.dispatch(action, session.version);
  };
  const undo = (session) => session.undo(session.version);

  test('every step of a hand unwinds to the exact view it came from, down to the lobby', () => {
    const session = seated();
    const script = [
      startGame,
      call,
      call,
      check,
      deal,
      check,
      bet(30),
      call,
      fold,
      deal,
      bet(100),
      fold,
      award(),
      nextHand,
      raise(40),
      fold,
      fold,
      award(),
      nextHand,
      call,
      fold,
      check,
      endGame,
    ];
    const history = [];
    for (const action of script) {
      history.push(session.view);
      send(session, action);
    }
    assert.equal(session.view.phase, 'lobby');
    while (history.length > 0) {
      assert.equal(session.canUndo, true);
      undo(session);
      assert.deepEqual(session.view, history.pop());
    }
    assert.equal(session.view.phase, 'lobby');
    assert.equal(session.canUndo, false);
    assert.equal(session.undoLabel, null);
    assert.throws(() => undo(session), { code: 'nothing-to-undo' });
  });

  test('undo after startGame goes back to the lobby with nothing posted', () => {
    const session = seated();
    assert.equal(session.version, 3);
    send(session, startGame);
    assert.equal(session.version, 4);
    assert.equal(session.canUndo, true);
    undo(session);
    assert.equal(session.version, 5);
    const { view } = session;
    assert.equal(view.phase, 'lobby');
    assert.equal(view.handNumber, 0);
    assert.deepEqual(view.pots, []);
    assert.deepEqual(view.pot, { total: 0, collected: 0 });
    assert.deepEqual(view.players.map((player) => player.stack), [1000, 1000, 1000]);
    assert.deepEqual(view.players.map((player) => player.bet), [0, 0, 0]);
    assert.equal(session.canUndo, false);
    send(session, { type: 'addPlayer', name: 'Dan' });
    send(session, startGame);
    assert.equal(session.view.players.length, 4);
  });

  test('undo across a street change puts the bets back on the table', () => {
    // Bob's call closes the flop, then the tap collects it. Undo the tap, then the call.
    const session = seated(['Alice', 'Bob']);
    send(session, startGame, call, check, deal, bet(50), call);
    const closed = session.view;
    assert.equal(closed.phase, 'streetClosed');
    assert.equal(closed.nextStreet, 'turn');
    send(session, deal);
    assert.equal(session.view.street, 'turn');
    assert.deepEqual(session.view.players.map((player) => player.bet), [0, 0]);

    undo(session);
    assert.deepEqual(session.view, closed);
    assert.deepEqual(session.view.players.map((player) => player.bet), [50, 50]);

    undo(session);
    assert.equal(session.view.phase, 'betting');
    assert.equal(session.view.street, 'flop');
    assert.equal(session.view.actingId, session.view.dealerId);
    assert.equal(session.view.legal.call, 50);
  });

  test('undoing the fold that ended a hand brings back the refunded bet and the turn', () => {
    const session = seated();
    send(session, startGame, call, call, check, deal, bet(100), fold, fold);
    assert.equal(session.view.phase, 'showdown');
    assert.equal(session.view.players[1].stack, 990);
    undo(session);
    assert.equal(session.view.phase, 'betting');
    assert.equal(session.view.actingId, A);
    assert.equal(session.view.players[1].stack, 890);
    assert.equal(session.view.players[1].bet, 100);
    assert.equal(session.view.legal.call, 100);
  });

  test('undoing award takes the chips back and lets a different winner be chosen', () => {
    const session = seated(['Alice', 'Bob']);
    send(session, startGame, call, check, deal, check, check, deal, check, check, deal);
    send(session, check, check);
    assert.equal(session.view.phase, 'showdown');
    send(session, award([A]));
    assert.deepEqual(session.view.players.map((player) => player.stack), [1010, 990]);
    undo(session);
    assert.equal(session.view.phase, 'showdown');
    assert.equal(session.view.result, null);
    assert.deepEqual(session.view.players.map((player) => player.payout), [0, 0]);
    assert.deepEqual(session.view.players.map((player) => player.stack), [990, 990]);
    send(session, award([B]));
    assert.deepEqual(session.view.players.map((player) => player.stack), [990, 1010]);
  });

  test('undoing nextHand moves the dealer chip back and restores the result', () => {
    const session = seated();
    send(session, startGame, fold, fold, award());
    const finished = session.view;
    assert.equal(finished.phase, 'handComplete');
    send(session, nextHand);
    assert.equal(session.view.dealerId, B);
    assert.equal(session.view.handNumber, 2);
    undo(session);
    assert.deepEqual(session.view, finished);
    assert.equal(session.view.dealerId, A);
  });

  test('undoing the award that ended the game un-ends it, busted players and all', () => {
    const session = seated(['Alice', 'Bob'], { startingChips: 100, smallBlind: 5, bigBlind: 10 });
    send(session, startGame, allIn, call, deal, deal, deal);
    const showdown = session.view;
    send(session, award([A]));
    assert.equal(session.view.phase, 'gameOver');
    assert.equal(session.view.gameWinnerId, A);
    undo(session);
    assert.deepEqual(session.view, showdown);
    assert.equal(session.view.gameWinnerId, null);
    send(session, award([B]));
    assert.equal(session.view.gameWinnerId, B);
  });

  test('undoing endGame puts the running hand back', () => {
    const session = seated();
    send(session, startGame, raise(30));
    const running = session.view;
    send(session, endGame);
    assert.equal(session.view.phase, 'lobby');
    undo(session);
    assert.deepEqual(session.view, running);
  });

  test('the undo label names what comes off next, and follows undo backwards', () => {
    const session = seated(['Alice', 'Bob']);
    send(session, startGame);
    send(session, raise(40));
    assert.equal(session.undoLabel, 'Alice raised to 40');
    send(session, fold);
    const afterFold = session.undoLabel;
    assert.equal(typeof afterFold, 'string');
    assert.notEqual(afterFold, 'Alice raised to 40');
    undo(session);
    assert.equal(session.undoLabel, 'Alice raised to 40');
  });

  test('describeAction talks about the state before the action', () => {
    const state = table([1000, 1000]);
    assert.equal(describeAction(state, raise(40)), 'Ann raised to 40');
  });

  test('describeAction says what an all in really was, so undo labels do not mislead', () => {
    // Over the bet it is a raise to the whole stack.
    assert.match(describeAction(table([1000, 1000]), allIn), /^Ann raised to 1,000/);
    // With no bet on the street it is a bet.
    const flop = play(table([100, 100]), call, check, deal);
    assert.match(describeAction(flop, allIn), /^Ben bet 90/);
    // For less than the call it is a call of what the player has, not of what was owed.
    const faced = play(table([1000, 70], { dealer: 0 }), call, check, deal, check, bet(100));
    assert.match(describeAction(faced, allIn), /^Ben called 60/);
    assert.match(describeAction(faced, call), /^Ben called 60/);
  });

  test('every lobby edit clears undo', () => {
    const edits = [
      { type: 'addPlayer', name: 'Dan' },
      { type: 'removePlayer', id: C },
      { type: 'movePlayer', id: B, direction: 1 },
      { type: 'setDealer', id: B },
      { type: 'setOptions', startingChips: 500, smallBlind: 5, bigBlind: 10 },
    ];
    for (const edit of edits) {
      const session = seated();
      send(session, startGame, endGame);
      assert.equal(session.canUndo, true);
      send(session, edit);
      assert.equal(session.canUndo, false, edit.type);
      assert.equal(session.undoLabel, null, edit.type);
    }
  });

  test('a lobby edit that fails leaves undo alone', () => {
    const session = seated();
    send(session, startGame, endGame);
    const { version, undoLabel } = session;
    assert.throws(() => send(session, { type: 'addPlayer', name: 'BOB' }));
    assert.equal(session.canUndo, true);
    assert.equal(session.undoLabel, undoLabel);
    assert.equal(session.version, version);
  });

  test('a version mismatch is stale and changes nothing', () => {
    const session = seated(['Alice', 'Bob']);
    send(session, startGame);
    const { view, version } = session;
    assert.throws(() => session.dispatch(fold, version - 1), { code: 'stale' });
    assert.throws(() => session.dispatch(fold, version + 1), { code: 'stale' });
    assert.throws(() => session.undo(version - 1), { code: 'stale' });
    assert.equal(session.version, version);
    assert.deepEqual(session.view, view);
    assert.equal(session.canUndo, true);
  });

  test('a refused action does not bump the version or add to the undo stack', () => {
    const session = seated(['Alice', 'Bob']);
    send(session, startGame);
    const { version, undoLabel } = session;
    assert.throws(() => send(session, raise(19)), { code: 'bad-amount' });
    assert.equal(session.version, version);
    assert.equal(session.undoLabel, undoLabel);
  });

  test('the undo stack stops at 300 and lands on the action 300 back', () => {
    // Heads up with a folding small blind keeps both players alive indefinitely. Each hand is
    // three undoable actions after the start.
    const session = seated(['Alice', 'Bob']);
    send(session, startGame);
    const views = [];
    for (let hand = 0; hand < 110; hand += 1) {
      for (const action of [fold, award(), nextHand]) {
        views.push(session.view);
        send(session, action);
      }
    }
    assert.equal(views.length, 330);
    for (let count = 0; count < 300; count += 1) {
      assert.equal(session.canUndo, true);
      undo(session);
      assert.deepEqual(session.view, views.pop());
    }
    assert.equal(session.canUndo, false);
    assert.throws(() => undo(session), { code: 'nothing-to-undo' });
  });

  test('a saved session resumes mid hand with its whole undo history', () => {
    const session = seated();
    send(session, startGame, raise(30), allIn);
    const saved = JSON.parse(JSON.stringify(session.serialize()));
    const restored = createSession(saved);
    assert.equal(restored.version, session.version);
    assert.deepEqual(restored.view, session.view);
    assert.equal(restored.undoLabel, session.undoLabel);

    // The short all in rule must survive the save: both sessions play the same from here.
    for (const each of [session, restored]) send(each, fold);
    assert.deepEqual(restored.view, session.view);
    undo(restored);
    undo(restored);
    assert.equal(restored.view.actingId, B);
    assert.equal(restored.view.legal.call, 25);
  });

  test('editing a view or a saved copy cannot reach the game', () => {
    const session = seated();
    send(session, startGame, fold, fold, award());
    const before = structuredClone(session.view);

    const view = session.view;
    view.players[0].stack = 1;
    view.options.bigBlind = 1;
    view.result.pots[0].shares[C] = 1;
    view.result.pots[0].winnerIds.push(A);
    const saved = session.serialize();
    saved.state.players[0].stack = 1;
    saved.history[0].state.phase = 'gameOver';

    assert.deepEqual(session.view, before);
    undo(session);
    undo(session);
    undo(session);
    undo(session);
    assert.equal(session.view.phase, 'lobby');
  });

  test('a damaged save starts a fresh game rather than a broken one', () => {
    const session = seated();
    send(session, startGame, raise(30));
    const good = () => JSON.parse(JSON.stringify(session.serialize()));

    const extraChips = good();
    extraChips.state.players[0].stack += 1;
    const badPhase = good();
    badPhase.state.phase = 'nonsense';
    const nobodyActing = good();
    nobodyActing.state.actingId = 'p9';
    const badVersion = good();
    badVersion.version = -1;

    for (const saved of [extraChips, badPhase, nobodyActing, badVersion, null, {}, 7]) {
      const restored = createSession(saved);
      assert.equal(restored.view.phase, 'lobby');
      assert.equal(restored.view.players.length, 0);
      assert.equal(restored.version, 0);
    }
  });

  test('a damaged undo entry costs the history and leaves the game alone', () => {
    const session = seated();
    send(session, startGame, raise(30));
    const saved = JSON.parse(JSON.stringify(session.serialize()));
    saved.history[0].state.players[0].stack += 1;

    const restored = createSession(saved);
    assert.equal(restored.version, session.version);
    assert.deepEqual(restored.view, session.view);
    assert.equal(restored.canUndo, false);
  });
});

describe('lastAction', () => {
  test('names each move, with all in standing in for the move that took the last chip', () => {
    // Ann deals, Ben small, Cal big, Dee opens.
    let state = table([1000, 1000, 1000, 1000]);
    assert.deepEqual(lastActions(state), [null, 'sb', 'bb', null]);
    state = play(state, call);
    assert.deepEqual(lastActions(state), [null, 'sb', 'bb', 'call']);
    state = play(state, raise(30));
    assert.deepEqual(lastActions(state), ['raise', 'sb', 'bb', 'call']);
    state = play(state, fold);
    assert.deepEqual(lastActions(state), ['raise', 'fold', 'bb', 'call']);
    state = play(state, call, call, deal);
    assertTurn(state, C);
    state = play(state, check);
    assert.equal(lastActions(state)[2], 'check');
    state = play(state, bet(50));
    assert.equal(lastActions(state)[3], 'bet');
    state = play(state, allIn);
    assert.equal(lastActions(state)[0], 'allIn');
  });

  test('a blind that takes the last chip still shows as the blind', () => {
    const state = table([1000, 1000, 4]);
    assert.deepEqual(lastActions(state), [null, 'sb', 'bb']);
    assert.equal(statuses(state)[2], 'allIn');
  });

  test('a call of the whole stack is an all in', () => {
    const state = play(table([1000, 1000, 1000, 7]), call);
    assert.equal(lastActions(state)[3], 'allIn');
    assert.equal(statuses(state)[3], 'allIn');
  });
});

describe('the view contract', () => {
  const VIEW = [
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
  const PLAYER = [
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
  const keys = (value) => Object.keys(value).sort();

  test('a new game is an empty lobby with the default options', () => {
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

  test('every phase shows exactly the fields the spec lists and nothing private', () => {
    let state = applyAction(createGame(), { type: 'addPlayer', name: 'Ann' });
    state = applyAction(state, { type: 'addPlayer', name: 'Ben' });
    const toRiver = [startGame, call, check, deal, check, check, deal, check, check, deal];
    for (const action of [...toRiver, check, check, award([A]), nextHand, fold, award(), endGame]) {
      state = applyAction(state, action);
      const view = toView(state);
      assert.deepEqual(keys(view), VIEW, view.phase);
      for (const player of view.players) assert.deepEqual(keys(player), PLAYER, view.phase);
      for (const pot of view.pots) assert.deepEqual(keys(pot), ['amount', 'eligibleIds', 'label']);
      assert.deepEqual(keys(view.pot), ['collected', 'total']);
      if (view.legal) {
        assert.deepEqual(keys(view.legal), ['allIn', 'bet', 'call', 'check', 'fold', 'raise']);
      }
      if (view.result) {
        assert.deepEqual(keys(view.result), ['foldOut', 'pots']);
        for (const pot of view.result.pots) {
          assert.deepEqual(keys(pot), ['amount', 'label', 'shares', 'winnerIds']);
        }
      }
    }
  });
});

describe('rejected actions', () => {
  const phases = {
    lobby: () => {
      let state = applyAction(createGame(), { type: 'addPlayer', name: 'Ann' });
      state = applyAction(state, { type: 'addPlayer', name: 'Ben' });
      return state;
    },
    betting: () => table([1000, 1000]),
    streetClosed: () => play(table([1000, 1000]), call, check),
    showdown: () => play(table([1000, 1000]), fold),
    handComplete: () => play(table([1000, 1000]), fold, award()),
    gameOver: () => play(table([100, 100]), allIn, call, deal, deal, deal, award([A])),
  };
  const everyAction = [
    [{ type: 'addPlayer', name: 'Zed' }, 'lobby'],
    [{ type: 'removePlayer', id: B }, 'lobby'],
    [{ type: 'movePlayer', id: B, direction: -1 }, 'lobby'],
    [{ type: 'setDealer', id: B }, 'lobby'],
    [{ type: 'setOptions', startingChips: 500, smallBlind: 1, bigBlind: 2 }, 'lobby'],
    [startGame, 'lobby'],
    [fold, 'betting'],
    [call, 'betting'],
    [allIn, 'betting'],
    [raise(20), 'betting'],
    [deal, 'streetClosed'],
    [award([B]), 'showdown'],
    [nextHand, 'handComplete'],
  ];

  for (const [phase, build] of Object.entries(phases)) {
    for (const [action, home] of everyAction) {
      if (home === phase) continue;
      test(`${action.type} is refused in ${phase}`, () => {
        assertRejected(build(), action);
      });
    }
  }

  test('check and bet are refused outside betting', () => {
    for (const [phase, build] of Object.entries(phases)) {
      if (phase === 'betting') continue;
      assertRejected(build(), check);
      assertRejected(build(), bet(20));
    }
  });

  test('endGame works from every running phase and is refused in the lobby', () => {
    assertRejected(phases.lobby(), endGame);
    for (const [phase, build] of Object.entries(phases)) {
      if (phase === 'lobby') continue;
      const ended = applyAction(build(), endGame);
      assert.equal(toView(ended).phase, 'lobby', `from ${phase}`);
    }
  });

  test('an action with no real type is refused', () => {
    const state = table([1000, 1000]);
    for (const action of [{}, { type: 'shove' }, { type: 'constructor' }, { type: 'toString' }]) {
      assertRejected(state, action);
    }
    assertRejected(state, null);
    assertRejected(state, undefined);
  });

  test('amounts must be whole numbers inside the legal range', () => {
    const state = table([1000, 1000]);
    const bad = [19, 1001, 0, -20, 20.5, NaN, Infinity, -Infinity, '20', null, undefined, [20], {}];
    for (const to of bad) assertRejected(state, { type: 'raise', to });

    const flop = play(state, call, check, deal);
    for (const to of [9, 991, 0, -10, 10.5, NaN, Infinity, '10', null, undefined]) {
      assertRejected(flop, { type: 'bet', to });
    }
  });

  test('a bet needs no bet on the street and a raise needs one', () => {
    const preflop = table([1000, 1000]);
    assertRejected(preflop, bet(20));
    const flop = play(preflop, call, check, deal);
    assertRejected(flop, raise(20));
    const facing = play(flop, bet(10));
    assertRejected(facing, bet(30));
  });

  test('check is refused when there is a bet and call is refused when there is none', () => {
    const preflop = table([1000, 1000]);
    assertRejected(preflop, check);
    const option = play(preflop, call);
    assertRejected(option, call);
  });

  test('a stack too short for the minimum cannot use bet or raise, only all in', () => {
    // Ann 30. Ben has 40 and the minimum is 50. Asking for 40 through raise is refused.
    const state = play(table([1000, 40, 1000]), raise(30));
    assertRejected(state, raise(40));
    assertRejected(state, raise(50));
    play(state, allIn);
  });

  test('nothing can be raised or shoved once nobody could answer it', () => {
    // Heads up, Ann is all in for 500 and Ben has 1000. Ben may only call or fold.
    const state = play(table([500, 1000]), allIn);
    assertTurn(state, B);
    assertLegal(state, { call: 490 });
    assertRejected(state, raise(1000));
    assertRejected(state, allIn);
  });

  test('no raise when opponents hold chips but none of them can get past the bet', () => {
    // Dee deals, Ann small, Ben big, Cal shoves 400. Ann can reach 100 and Ben 250, so neither
    // can put in a chip over 400 and anything Dee raised would come straight back to her.
    const state = play(table([100, 250, 400, 1000], { dealer: 3 }), allIn);
    assertTurn(state, D);
    assertLegal(state, { call: 400 });
    assertRejected(state, raise(790));
    assertRejected(state, allIn);

    // With 401 Ben can go one chip past 400, so Dee may raise. Cal raised by 390: minimum 790.
    const answerable = play(table([100, 401, 400, 1000], { dealer: 3 }), allIn);
    assertTurn(answerable, D);
    assertLegal(answerable, { call: 400, raise: { min: 790, max: 1000 }, allIn: 1000 });
  });

  describe('award', () => {
    const contested = () => play(table([100, 200, 300]), allIn, allIn, call, deal, deal, deal);
    const foldOut = () => play(table([1000, 1000, 1000]), fold, fold);

    test('a winner must be eligible for that pot', () => {
      assertRejected(contested(), award([A], [A]));
      assertRejected(contested(), award([A], ['p9']));
      assertRejected(contested(), award(['nobody'], [B]));
    });

    test('every contested pot needs a winner', () => {
      assertRejected(contested(), award());
      assertRejected(contested(), award([A]));
      assertRejected(contested(), award([A], []));
      assertRejected(contested(), award([], [B]));
      assertRejected(contested(), { type: 'award' });
      assertRejected(contested(), { type: 'award', pots: null });
    });

    test('a folded player cannot win, even a single eligible pot', () => {
      assertRejected(foldOut(), award([A]));
      assertRejected(foldOut(), award([B]));
    });

    test('malformed picks are refused', () => {
      assertRejected(contested(), award([A, A], [B]));
      assertRejected(contested(), award([A], [B], [C]));
      assertRejected(contested(), { type: 'award', pots: 'p1' });
      assertRejected(contested(), { type: 'award', pots: [A, B] });
      assertRejected(contested(), { type: 'award', pots: [{}, [B]] });
    });

    test('a single eligible pot can be left empty, omitted or named', () => {
      const expected = [1000, 995, 1005];
      assert.deepEqual(stacks(play(foldOut(), award())), expected);
      assert.deepEqual(stacks(play(foldOut(), award([]))), expected);
      assert.deepEqual(stacks(play(foldOut(), award([C]))), expected);
    });
  });

  describe('lobby rules', () => {
    test('the limits are 2 to 9 players', () => {
      assert.equal(MIN_PLAYERS, 2);
      assert.equal(MAX_PLAYERS, 9);
      let state = createGame();
      assertRejected(state, startGame);
      state = applyAction(state, { type: 'addPlayer', name: 'One' });
      assertRejected(state, startGame);
      for (let count = 2; count <= 9; count += 1) {
        state = applyAction(state, { type: 'addPlayer', name: `Player ${count}` });
      }
      assert.equal(toView(state).players.length, 9);
      assertRejected(state, { type: 'addPlayer', name: 'Ten' });
      assert.equal(toView(applyAction(state, startGame)).phase, 'betting');
    });

    test('names are trimmed, 1 to 16 characters and unique ignoring case', () => {
      let state = applyAction(createGame(), { type: 'addPlayer', name: '  Ann  ' });
      assert.equal(toView(state).players[0].name, 'Ann');
      assertRejected(state, { type: 'addPlayer', name: 'ANN' });
      assertRejected(state, { type: 'addPlayer', name: '   ' });
      assertRejected(state, { type: 'addPlayer', name: '' });
      assertRejected(state, { type: 'addPlayer', name: 'x'.repeat(17) });
      assertRejected(state, { type: 'addPlayer', name: 42 });
      assertRejected(state, { type: 'addPlayer' });
      state = applyAction(state, { type: 'addPlayer', name: 'x'.repeat(16) });
      assert.equal(toView(state).players.length, 2);
    });

    test('options must be positive whole numbers in a sensible order', () => {
      const state = phases.lobby();
      const bad = [
        [0, 5, 10],
        [1000, 0, 10],
        [1000, 5, 0],
        [1000, -5, 10],
        [1000, 5.5, 10],
        [1000, '5', 10],
        [1000, 20, 10],
        [5, 1, 10],
        [undefined, 5, 10],
      ];
      for (const [startingChips, smallBlind, bigBlind] of bad) {
        assertRejected(state, { type: 'setOptions', startingChips, smallBlind, bigBlind });
      }
    });

    test('new options reach players already seated', () => {
      let state = phases.lobby();
      state = applyAction(state, {
        type: 'setOptions',
        startingChips: 500,
        smallBlind: 10,
        bigBlind: 20,
      });
      assert.deepEqual(stacks(state), [500, 500]);
      state = applyAction(state, startGame);
      assert.deepEqual(stacks(state), [490, 480]);
    });

    test('the dealer falls back to the first player and follows a chosen player', () => {
      let state = phases.lobby();
      assert.equal(toView(state).dealerId, A);
      state = applyAction(state, { type: 'setDealer', id: B });
      assert.equal(toView(state).dealerId, B);
      state = applyAction(state, { type: 'removePlayer', id: B });
      assert.equal(toView(state).dealerId, A);
      assertRejected(state, { type: 'setDealer', id: 'p9' });
      assertRejected(state, { type: 'removePlayer', id: 'p9' });
    });

    test('ids are never reused', () => {
      let state = phases.lobby();
      state = applyAction(state, { type: 'removePlayer', id: B });
      state = applyAction(state, { type: 'addPlayer', name: 'Cal' });
      assert.deepEqual(toView(state).players.map((player) => player.id), [A, C]);
    });

    test('seats follow the player order', () => {
      let state = phases.lobby();
      state = applyAction(state, { type: 'movePlayer', id: B, direction: -1 });
      assert.deepEqual(toView(state).players.map(({ id, seat }) => [id, seat]), [[B, 0], [A, 1]]);
    });

    const threeSeated = () => applyAction(phases.lobby(), { type: 'addPlayer', name: 'Cal' });

    test('moving goes one seat each way and stops at the ends', () => {
      let state = threeSeated();
      state = applyAction(state, { type: 'movePlayer', id: A, direction: 1 });
      assert.deepEqual(seats(state, 'id'), [B, A, C]);
      state = applyAction(state, { type: 'movePlayer', id: C, direction: -1 });
      assert.deepEqual(seats(state, 'id'), [B, C, A]);
      assertRejected(state, { type: 'movePlayer', id: B, direction: -1 });
      assertRejected(state, { type: 'movePlayer', id: A, direction: 1 });
      for (const direction of [0, 2, -2, '1', null, undefined]) {
        assertRejected(state, { type: 'movePlayer', id: C, direction });
      }
      assertRejected(state, { type: 'movePlayer', id: 'p9', direction: 1 });
    });

    test('the chosen dealer stays chosen through a move and through removing someone else', () => {
      const chosen = applyAction(threeSeated(), { type: 'setDealer', id: B });
      const moved = applyAction(chosen, { type: 'movePlayer', id: B, direction: -1 });
      assert.equal(toView(moved).dealerId, B);
      // Ben is not in the first seat here, so a fallback to the first player would show.
      const removed = applyAction(chosen, { type: 'removePlayer', id: C });
      assert.equal(toView(removed).dealerId, B);
    });
  });
});

// Plays random legal hands with short and uneven stacks, which is where the side rules collide.
describe('random play', () => {
  const generator = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

  function assertSettled(state) {
    const players = toView(state).players;
    const live = players.filter(({ status }) => status === 'active' || status === 'allIn');
    const street = players.map(({ bet: amount }) => amount).sort((a, b) => b - a);
    assert.equal(street[0], street[1], 'an uncalled bet was left on the table');
    for (const player of live) {
      if (player.status === 'active') assert.equal(player.bet, street[0], `${player.name} short`);
    }
    const totals = players.map(({ committed: amount }) => amount).sort((a, b) => b - a);
    assert.equal(totals[0], totals[1], 'uncalled chips were left in the pot');
  }

  function pickWager(view, random) {
    const { legal } = view;
    const range = legal.bet ?? legal.raise;
    const type = legal.bet ? 'bet' : 'raise';
    const options = [];
    if (legal.check) options.push(check, check, check);
    if (legal.call > 0) options.push(call, call, call);
    options.push(fold);
    if (range) {
      const span = range.max - range.min;
      options.push({ type, to: range.min }, { type, to: range.max });
      options.push({ type, to: range.min + Math.floor(random() * (span + 1)) });
    }
    if (legal.allIn !== null) options.push(allIn);
    return options[Math.floor(random() * options.length)];
  }

  function pickWinners(view, random) {
    return view.pots.map(({ eligibleIds }) => {
      if (eligibleIds.length === 1) return [];
      const winners = eligibleIds.filter(() => random() < 0.4);
      return winners.length > 0 ? winners : [eligibleIds[0]];
    });
  }

  const clockwise = (view) => {
    const start = view.players.findIndex(({ id }) => id === view.dealerId) + 1;
    return view.players.map((_, i) => view.players[(start + i) % view.players.length].id);
  };

  // Payouts without any pots: given a ranking of hands, each player in turn claims every chip they
  // can reach and nobody has claimed yet. A player's chips are claimed from the bottom up, and a
  // winner reaches only as high as their own total. The pots must give the same answer.
  function assertPotsPayLikeRanking(state, random) {
    const view = toView(state);
    const ranking = view.players
      .filter(({ status }) => status === 'active' || status === 'allIn')
      .map(({ id }) => ({ id, sort: random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ id }) => id);
    const claimed = new Map(view.players.map(({ id }) => [id, 0]));
    const expected = Object.fromEntries(view.players.map(({ id }) => [id, 0]));
    for (const id of ranking) {
      const own = view.players.find((player) => player.id === id).committed;
      for (const other of view.players) {
        const take = Math.max(0, Math.min(own, other.committed) - claimed.get(other.id));
        claimed.set(other.id, claimed.get(other.id) + take);
        expected[id] += take;
      }
    }
    assert.equal(sum(Object.values(expected)), view.pot.total, 'chips nobody can win');
    const best = ({ eligibleIds }) => [ranking.find((id) => eligibleIds.includes(id))];
    const paid = toView(applyAction(state, award(...view.pots.map(best))));
    const payoutsById = paid.players.map(({ id, payout }) => [id, payout]);
    assert.deepEqual(Object.fromEntries(payoutsById), expected);
  }

  function assertSharesFollowDealer(view) {
    const order = clockwise(view);
    for (const pot of view.result.pots) {
      const winners = order.filter((id) => pot.winnerIds.includes(id));
      const share = Math.floor(pot.amount / winners.length);
      const odd = pot.amount - share * winners.length;
      const expected = winners.map((id, i) => [id, share + (i < odd ? 1 : 0)]);
      assert.deepEqual(pot.shares, Object.fromEntries(expected));
    }
  }

  function assertButtonMoved(before, after) {
    const order = clockwise(before).filter((id) => {
      return before.players.find((player) => player.id === id).stack > 0;
    });
    const adjusted = order.length === 2 && order[1] === before.bigBlindId;
    const dealerId = order[adjusted ? 1 : 0];
    assert.equal(after.dealerId, dealerId, 'the button goes to the next player with chips');
    assert.equal(before.nextDealerId, dealerId, 'the view names that player in advance');
    assert.notEqual(after.bigBlindId, before.bigBlindId, 'nobody posts the big blind twice running');
    const fromDealer = adjusted ? order : [...order.slice(1), order[0]];
    const [small, big] = fromDealer.length === 2 ? [fromDealer[1], fromDealer[0]] : fromDealer;
    assert.equal(after.smallBlindId, small);
    assert.equal(after.bigBlindId, big);
    for (const player of after.players) {
      assert.equal(player.status === 'out', before.players[player.seat].stack === 0);
    }
  }

  test('no line breaks an invariant, across a thousand short stacked games', () => {
    for (let seed = 1; seed <= 1000; seed += 1) {
      const random = generator(seed);
      const count = 2 + Math.floor(random() * 8);
      const piles = Array.from({ length: count }, () => {
        const shape = random();
        if (shape < 0.3) return 1 + Math.floor(random() * 12);
        if (shape < 0.7) return 13 + Math.floor(random() * 60);
        return 73 + Math.floor(random() * 400);
      });
      const total = sum(piles);
      let state = table(piles, { dealer: Math.floor(random() * count) });

      for (let step = 0; step < 400; step += 1) {
        const view = toView(state);
        assert.equal(chipsInPlay(state), total, `seed ${seed}`);
        if (view.phase === 'gameOver') break;
        if (view.phase === 'streetClosed' || view.phase === 'showdown') assertSettled(state);
        if (view.phase === 'showdown') assertPotsPayLikeRanking(state, random);
        let action = nextHand;
        if (view.phase === 'betting') action = pickWager(view, random);
        if (view.phase === 'streetClosed') action = deal;
        if (view.phase === 'showdown') action = award(...pickWinners(view, random));
        state = play(state, action);
        const after = toView(state);
        if (view.phase === 'showdown') assertSharesFollowDealer(after);
        if (view.phase === 'handComplete') assertButtonMoved(view, after);
      }
    }
  });

  test('sessions survive random undo and restore without losing a step', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = generator(seed);
      let session = createSession();
      const dispatch = (action) => session.dispatch(action, session.version);
      const startingChips = 20 + Math.floor(random() * 200);
      dispatch({ type: 'setOptions', startingChips, smallBlind: 5, bigBlind: 10 });
      const count = 2 + Math.floor(random() * 8);
      for (let seat = 0; seat < count; seat += 1) {
        dispatch({ type: 'addPlayer', name: NAMES[seat] });
      }

      const views = [];
      for (let step = 0; step < 250; step += 1) {
        const before = session.view;
        const dice = random();
        if (dice < 0.2 && views.length > 0) {
          session.undo(session.version);
          assert.deepEqual(session.view, views.pop(), `seed ${seed}`);
          continue;
        }
        if (dice < 0.25) {
          session = createSession(JSON.parse(JSON.stringify(session.serialize())));
          assert.deepEqual(session.view, before, `seed ${seed}`);
          assert.equal(session.canUndo, views.length > 0, `seed ${seed}`);
        }
        const actions = {
          lobby: startGame,
          betting: before.legal && pickWager(before, random),
          streetClosed: deal,
          showdown: award(...pickWinners(before, random)),
          handComplete: nextHand,
          gameOver: endGame,
        };
        views.push(before);
        dispatch(actions[before.phase]);
        const { players, pot } = session.view;
        const chips = sum(players.map(({ stack }) => stack)) + pot.total;
        assert.equal(chips, count * startingChips, `seed ${seed} step ${step}`);
      }
    }
  });
});
