// The table between hands: chips, seats and blinds. Each change is an ordinary game action, so it
// reaches the wall at once and Undo takes it back. The fields keep what was typed until the server
// has it, and Done never ignores what is on screen.

import { $, button, chips, h, keepDigits } from './dealer-dom.js';
import { seatButtons } from './dealer-lobby.js';

const MAX_PLAYERS = 9;
// Opening and closing send nothing, so no reply locks the buttons. Done sits where Next hand comes
// up, and only this stops the second half of a double tap from dealing.
const SCREEN_GUARD_MS = 450;

export function createManage({ actions, hideNotice, openChips, onChange, onClose }) {
  const root = $('#manage');
  const seats = $('#manage-seats');
  const count = $('#manage-count');
  const hint = $('#manage-hint');
  const nameField = $('#seat-name');
  const seatButton = $('#seat-button');
  const small = $('#next-small');
  const big = $('#next-big');
  const setButton = $('#blinds-set');
  let game = null;
  let isOpen = false;
  let shownBlinds = null;

  function blindEdits() {
    const smallBlind = Number(small.value);
    const bigBlind = Number(big.value);
    const { options } = game;
    const isSame = smallBlind === options.smallBlind && bigBlind === options.bigBlind;
    return isSame ? [] : [{ type: 'setBlinds', smallBlind, bigBlind }];
  }

  function nameEdits() {
    const name = nameField.value.trim();
    return name === '' ? [] : [{ type: 'seatPlayer', name }];
  }

  function syncSetButton() {
    setButton.toggleAttribute('data-off', blindEdits().length === 0);
    onChange();
  }

  async function seatTypedName() {
    const edits = nameEdits();
    if (edits.length > 0 && (await actions.dispatch(...edits))) nameField.value = '';
  }

  async function done() {
    const edits = [...blindEdits(), ...nameEdits()];
    if (edits.length === 0 || (await actions.dispatch(...edits))) {
      nameField.value = '';
      isOpen = false;
      hideNotice();
      actions.guard(SCREEN_GUARD_MS);
      onClose();
    }
  }

  function seatRow(player, index) {
    const isDealer = player.id === game.dealerId;
    const isOut = player.stack === 0;
    return h(
      'li',
      { class: isDealer ? 'seat is-dealer' : 'seat', 'data-player': player.id },
      h(
        'button',
        {
          type: 'button',
          class: 'seat-pick',
          'aria-label': `${player.name}, ${isOut ? 'out' : `${chips(player.stack)} chips`}`,
          'data-lock': true,
          'data-action': 'chips',
          click: () => openChips(game, player),
        },
        h('span', { class: isDealer ? 'dealer-chip' : 'seat-number' }, isDealer ? 'D' : index + 1),
        h('span', { class: 'seat-name' }, player.name),
        h(
          'span',
          { class: isOut ? 'seat-stack out' : 'seat-stack' },
          isOut ? 'Out' : chips(player.stack),
        ),
      ),
      seatButtons({
        player,
        index,
        total: game.players.length,
        move: (direction) => actions.dispatch({ type: 'moveSeat', id: player.id, direction }),
        remove: () => actions.dispatch({ type: 'unseatPlayer', id: player.id }),
      }),
    );
  }

  // Waits for a real change, so a broadcast can't wipe a half finished edit.
  function renderBlinds() {
    const { smallBlind, bigBlind } = game.options;
    const serialized = `${smallBlind}/${bigBlind}`;
    if (serialized !== shownBlinds) {
      shownBlinds = serialized;
      if (document.activeElement !== small) small.value = smallBlind;
      if (document.activeElement !== big) big.value = bigBlind;
    }
    setButton.toggleAttribute('data-off', blindEdits().length === 0);
  }

  // Keeps the keyboard up, so the next name can be typed straight away.
  seatButton.addEventListener('mousedown', (event) => event.preventDefault());

  $('#seat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    seatTypedName();
  });

  $('#blinds-form').addEventListener('submit', (event) => {
    event.preventDefault();
    actions.dispatch(...blindEdits());
  });

  $('#blinds-double').addEventListener('click', () => {
    const { smallBlind, bigBlind } = game.options;
    actions.dispatch({
      type: 'setBlinds',
      smallBlind: smallBlind * 2,
      bigBlind: bigBlind * 2,
    });
  });

  for (const field of [small, big]) {
    // On a phone a tap puts the caret at the end, so 25 typed over 5 would come out as 525.
    field.addEventListener('focus', () => field.select());
    field.addEventListener('input', (event) => {
      keepDigits(event);
      syncSetButton();
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        field.blur();
      }
    });
  }

  return {
    root,
    get isOpen() {
      return isOpen;
    },
    open() {
      isOpen = true;
      shownBlinds = null;
      actions.guard(SCREEN_GUARD_MS);
    },
    // Quietly, for when the game has already moved on.
    reset() {
      isOpen = false;
    },
    render(view) {
      game = view;
      const total = game.players.length;
      const isFull = total >= MAX_PLAYERS;
      count.textContent = `${total} of ${MAX_PLAYERS}`;
      const buyIn = chips(game.options.startingChips);
      hint.textContent = `New players start with ${buyIn}. Tap a name to change their chips.`;
      seats.replaceChildren(...game.players.map(seatRow));
      nameField.placeholder = isFull ? 'The table is full' : 'New player';
      nameField.readOnly = isFull;
      seatButton.toggleAttribute('data-off', isFull);
      renderBlinds();
    },
    primary() {
      return button({ label: 'Done', tone: 'lg primary', action: 'manage-done', tap: done });
    },
  };
}
