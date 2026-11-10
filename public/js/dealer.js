// The dealer's phone. Every screen is drawn from the last state the server sent, nothing is
// queued, and nothing is sent without the version of the screen it was tapped on.

import { connect } from './connection.js';
import { createActions } from './dealer-actions.js';
import { createDock } from './dealer-dock.js';
import { $, fitText, h, trackKeyboard } from './dealer-dom.js';
import { createLobby } from './dealer-lobby.js';
import { createManage } from './dealer-manage.js';
import { createPairing } from './dealer-pairing.js';
import { createProjection } from './dealer-projection.js';
import { createAmountSheet } from './dealer-sheet.js';
import { createTable } from './dealer-table.js';
import { themeById } from './themes.js';

const NEW_SCREEN_GUARD_MS = 450;
const LOBBY_GUARD_MS = 300;
const NOTICE_MS = 5000;
const FIRST_CONNECT_GRACE_MS = 1500;
const LOST_AFTER_MS = 20_000;
const BETWEEN_HANDS = new Set(['handComplete', 'betweenHands', 'gameOver']);
// Each is a bold lead, then the rest.
const DROPPED_BANNER = ['Disconnected.', 'Reconnecting. Buttons are off until it is back.'];
const LOST_BANNER = [
  'Cannot reach the laptop.',
  'If the Wi-Fi changed, scan the code on the laptop again.',
];

// Safari zooms on a second tap that nothing handled, whatever touch-action says, and the hero and
// half the buttons go off screen in the middle of a hand. It takes both of these to stop that. A
// dblclick listener is enough on an idle page, but not on a busy one. Cancelling mouseup counts as
// handling the tap however busy the page is, and leaves its click alone, but misses a tap that
// lands as a field blurs. For it to come at all, disabled buttons let taps through to #app. #app is
// a fieldset because Safari holds a tap on anything but a form control for 32 ms, by when a locked
// button may have unlocked, and the tap would act for the next player. A mouse keeps its mouseup,
// which clears a selection in a field. A pointer listener up here would lose clicks.
if (window.matchMedia('(pointer: coarse)').matches) {
  document.addEventListener('dblclick', (event) => event.preventDefault());
  $('#app').addEventListener('mouseup', (event) => event.preventDefault());
}

const state = {
  status: 'connecting',
  connectionId: null,
  canControl: null,
  game: null,
  version: null,
  canUndo: false,
  undoLabel: null,
  session: null,
};

let link = null;
let noticeTimer = 0;
let lostTimer = 0;
let hasConnected = false;
let graceOver = false;

const isOnline = () => state.status === 'connected';

function syncLocks() {
  const locked = actions.isLocked();
  document.querySelectorAll('[data-lock]').forEach((node) => {
    node.disabled = locked || 'off' in node.dataset;
  });
  document.querySelectorAll('[data-online]').forEach((node) => {
    node.disabled = !isOnline() || 'off' in node.dataset;
  });
  $('#app').classList.toggle('locked', locked);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  $('#notice').hidden = true;
  $('#map-notice').hidden = true;
}

function showNotice(message) {
  if (sheet.isOpen) {
    sheet.showError(message);
    return;
  }
  const notice = $(state.session?.view === 'projection' ? '#map-notice' : '#notice');
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, NOTICE_MS);
}

const actions = createActions({
  request: (message) => link.request(message),
  version: () => state.version,
  isOnline,
  onChange: syncLocks,
  onSend: hideNotice,
  onError: showNotice,
});

const sheet = createAmountSheet({ actions, onChange: syncLocks });
const lobby = createLobby({
  actions,
  hideNotice,
  openBuyIn: (game, player) => sheet.openBuyIn(game, player),
});
const manage = createManage({
  actions,
  hideNotice,
  openChips: (game, player) => sheet.openChips(game, player),
  onChange: syncLocks,
  onClose: renderGame,
});
const dock = createDock({ node: $('#utility'), actions, onChange: syncLocks });
const table = createTable({
  actions,
  openRaise: (game, player) => sheet.openRaise(game, player),
  openManage() {
    manage.open();
    renderGame();
  },
  onChange: renderGame,
});
const projection = createProjection({
  link: {
    send: (message) => link.send(message),
    request: (message) => link.request(message),
    connectionId: () => state.connectionId,
    isOnline,
  },
  onChange: syncLocks,
  onError: showNotice,
});
const pairing = createPairing({
  onCode: (code) => link.setKey(code),
  onChange() {
    renderConnection();
    renderShell();
  },
});

