// The row above the big buttons: Undo, and End game with its inline confirm. Nothing here changes
// height between states, so the buttons below never move under a thumb.

import { h, icon } from './dealer-dom.js';

const CONFIRM_TIMEOUT_MS = 6000;
const REVEAL_GUARD_MS = 450;

export function createDock({ node, actions, onChange }) {
  let confirming = false;
  let timer = 0;
  let shown = null;

  function setConfirming(next) {
    confirming = next;
    clearTimeout(timer);
    if (next) timer = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    render(shown);
    onChange();
  }

  function undoButton({ canUndo, undoLabel }) {
    return h(
      'button',
      {
        type: 'button',
        class: 'undo',
        'data-lock': true,
        'data-off': !canUndo,
        'data-action': 'undo',
        click: () => actions.undo(),
      },
      icon('undo'),
      h('span', { class: 'undo-text' }, canUndo ? `Undo: ${undoLabel}` : 'Nothing to undo'),
    );
  }

  function endButton() {
    return h(
      'button',
      {
        type: 'button',
        class: 'end',
        'data-lock': true,
        'data-action': 'end',
        click() {
          actions.guard(REVEAL_GUARD_MS);
          setConfirming(true);
        },
      },
      'End game',
    );
  }

  // Keep playing sits where End game was, so a double tap can only back out.
  function confirmRow() {
    return [
      h('span', { class: 'confirm-text' }, 'End game? Stacks reset.'),
      h(
        'button',
        {
          type: 'button',
          class: 'end-yes',
          'data-lock': true,
          'data-action': 'end-yes',
          click: () => actions.dispatch({ type: 'endGame' }),
        },
        'Yes, end it',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'end-no',
          'data-lock': true,
          'data-action': 'end-no',
          click: () => setConfirming(false),
        },
        'Keep playing',
      ),
    ];
  }

  function render(state) {
    shown = state;
    const { canEnd } = state;
    if (confirming && canEnd) node.replaceChildren(...confirmRow());
    else if (canEnd) node.replaceChildren(undoButton(state), endButton());
    else node.replaceChildren(undoButton(state));
    node.hidden = !canEnd && !state.canUndo;
  }

  return {
    render,
    reset() {
      clearTimeout(timer);
      confirming = false;
    },
  };
}
