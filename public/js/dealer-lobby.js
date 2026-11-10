// Setting up the table before a game. The fields keep what was typed until the server has it, so
// a broadcast can't wipe a half finished edit, and Start game never ignores what is on screen.

import { $, button, chips, h, icon, keepDigits } from './dealer-dom.js';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 9;
const FIELD_SAVE_DELAY_MS = 250;

// Move up, move down and remove. The lobby and Manage table seat people the same way.
export function seatButtons({ player, index, total, move, remove }) {
  const moveButton = (direction) => {
    const isUp = direction < 0;
    return h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `Move ${player.name} ${isUp ? 'up' : 'down'}`,
        'data-lock': true,
        'data-off': isUp ? index === 0 : index === total - 1,
        'data-action': isUp ? 'up' : 'down',
        click: () => move(direction),
      },
      icon(isUp ? 'up' : 'down'),
    );
  };
  return [
    moveButton(-1),
    moveButton(1),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn remove',
        'aria-label': `Remove ${player.name}`,
        'data-lock': true,
        'data-action': 'remove',
        click: remove,
      },
      icon('close'),
    ),
  ];
}

export function createLobby({ actions, hideNotice, openBuyIn }) {
  const root = $('#lobby');
  const seats = $('#seats');
  const count = $('#seat-count');
  const nameField = $('#add-name');
  const addButton = $('#add-button');
  const fields = {
    startingChips: $('#starting-chips'),
    smallBlind: $('#small-blind'),
    bigBlind: $('#big-blind'),
  };
  let game = null;
  let shownOptions = null;

  const isEditingOptions = () => Object.values(fields).includes(document.activeElement);

  const typedOptions = () =>
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Number(field.value)]));

  function optionEdits() {
    const typed = typedOptions();
    const changed = Object.keys(fields).some((key) => typed[key] !== game.options[key]);
    return changed ? [{ type: 'setOptions', ...typed }] : [];
  }

  function nameEdits() {
    const name = nameField.value.trim();
    return name === '' ? [] : [{ type: 'addPlayer', name }];
  }

  // The tap that leaves a field is often the tap that locks the buttons, so a lock that will lift
  // by itself is waited out. Offline isn't one of those, because nothing is ever queued. While a
  // field has focus the edit isn't finished: 50 / 10 is only halfway to 50 / 100. And a wait can
  // outlast the lobby, if Undo goes back into a hand.
  function saveOptions() {
    if (root.hidden) return;
    const edits = optionEdits();
    if (edits.length === 0) hideNotice();
    else if (actions.isBusy()) setTimeout(saveOptions, FIELD_SAVE_DELAY_MS);
    else if (!isEditingOptions()) actions.dispatch(...edits);
  }

  async function addTypedName() {
    const edits = nameEdits();
    if (edits.length === 0) return;
    if (await actions.dispatch(...edits)) nameField.value = '';
  }

  async function startGame() {
    const edits = [...optionEdits(), ...nameEdits()];
    if (await actions.dispatch(...edits, { type: 'startGame' })) nameField.value = '';
  }

  // Lit up when it differs from Starting chips, so an odd stack is easy to spot before dealing.
  function stackButton(player) {
    const isOwn = player.stack !== game.options.startingChips;
    return h(
      'button',
      {
        type: 'button',
        class: isOwn ? 'seat-stack own' : 'seat-stack',
        'aria-label': `${player.name} starts with ${chips(player.stack)}`,
        'data-lock': true,
        'data-action': 'buy-in',
        click: () => openBuyIn(game, player),
      },
      chips(player.stack),
    );
  }

  function seatRow(player, index) {
    const isDealer = player.id === game.dealerId;
    return h(
      'li',
      { class: isDealer ? 'seat is-dealer' : 'seat', 'data-player': player.id },
      h(
        'button',
        {
          type: 'button',
          class: 'seat-pick',
          'aria-pressed': String(isDealer),
          'aria-label': `${player.name}, seat ${index + 1}${isDealer ? ', deals first' : ''}`,
          'data-lock': true,
          click: () => isDealer || actions.dispatch({ type: 'setDealer', id: player.id }),
        },
        h('span', { class: isDealer ? 'dealer-chip' : 'seat-number' }, isDealer ? 'D' : index + 1),
        h('span', { class: 'seat-name' }, player.name),
      ),
      stackButton(player),
      seatButtons({
        player,
        index,
        total: game.players.length,
        move: (direction) => actions.dispatch({ type: 'movePlayer', id: player.id, direction }),
        remove: () => actions.dispatch({ type: 'removePlayer', id: player.id }),
      }),
    );
  }

  function renderOptions() {
    const serialized = JSON.stringify(game.options);
    if (serialized === shownOptions) return;
    shownOptions = serialized;
    for (const [key, field] of Object.entries(fields)) {
      if (document.activeElement !== field) field.value = game.options[key];
    }
  }

  function startNote(players) {
    const missing = MIN_PLAYERS - players;
    if (missing <= 0) return `${players} players`;
    return `Add ${missing} more ${missing === 1 ? 'player' : 'players'}`;
  }

  // Keeps the keyboard up, so the next name can be typed straight away.
  addButton.addEventListener('mousedown', (event) => event.preventDefault());

  $('#add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addTypedName();
  });

  // Waits a moment: tapping Start game out of a field fires this first, and saving straight away
  // would lock the button before the tap reached it. Start game saves these itself. This can't be
  // the change event: moving to Big blind and leaving it as it was fires none there.
  $('.options').addEventListener('focusout', () => setTimeout(saveOptions, FIELD_SAVE_DELAY_MS));

  for (const field of Object.values(fields)) {
    // On a phone a tap puts the caret at the end, so 25 typed over 5 would come out as 525.
    field.addEventListener('focus', () => field.select());
    field.addEventListener('input', keepDigits);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') field.blur();
    });
  }

  return {
    root,
    render(view) {
      game = view;
      const total = game.players.length;
      const isFull = total >= MAX_PLAYERS;
      count.textContent = `${total} of ${MAX_PLAYERS}`;
      seats.replaceChildren(...game.players.map(seatRow));
      nameField.placeholder = isFull ? 'The table is full' : 'Player name';
      nameField.readOnly = isFull;
      addButton.toggleAttribute('data-off', isFull);
      renderOptions();
    },
    primary() {
      const total = game.players.length;
      return button({
        label: 'Start game',
        note: startNote(total),
        tone: 'lg primary',
        action: 'start',
        off: total < MIN_PLAYERS,
        tap: startGame,
      });
    },
  };
}
