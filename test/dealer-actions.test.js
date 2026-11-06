import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActions } from '../public/js/dealer-actions.js';
import { trackKeyboard } from '../public/js/dealer-dom.js';
import { createLobby } from '../public/js/dealer-lobby.js';
import { addChipsJob, setStackJob, steppedAmount } from '../public/js/dealer-sheet.js';
import { isRepeatTap } from '../public/js/dealer-table.js';

const failure = (code, message = code) => Object.assign(new Error(message), { code });

function actions({ request = async () => {}, online = true } = {}) {
  const notices = [];
  const sent = [];
  let version = 7;
  const api = createActions({
    request(message) {
      sent.push(message);
      return request(message, () => {
        version += 1;
      });
    },
    version: () => version,
    isOnline: () => online,
    onChange() {},
    onSend() {},
    onError: (message) => notices.push(message),
  });
  return { api, notices, sent };
}

test('a tap that may or may not have landed says so, whichever way the link was lost', async () => {
  for (const code of ['timeout', 'disconnected']) {
    const { api, notices } = actions({ request: () => Promise.reject(failure(code)) });
    assert.equal(await api.dispatch({ type: 'fold' }), false);
    assert.deepEqual(notices, ['No reply. Check the wall, then try again.']);
  }
});

test('a stale tap stays quiet, because fresh state is already on its way', async () => {
  const { api, notices } = actions({ request: () => Promise.reject(failure('stale')) });
  assert.equal(await api.dispatch({ type: 'fold' }), false);
  assert.deepEqual(notices, []);
});

test('a refused action shows the reason it was given', async () => {
  const request = () => Promise.reject(failure('bad-amount', 'The amount must be from 40 to 500.'));
  const { api, notices } = actions({ request });
  await api.dispatch({ type: 'raise', to: 1 });
  assert.deepEqual(notices, ['The amount must be from 40 to 500.']);
});

test('steps run in order, each with the version the last one produced', async () => {
  const { api, sent } = actions({ request: async (_message, advance) => advance() });
  assert.equal(await api.dispatch({ type: 'setOptions' }, { type: 'startGame' }), true);
  assert.deepEqual(sent.map(({ version }) => version), [7, 8]);
});

test('nothing leaves the phone while it is offline or waiting on a reply', async () => {
  const offline = actions({ online: false });
  assert.equal(await offline.api.dispatch({ type: 'fold' }), false);
  assert.deepEqual(offline.sent, []);

  let finish;
  const busy = actions({ request: () => new Promise((resolve) => (finish = resolve)) });
  const first = busy.api.dispatch({ type: 'fold' });
  assert.equal(await busy.api.dispatch({ type: 'fold' }), false);
  assert.equal(busy.sent.length, 1);
  finish();
  assert.equal(await first, true);
});

