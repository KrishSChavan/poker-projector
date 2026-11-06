// The sheet for typing an amount: Bet or Raise during a hand, and chips between hands. Each comes
// in as a job, which says what the amount means. Raise amounts are "to" totals, the same as the
// engine, and it opens filled in, so the commonest raise is two taps and the keyboard only comes
// up when asked for.

import { $, chips, fitText, h, shortChips } from './dealer-dom.js';

const OPEN_GUARD_MS = 450;
const CLOSE_GUARD_MS = 300;
const BIG_FONT_PX = 34;
// Below 16px iPhones zoom the page when the field is tapped.
const SMALL_FONT_PX = 16;
const DIGIT_WIDTH_EM = 0.68;

// The engine has the real limit, and a typing slip that large is refused there.
const ANY_CHIPS = Number.MAX_SAFE_INTEGER;

// A pot sized raise calls first, then raises by the pot as it would then stand. Real chips make
// a small blind the smallest useful step, so that is what the presets round to.
export function raisePresets({ legal, pot, options }, player, range) {
  const callLevel = player.bet + legal.call;
  const potAfterCall = pot.total + legal.call;
  const sized = (fraction) => {
    const units = Math.round((callLevel + potAfterCall * fraction) / options.smallBlind);
    return Math.min(range.max, Math.max(range.min, units * options.smallBlind));
  };
  return [
    { label: 'Min', to: range.min },
    { label: '1/2 pot', to: sized(1 / 2) },
    { label: 'Pot', to: sized(1) },
    { label: 'All in', to: range.max },
  ];
}

// Steps from what is typed even when it is out of range, so 1,001 corrects to 991, not back to the
// minimum. The field can hold a dot or two: 12.5 steps from 12, and 1.2.3 from the minimum.
export function steppedAmount(value, direction, { min, max }, step) {
  const typed = Math.trunc(Number(value));
  const base = value !== '' && Number.isFinite(typed) ? typed : min;
  return Math.min(max, Math.max(min, base + direction * step));
}

function raiseJob(game, player) {
  const kind = game.legal.raise ? 'raise' : 'bet';
  const range = game.legal[kind];
  const name = kind === 'raise' ? 'Raise' : 'Bet';
  return {
    title: player.name,
    info: `To call ${chips(game.legal.call)}, stack ${chips(player.stack)}`,
    label: kind === 'raise' ? 'Raise to' : 'Bet',
    range,
    step: game.options.bigBlind,
    start: range.min,
    presets: raisePresets(game, player, range),
    describe(to) {
      if (to === null) return `From ${chips(range.min)} to ${chips(range.max)}`;
      const added = to - player.bet;
      return `Adds ${chips(added)}, leaves ${chips(player.stack - added)}`;
    },
    confirmLabel(to) {
      if (to === null) return name;
      const total = kind === 'raise' ? `Raise to ${chips(to)}` : `Bet ${chips(to)}`;
      return to === range.max ? `${total}, all in` : total;
    },
    action: (to) => ({ type: kind, to }),
  };
}

export function addChipsJob({ options }, player) {
  const { startingChips, bigBlind } = options;
  const verb = player.stack === 0 ? 'Rebuy' : 'Add';
  return {
    title: player.name,
    info: `Stack ${chips(player.stack)}`,
    label: verb,
    range: { min: 1, max: ANY_CHIPS },
    step: bigBlind,
    start: startingChips,
    presets: [
      { label: 'Half', to: Math.ceil(startingChips / 2) },
      { label: 'Buy-in', to: startingChips },
      { label: 'Double', to: startingChips * 2 },
    ],
    describe: (to) =>
      to === null ? 'Whole chips, above zero' : `Stack becomes ${chips(player.stack + to)}`,
    confirmLabel: (to) => (to === null ? verb : `${verb} ${chips(to)}`),
    action: (amount) => ({ type: 'addChips', id: player.id, amount }),
  };
}

export function setStackJob({ options }, player) {
  return {
    title: player.name,
    info: `Stack ${chips(player.stack)}`,
    label: 'New stack',
    range: { min: 0, max: ANY_CHIPS },
    step: options.bigBlind,
    start: player.stack,
    presets: [],
    accepts: (to) => to !== player.stack,
    describe(to) {
      if (to === null) return 'Type what they really have';
      const change = to - player.stack;
      return change > 0 ? `Adds ${chips(change)}` : `Takes away ${chips(-change)}`;
    },
    confirmLabel: (to) => (to === null ? 'Set stack' : `Set stack to ${chips(to)}`),
    action: (stack) => ({ type: 'setStack', id: player.id, stack }),
  };
}

const CHIP_JOBS = { add: addChipsJob, set: setStackJob };