function renderGame() {
  const { game, canUndo, undoLabel } = state;
  if (!game) return;
  // Undo can go back into the hand from here, and Manage table has no meaning there.
  if (!BETWEEN_HANDS.has(game.phase)) manage.reset();
  const inLobby = game.phase === 'lobby';
  lobby.root.hidden = !inLobby;
  manage.root.hidden = !manage.isOpen;
  $('#table').hidden = inLobby || manage.isOpen;
  if (inLobby) lobby.render(game);
  if (manage.isOpen) manage.render(game);
  let primary = [];
  if (inLobby) primary = [lobby.primary()];
  else if (manage.isOpen) primary = [manage.primary()];
  else primary = table.render(game);
  $('#primary').replaceChildren(...primary);
  // New game on the game over screen is the same action as End game.
  const canEnd = !inLobby && !manage.isOpen && game.phase !== 'gameOver';
  dock.render({ canUndo, undoLabel, canEnd });
  syncLocks();
  fitText();
}

function renderShell() {
  const { canControl, game, session } = state;
  const isReady = canControl === true && game !== null && session !== null;
  const view = session?.view;
  $('#splash').hidden = canControl === false || isReady;
  $('#pairing').hidden = canControl !== false;
  $('#topbar').hidden = !isReady;
  $('#game-tab').hidden = !isReady || view !== 'game';
  $('#projection-tab').hidden = !isReady || view !== 'projection';
  if (!isReady) return;
  if (view !== 'game') sheet.close(false);
  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  });
  const wall = $('#wall-state');
  wall.textContent = session.output.connected ? 'Wall on' : 'Wall off';
  wall.classList.toggle('on', session.output.connected);
  fitText();
}

function renderConnection() {
  const expected = pairing.isChecking || (!hasConnected && !graceOver);
  $('#banner').hidden = isOnline() || expected;
  // Whether the wall is up isn't something a disconnected phone can know.
  $('#wall-state').hidden = !isOnline();
  $('#save-warning').hidden = !isOnline() || !state.session?.saveFailed;
  syncLocks();
}

function setBanner([lead, rest]) {
  $('#banner').replaceChildren(h('strong', {}, lead), ` ${rest}`);
}

// A short drop is normal for a phone. A long one may be the laptop moving to a new address, which
// no amount of reconnecting can fix.
function watchDisconnection() {
  setBanner(DROPPED_BANNER);
  clearTimeout(lostTimer);
  lostTimer = setTimeout(() => setBanner(LOST_BANNER), LOST_AFTER_MS);
}

function applyTheme(themeId) {
  const theme = themeById(themeId);
  const root = document.documentElement.style;
  for (const [token, value] of Object.entries(theme.ui)) root.setProperty(`--${token}`, value);
  $('meta[name="theme-color"]').content = theme.ui.bg;
}

function onGame({ game, version, canUndo, undoLabel }) {
  const isNewScreen = state.version !== null && version !== state.version;
  Object.assign(state, { game, version, canUndo, undoLabel });
  if (isNewScreen) {
    sheet.close(false);
    table.resetPicks();
    dock.reset();
    actions.guard(game.phase === 'lobby' ? LOBBY_GUARD_MS : NEW_SCREEN_GUARD_MS);
  }
  renderGame();
  renderShell();
}

function onWelcome(message) {
  const { connectionId, canControl, blocked } = message;
  state.connectionId = connectionId;
  state.canControl = canControl;
  // A blocked code was never looked at, so it is the one code that has to go out again.
  if (!canControl && !blocked) link.clearKey();
  pairing.onWelcome(message);
  renderConnection();
  renderShell();
}

const handlers = {
  welcome: onWelcome,
  game: onGame,
  session(message) {
    state.session = message;
    projection.onSession(message);
    renderConnection();
    renderShell();
  },
  calibration(message) {
    applyTheme(message.calibration.themeId);
    projection.onCalibration(message);
  },
};

function onStatus(status) {
  const wasOnline = isOnline();
  state.status = status;
  if (status === 'connected') {
    hasConnected = true;
    clearTimeout(lostTimer);
  } else if (wasOnline) {
    watchDisconnection();
  }
  renderConnection();
}

$('#notice').addEventListener('click', hideNotice);
$('#tabs').addEventListener('click', ({ target }) => {
  const tab = target.closest('[data-view]');
  if (!tab || tab.getAttribute('aria-selected') === 'true') return;
  link.request({ type: 'session:set', view: tab.dataset.view }).catch(() => {});
});

window.addEventListener('resize', renderGame);
setTimeout(() => {
  graceOver = true;
  renderConnection();
}, FIRST_CONNECT_GRACE_MS);

trackKeyboard();
watchDisconnection();
link = connect({
  role: 'dealer',
  key: pairing.code,
  onMessage: (message) => handlers[message.type]?.(message),
  onStatus,
});
renderConnection();
renderShell();