test('busy means the short lock, which being offline is not', async () => {
  const offline = actions({ online: false });
  assert.equal(offline.api.isLocked(), true);
  assert.equal(offline.api.isBusy(), false);

  let finish;
  const waiting = actions({ request: () => new Promise((resolve) => (finish = resolve)) });
  const first = waiting.api.dispatch({ type: 'fold' });
  assert.equal(waiting.api.isBusy(), true);
  finish();
  await first;
  assert.equal(waiting.api.isBusy(), false);

  const guarded = actions();
  guarded.api.guard(5);
  assert.equal(guarded.api.isBusy(), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(guarded.api.isBusy(), false);
});

test('a busted player is offered a rebuy of the starting chips', () => {
  const game = { options: { startingChips: 1000, bigBlind: 20 } };
  const job = addChipsJob(game, { id: 'p3', stack: 0 });
  assert.equal(job.start, 1000);
  assert.equal(job.confirmLabel(1000), 'Rebuy 1,000');
  assert.equal(job.describe(1000), 'Stack becomes 1,000');
  assert.deepEqual(job.action(1000), { type: 'addChips', id: 'p3', amount: 1000 });
  assert.deepEqual(
    job.presets.map(({ to }) => to),
    [500, 1000, 2000],
  );
});

test('a player with chips adds to them', () => {
  const game = { options: { startingChips: 1000, bigBlind: 20 } };
  const job = addChipsJob(game, { id: 'p1', stack: 1500 });
  assert.equal(job.confirmLabel(500), 'Add 500');
  assert.equal(job.describe(500), 'Stack becomes 2,000');
  assert.equal(job.confirmLabel(null), 'Add');
});

test('half a buy-in of odd chips rounds up, so it is never zero', () => {
  const job = addChipsJob({ options: { startingChips: 1, bigBlind: 1 } }, { id: 'p1', stack: 5 });
  assert.equal(job.presets[0].to, 1);
});

test('a correction starts from the stack, and only a change can be confirmed', () => {
  const job = setStackJob({ options: { bigBlind: 20 } }, { id: 'p2', stack: 95 });
  assert.equal(job.start, 95);
  assert.equal(job.accepts(95), false);
  assert.equal(job.accepts(0), true);
  assert.equal(job.range.min, 0);
  assert.equal(job.describe(150), 'Adds 55');
  assert.equal(job.describe(40), 'Takes away 55');
  assert.equal(job.confirmLabel(150), 'Set stack to 150');
  assert.deepEqual(job.action(0), { type: 'setStack', id: 'p2', stack: 0 });
});

test('the raise stepper starts from what was typed, in range or not', () => {
  const stepped = (value, direction) =>
    steppedAmount(value, direction, { min: 20, max: 1000 }, 10);
  assert.equal(stepped('500', -1), 490);
  assert.equal(stepped('1001', -1), 991);
  assert.equal(stepped('5000', 1), 1000);
  assert.equal(stepped('5000', -1), 1000);
  assert.equal(stepped('99999999999999999999', -1), 1000);
  assert.equal(stepped('15', 1), 25);
  assert.equal(stepped('20', -1), 20);
});

test('the raise stepper copes with what a dot can leave in the field', () => {
  const stepped = (value, direction) =>
    steppedAmount(value, direction, { min: 20, max: 1000 }, 10);
  assert.equal(stepped('12.5', 1), 22);
  assert.equal(stepped('1.2.3', 1), 30);
  assert.equal(stepped('.', 1), 30);
  assert.equal(stepped('', 1), 30);
});

function fakeNode() {
  const listeners = new Map();
  return {
    value: '',
    addEventListener: (type, run) => listeners.set(type, run),
    fire: (type, event) => listeners.get(type)?.(event),
    replaceChildren() {},
    toggleAttribute() {},
  };
}

// The lobby with no players, enough of a page to reach its chip fields, and the clock under test.
function lobby(t, { isBusy = () => false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.document);
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeNode());
    return nodes.get(selector);
  };
  globalThis.document = { activeElement: null, querySelector: node };
  const saves = [];
  const page = { hidden: 0 };
  const view = createLobby({
    actions: { isBusy, dispatch: (...edits) => saves.push(...edits) },
    hideNotice: () => (page.hidden += 1),
  });
  view.render({ players: [], options: { startingChips: 1000, smallBlind: 5, bigBlind: 10 } });
  const field = { small: node('#small-blind'), big: node('#big-blind') };
  const focus = (next) => (document.activeElement = next);
  const leave = (next = null) => {
    focus(next);
    node('.options').fire('focusout');
    t.mock.timers.tick(250);
  };
  const type = (target, value) => {
    target.value = value;
    target.fire('input', { target });
  };
  return { field, focus, leave, page, saves, tick: (ms) => t.mock.timers.tick(ms), type, view };
}

test('blinds raised in field order are not refused on the way', (t) => {
  const { field, leave, saves, type } = lobby(t);
  type(field.small, '50');
  leave(field.big);
  assert.deepEqual(saves, [], 'still in the chip fields, so 50 / 10 is only halfway');
  type(field.big, '100');
  leave();
  assert.deepEqual(saves, [
    { type: 'setOptions', startingChips: 1000, smallBlind: 50, bigBlind: 100 },
  ]);
});

test('leaving a chip field unchanged after editing another still saves', (t) => {
  const { field, leave, saves, type } = lobby(t);
  type(field.small, '8');
  leave(field.big);
  leave();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].smallBlind, 8);
});