export function createAmountSheet({ actions, onChange }) {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  const field = $('#amount');
  const confirm = $('#sheet-confirm');
  const note = $('#amount-note');
  const failure = $('#sheet-error');
  const presetRow = $('#presets');
  const modes = $('#sheet-modes');
  let open = null;
  let chipTarget = null;

  function amount() {
    const value = Number(field.value);
    const { min, max } = open.range;
    const fits = field.value !== '' && Number.isSafeInteger(value) && value >= min && value <= max;
    return fits && (open.accepts?.(value) ?? true) ? value : null;
  }

  function fieldFont() {
    const fits = field.clientWidth / (Math.max(field.value.length, 1) * DIGIT_WIDTH_EM);
    const size = Math.max(SMALL_FONT_PX, Math.min(BIG_FONT_PX, fits));
    field.style.fontSize = `${Math.floor(size)}px`;
  }

  function refresh() {
    const to = amount();
    confirm.firstElementChild.textContent = open.confirmLabel(to);
    confirm.toggleAttribute('data-off', to === null);
    note.textContent = open.describe(to);
    note.classList.toggle('bad', to === null && field.value !== String(open.start));
    fieldFont();
    for (const node of presetRow.children) {
      node.setAttribute('aria-pressed', String(Number(node.dataset.to) === to));
    }
    fitText(sheet);
    onChange();
  }

  function setAmount(to) {
    field.value = to;
    failure.hidden = true;
    refresh();
  }

  function step(direction) {
    setAmount(steppedAmount(field.value, direction, open.range, open.step));
  }

  function presetButton({ label, to }) {
    return h(
      'button',
      {
        type: 'button',
        class: 'preset',
        'data-lock': true,
        'data-to': to,
        'data-preset': label,
        click: () => setAmount(to),
      },
      h('span', { class: 'preset-label' }, label),
      h('span', { class: 'preset-value', 'data-fit': true }, shortChips(to)),
    );
  }

  function show(job) {
    open = job;
    $('#sheet-title').textContent = job.title;
    $('#sheet-info').textContent = job.info;
    $('#amount-label').textContent = job.label;
    presetRow.replaceChildren(...job.presets.map(presetButton));
    presetRow.hidden = job.presets.length === 0;
    presetRow.style.setProperty('--presets', job.presets.length);
    failure.hidden = true;
    sheet.hidden = false;
    scrim.hidden = false;
    setAmount(job.start);
  }

  function showChipMode(mode) {
    for (const node of modes.children) {
      node.setAttribute('aria-pressed', String(node.dataset.mode === mode));
    }
    show(CHIP_JOBS[mode](...chipTarget));
  }

  function close(guard = true) {
    if (open === null) return;
    open = null;
    chipTarget = null;
    field.blur();
    sheet.hidden = true;
    scrim.hidden = true;
    if (guard) actions.guard(CLOSE_GUARD_MS);
  }

  async function submit(event) {
    event.preventDefault();
    const to = amount();
    if (to === null || actions.isLocked()) return;
    failure.hidden = true;
    await actions.dispatch(open.action(to));
  }

  // The dot stays so 12.5 is refused, instead of the digits closing up into 125.
  function keepDigits() {
    field.value = field.value.replace(/[^\d.]/g, '');
    failure.hidden = true;
    refresh();
  }

  sheet.addEventListener('submit', submit);
  sheet.addEventListener('mousedown', (event) => {
    // Tapping a button here must not close the keyboard and slide the sheet out from under it.
    if (event.target !== field) event.preventDefault();
  });
  field.addEventListener('input', keepDigits);
  field.addEventListener('focus', () => field.select());
  // A name high on the page opens this with the scrim under the finger, so the second half of a
  // double tap lands there, and would shut what the first half opened.
  scrim.addEventListener('click', () => {
    if (!actions.isBusy()) close();
  });
  $('#sheet-close').addEventListener('click', () => close());
  $('#amount-down').addEventListener('click', () => step(-1));
  $('#amount-up').addEventListener('click', () => step(1));
  modes.addEventListener('click', ({ target }) => {
    const mode = target.closest('[data-mode]')?.dataset.mode;
    if (mode) showChipMode(mode);
  });

  return {
    get isOpen() {
      return open !== null;
    },
    openRaise(game, player) {
      modes.hidden = true;
      show(raiseJob(game, player));
      actions.guard(OPEN_GUARD_MS);
    },
    openChips(game, player) {
      chipTarget = [game, player];
      modes.hidden = false;
      showChipMode('add');
      actions.guard(OPEN_GUARD_MS);
    },
    close,
    showError(message) {
      failure.textContent = message;
      failure.hidden = false;
    },
  };
}