test('the tap that left the field and locked the buttons does not cost the save', (t) => {
  let locked = true;
  const { field, leave, saves, tick, type } = lobby(t, { isBusy: () => locked });
  type(field.big, '20');
  leave();
  tick(1000);
  assert.deepEqual(saves, []);
  locked = false;
  tick(250);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].bigBlind, 20);
});

test('a save the lock delayed still waits if focus has come back to a chip field', (t) => {
  let locked = true;
  const { field, focus, leave, saves, tick, type } = lobby(t, { isBusy: () => locked });
  type(field.small, '50');
  leave();
  focus(field.big);
  locked = false;
  tick(250);
  assert.deepEqual(saves, []);
  type(field.big, '100');
  leave();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].bigBlind, 100);
});

test('a save left waiting goes no further once the lobby has gone', (t) => {
  let locked = true;
  const { field, leave, page, saves, tick, type, view } = lobby(t, { isBusy: () => locked });
  type(field.big, '20');
  leave();
  view.root.hidden = true;
  locked = false;
  tick(250);
  assert.deepEqual(saves, []);
  assert.equal(page.hidden, 0);
});

test('with nothing to save there is nothing to wait for, so a later notice is left alone', (t) => {
  let locked = true;
  const { leave, page, tick } = lobby(t, { isBusy: () => locked });
  leave();
  assert.equal(page.hidden, 1);
  locked = false;
  tick(5000);
  assert.equal(page.hidden, 1);
});

test('a save that cannot go out is dropped, not retried', (t) => {
  const { field, leave, saves, tick, type } = lobby(t);
  type(field.big, '20');
  leave();
  tick(5000);
  assert.equal(saves.length, 1);
});

test('a refused value put back clears the notice, wherever focus went', (t) => {
  const { field, leave, page, saves, type } = lobby(t);
  type(field.big, '3');
  leave();
  assert.equal(saves.length, 1);
  assert.equal(page.hidden, 0);
  type(field.big, '10');
  leave(field.small);
  assert.equal(page.hidden, 1);
  assert.equal(saves.length, 1, 'the server already has this, so nothing goes out');
});

test('the chip fields keep a dot for the engine to refuse, and lose what pastes bring', (t) => {
  const { field, leave, saves, type } = lobby(t);
  type(field.big, '10.5');
  assert.equal(field.big.value, '10.5');
  leave();
  assert.equal(saves[0].bigBlind, 10.5);
  type(field.big, '2,500');
  assert.equal(field.big.value, '2500');
});

function keyboardPage(t, height) {
  t.after(() => {
    delete globalThis.document;
    delete globalThis.window;
  });
  const viewport = Object.assign(new EventTarget(), { height, scale: 1, offsetTop: 0 });
  const classes = new Set();
  const scrolls = [];
  const reveals = [];
  globalThis.window = {
    visualViewport: viewport,
    innerHeight: height,
    scrollTo: (x, y) => scrolls.push([x, y]),
  };
  globalThis.document = {
    activeElement: null,
    addEventListener() {},
    documentElement: {
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, on = !classes.has(name)) =>
          on ? classes.add(name) : classes.delete(name),
      },
      style: { setProperty() {} },
    },
  };
  trackKeyboard();
  return {
    isOpen: () => classes.has('keyboard-open'),
    scrolls,
    reveals,
    move(next, type = 'resize') {
      Object.assign(viewport, next);
      viewport.dispatchEvent(new Event(type));
    },
    focus(isField) {
      document.activeElement = {
        matches: () => isField,
        scrollIntoView: (options) => reveals.push(options),
      };
    },
  };
}

test('a keyboard that opens slowly still leaves the field in view', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  assert.deepEqual(page.reveals, []);
  page.move({ height: 395 });
  assert.deepEqual(page.reveals, [{ block: 'nearest' }]);
});

test('only a change of size moves the field, not Safari panning the page', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  page.move({ height: 395 });
  page.move({ offsetTop: 100 }, 'scroll');
  assert.equal(page.reveals.length, 1);
});

test('with no keyboard there is no field to keep in view', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(false);
  page.move({ height: 395 });
  assert.deepEqual(page.reveals, []);
});

test('the keyboard is seen when Safari pans the page and innerHeight falls with it', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  window.innerHeight = 404;
  page.move({ height: 395, offsetTop: 295 });
  assert.equal(page.isOpen(), true);
  window.innerHeight = 449;
  page.move({ offsetTop: 250 }, 'scroll');
  assert.equal(page.isOpen(), true);
  assert.deepEqual(page.scrolls, []);
});

test('blur closes the keyboard layout and scrolls the page back', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  page.move({ height: 395, offsetTop: 295 });
  page.focus(false);
  window.innerHeight = 699;
  page.move({ height: 699, offsetTop: 0 });
  assert.equal(page.isOpen(), false);
  assert.deepEqual(page.scrolls, [[0, 0]]);
});

test('a page that shrinks with no field focused is not a keyboard', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(false);
  window.innerHeight = 500;
  page.move({ height: 500 });
  assert.equal(page.isOpen(), false);
  page.focus(true);
  page.move({ height: 300 });
  assert.equal(page.isOpen(), true, 'and the keyboard is measured from the smaller page');
  page.move({ height: 400 });
  assert.equal(page.isOpen(), false, 'so a short bar on the smaller page is not one');
});

test('a page taller than any seen so far is no sign the keyboard went', (t) => {
  const page = keyboardPage(t, 326);
  page.focus(true);
  window.innerHeight = 259;
  page.move({ height: 87, offsetTop: 67 });
  assert.equal(page.isOpen(), true);
  window.innerHeight = 699;
  page.move({ height: 427, offsetTop: 0 });
  assert.equal(page.isOpen(), true, 'turned to portrait with the keys still up');
  assert.deepEqual(page.scrolls, []);
  page.focus(false);
  page.move({ height: 699 });
  assert.equal(page.isOpen(), false);
  assert.deepEqual(page.scrolls, [[0, 0]]);
});

test('the keyboard stays seen when the phone turns to landscape with the page panned', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  window.innerHeight = 404;
  page.move({ height: 395, offsetTop: 295 });
  window.innerHeight = 59;
  page.move({ height: 41, offsetTop: 221 });
  assert.equal(page.isOpen(), true);
  window.innerHeight = 280;
  page.move({ height: 9, offsetTop: 0 });
  assert.equal(page.isOpen(), true);
  assert.deepEqual(page.scrolls, []);
});

test('nothing focused is never a keyboard, even before the first focus', (t) => {
  const page = keyboardPage(t, 699);
  assert.equal(page.isOpen(), false);
  page.move({ height: 300 });
  assert.equal(page.isOpen(), false);
});

test('pinching in a field is not a keyboard', (t) => {
  const page = keyboardPage(t, 699);
  page.focus(true);
  page.move({ height: 300, scale: 1.8 });
  assert.equal(page.isOpen(), false);
});

test('the second half of a double tap counts for nothing, wherever it lands', () => {
  const first = { x: 100, y: 300, at: 1000, listMoved: false };
  const repeat = (x, y, ms) => isRepeatTap(first, { x, y, at: first.at + ms });
  assert.equal(repeat(100, 300, 220), true);
  assert.equal(repeat(112, 324, 220), true, 'a thumb drifts, even onto the next button');
  assert.equal(repeat(100, 300, 580), true, 'as slow as Safari still calls a double tap');
  assert.equal(repeat(100, 300, 700), false, 'by now it is a tap to take the pick back');
});

test('a quick tap on another winner counts when nothing has moved', () => {
  const first = { x: 100, y: 300, at: 1000, listMoved: false };
  assert.equal(isRepeatTap(first, { x: 280, y: 300, at: 1200 }), false);
  assert.equal(isRepeatTap(first, { x: 100, y: 364, at: 1200 }), false);
});

test('once a pick has moved the list, a quick tap anywhere was aimed at someone else', () => {
  const first = { x: 100, y: 300, at: 1000, listMoved: true };
  assert.equal(isRepeatTap(first, { x: 280, y: 300, at: 1400 }), true);
  assert.equal(isRepeatTap(first, { x: 280, y: 300, at: 1700 }), false, 'time to have looked');
});

test('the first pick of a showdown is never a repeat', () => {
  const none = { x: 0, y: 0, at: -Infinity, listMoved: false };
  assert.equal(isRepeatTap(none, { x: 3, y: 3, at: 5 }), false);
});
