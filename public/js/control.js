// The laptop page: a live preview of the wall, with calibration or pairing beside it. The server
// owns all of the state and this page draws what it is told. The one exception is a point being
// moved, which runs ahead of the server so that a drag feels direct.

import {
  calibrationPoints,
  movePoint,
  PATTERNS,
  resizeTable,
  sanitizeCalibration,
} from './calibration.js';
import { connect } from './connection.js';
import { normalizeTable } from './geometry.js';
import { createHandles } from './handles.js';
import { themeById, themes } from './themes.js';
import { createWall } from './wall.js';

const SEND_INTERVAL_MS = 33;
const NUDGE_GROUP_MS = 500;
const TOAST_MS = 2200;
const PAIRING_REFRESH_MS = 10_000;
const NEW_CODE_CONFIRM_MS = 5000;
const FALLBACK_WALL = { width: 1920, height: 1080 };
const ARROWS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const $ = (selector) => document.querySelector(selector);

const state = {
  status: 'connecting',
  connectionId: null,
  canControl: null,
  // What this page shows, which leads the server during an edit, and what the server last said.
  calibration: null,
  confirmed: null,
  canUndo: false,
  canRedo: false,
  session: null,
  game: null,
};

let wall = null;
let handles = null;
let link = null;
let hasConnected = false;
let shownPairing = null;
let newCodeTimer = 0;

const isOnline = () => state.status === 'connected';
const hasSnapshot = () => state.calibration && state.session && state.game;
const canEdit = () => isOnline() && state.canControl === true && hasSnapshot();

// Nudges and the readout are in the wall's real pixels.
const wallPixels = () => (state.session?.output.connected ? state.session.output : FALLBACK_WALL);

/* ---------- Messages ---------- */

let toastTimer = 0;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, TOAST_MS);
}

function report(error) {
  if (error.code !== 'disconnected') toast(error.message);
}

function fail(message) {
  $('#fatal').textContent = message;
  $('#fatal').hidden = false;
  $('#link-status').hidden = true;
}

/* ---------- Editing ---------- */

// Set from an edit's first change until the server acks its last one. Until then an echo of this
// page's own updates is older than what is on screen.
let edit = null;
let sendTimer = 0;
let groupTimer = 0;
let lastSentAt = 0;

function beginEdit() {
  if (edit !== null && !edit.isFinishing) return;
  edit = { isFinishing: false };
  link.send({ type: 'calibration:begin' });
}

function queueUpdate() {
  if (sendTimer) return;
  const wait = Math.max(0, lastSentAt + SEND_INTERVAL_MS - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = 0;
    lastSentAt = performance.now();
    link.send({ type: 'calibration:update', calibration: state.calibration });
  }, wait);
}

// The last position always goes out, and this waits for its ack: until then a late echo of an
// earlier update could still arrive and pull the point backwards.
async function finishEdit() {
  clearTimeout(groupTimer);
  if (edit === null || edit.isFinishing) return;
  const finishing = edit;
  finishing.isFinishing = true;
  clearTimeout(sendTimer);
  sendTimer = 0;
  try {
    await link.request({ type: 'calibration:update', calibration: state.calibration });
    if (edit === finishing) edit = null;
  } catch (error) {
    report(error);
    if (edit === finishing) revertEdit();
  }
}

// The server turned the edit down, so the wall never saw it. This page goes back to match.
function revertEdit() {
  edit = null;
  state.calibration = state.confirmed;
  render();
}

// Each drag or table change is its own undo step, even straight after a run of nudges.
function startEdit() {
  finishEdit();
  beginEdit();
}

function abandonEdit() {
  clearTimeout(groupTimer);
  clearTimeout(sendTimer);
  sendTimer = 0;
  edit = null;
}

function show(calibration) {
  state.calibration = calibration;
  wall.update({ calibration });
  renderPoints();
}

function moveTo(id, position) {
  const next = movePoint(state.calibration, wall.warp(), id, position);
  if (next === state.calibration) return;
  show(next);
  queueUpdate();
}

function nudge(dx, dy, step) {
  const point = selectedPoint();
  if (!point) return;
  beginEdit();
  const { width, height } = wallPixels();
  const [x, y] = point.position;
  moveTo(point.id, [x + (dx * step) / width, y + (dy * step) / height]);
  clearTimeout(groupTimer);
  groupTimer = setTimeout(finishEdit, NUDGE_GROUP_MS);
}

// Undo has never touched the pattern or the theme, so these skip calibration:begin.
function applyChoice(choice) {
  const next = { ...state.calibration, ...choice };
  if (edit !== null && !edit.isFinishing) {
    show(next);
    queueUpdate();
  } else {
    edit = { isFinishing: false };
    show(next);
    finishEdit();
  }
  renderChoices();
}

function applyTable(table) {
  const { lengthIn, widthIn, railIn } = state.calibration.table;
  if (table.lengthIn === lengthIn && table.widthIn === widthIn && table.railIn === railIn) return;
  // The same check the server makes, so a size it would refuse never leaves an empty undo step.
  const next = sanitizeCalibration(resizeTable(state.calibration, table));
  if (!next) {
    toast('That size does not fit these points. Use Reset all first.');
    return;
  }
  startEdit();
  show(next);
  finishEdit();
}

function updateTable() {
  const next = {
    lengthIn: $('#table-length').valueAsNumber,
    widthIn: $('#table-width').valueAsNumber,
    railIn: $('#table-rail').valueAsNumber,
  };
  if (Object.values(next).every(Number.isFinite)) applyTable(normalizeTable(next));
  renderTableInputs(null);
}

async function command(message) {
  await finishEdit();
  link.request(message).catch(report);
}

function setSession(fields) {
  link.request({ type: 'session:set', ...fields }).catch(report);
}

/* ---------- Selection ---------- */

let selectionsInFlight = 0;

const pointList = () => calibrationPoints(state.calibration, wall.warp());
const selectedPoint = () => pointList().find(({ id }) => id === handles.selected());

// Until the server acks, any session message it sent earlier carries the previous selection.
function shareSelection(id) {
  selectionsInFlight += 1;
  link
    .request({ type: 'session:set', selectedPoint: id })
    .catch(report)
    .finally(() => {
      selectionsInFlight -= 1;
      if (hasSnapshot()) renderSelection();
    });
}

function onSelect(id) {
  finishEdit();
  shareSelection(id);
  renderReadout();
}

/* ---------- Rendering ---------- */

function renderReadout() {
  const readout = $('#point-readout');
  const point = selectedPoint();
  if (!point) {
    readout.textContent = 'No point selected';
    return;
  }
  const { width, height } = wallPixels();
  const [x, y] = point.position;
  readout.textContent = `${point.label} · ${Math.round(x * width)}, ${Math.round(y * height)}`;
}

function renderPoints() {
  handles.sync();
  renderReadout();
}

function renderSelection() {
  if (selectionsInFlight === 0) handles.show(state.session.selectedPoint);
  renderReadout();
}

function renderHistory() {
  $('#undo').disabled = !state.canUndo;
  $('#redo').disabled = !state.canRedo;
}

function renderTheme({ ui, note }) {
  const root = document.documentElement.style;
  for (const [token, value] of Object.entries(ui)) root.setProperty(`--${token}`, value);
  $('#theme-note').textContent = note;
}

function renderChoices() {
  const { pattern, themeId } = state.calibration;
  const theme = themeById(themeId);
  document.querySelectorAll('[data-pattern]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.pattern === pattern));
  });
  document.querySelectorAll('[data-theme-id]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeId === theme.id));
  });
  renderTheme(theme);
}

// Leaves the field being typed in alone: a change from the phone mustn't overwrite it.
function renderTableInputs(typingIn = document.activeElement) {
  const { lengthIn, widthIn, railIn } = state.calibration.table;
  const fields = [
    [$('#table-length'), lengthIn],
    [$('#table-width'), widthIn],
    [$('#table-rail'), railIn],
  ];
  for (const [input, value] of fields) {
    if (input !== typingIn) input.value = value;
  }
}

function renderStatusChip(node, text, isOn) {
  node.textContent = text;
  node.classList.toggle('on', isOn);
}

function renderStatus() {
  const { canControl, session } = state;
  const linkStatus = $('#link-status');
  const isViewOnly = isOnline() && canControl === false;
  linkStatus.hidden = isOnline() && !isViewOnly;
  if (isViewOnly) linkStatus.textContent = 'View only';
  else linkStatus.textContent = hasConnected ? 'Reconnecting' : 'Connecting';

  const showsDevices = isOnline() && session !== null;
  $('#wall-status').hidden = !showsDevices;
  $('#phone-status').hidden = !showsDevices;
  $('#save-warning').hidden = !showsDevices || !session.saveFailed;
  if (!showsDevices) {
    $('#pairing-phone').textContent = 'Checking';
    $('#pairing-phone').classList.remove('on');
    return;
  }
  const { connected, width, height } = session.output;
  renderStatusChip(
    $('#wall-status'),
    connected ? `Wall ${width} × ${height}` : 'Wall not open',
    connected,
  );
  const dealer = session.dealerConnected ? 'Dealer connected' : 'Dealer not connected';
  renderStatusChip($('#phone-status'), dealer, session.dealerConnected);
  $('#pairing-phone').textContent = dealer;
  $('#pairing-phone').classList.toggle('on', session.dealerConnected);
}

function renderControls() {
  const editable = canEdit();
  $('#controls').disabled = !editable;
  // A wall opens at this page's address, so without control here it could never report in.
  $('#open-wall').disabled = !editable;
  $('#new-code').disabled = !editable;
  handles.setEnabled(editable);
  document.querySelectorAll('[data-view-target]').forEach((tab) => {
    tab.disabled = !editable;
  });
}

function renderView() {
  const { view, showPoints, output } = state.session;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view-target]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.viewTarget === view));
  });
  $('#show-points').setAttribute('aria-checked', String(showPoints));
  $('#preview').style.setProperty('--wall-aspect', String(output.width / output.height));
}

// Nothing shows until a full snapshot is in, so a reload mid-game can't flash the test pattern.
function render() {
  renderStatus();
  if (hasSnapshot()) {
    const { calibration, session, game } = state;
    wall.update({ calibration, view: session.view, game });
    renderView();
    renderPoints();
    renderSelection();
    renderHistory();
    renderChoices();
    renderTableInputs();
  }
  renderControls();
}

/* ---------- Pairing ---------- */

function renderPairing({ url, code, qrSvg, addresses }) {
  const { origin, pathname } = new URL(url);
  const qr = $('#pairing-qr');
  qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`;
  qr.hidden = false;
  $('#pairing-address').textContent = `${origin}${pathname}`;
  $('#pairing-code').textContent = code;
  $('#new-code').hidden = false;
  $('#pairing-note').textContent =
    addresses[0] === 'localhost'
      ? 'This laptop is not on a network yet, so a phone cannot reach it.'
      : "Scan with the phone's camera. It has to be on the same Wi-Fi as this laptop.";
}

function localAddress() {
  const url = new URL(window.location.origin);
  url.hostname = 'localhost';
  return url.origin;
}

function renderPairingFailure(status) {
  shownPairing = null;
  $('#pairing-qr').hidden = true;
  $('#pairing-address').textContent = '';
  $('#pairing-code').textContent = '';
  $('#new-code').hidden = true;
  $('#pairing-note').textContent =
    status === 403
      ? `On the computer running the server, open ${localAddress()}.`
      : 'Could not load the pairing details.';
}

async function loadPairing() {
  try {
    const response = await fetch('/api/pairing');
    if (!response.ok) {
      renderPairingFailure(response.status);
      return;
    }
    const details = await response.text();
    // Setting the same QR again makes it flicker.
    if (details !== shownPairing) renderPairing(JSON.parse(details));
    shownPairing = details;
  } catch {
    renderPairingFailure();
  }
}

// The address can change with nothing on this page hearing about it, so the card asks.
function refreshPairing() {
  if (isOnline() && state.session?.view === 'game') loadPairing();
}

function stopConfirmingNewCode() {
  clearTimeout(newCodeTimer);
  newCodeTimer = 0;
  $('#new-code').textContent = 'New code';
}

// Two clicks, because this drops the dealer's phone in the middle of whatever it is doing.
async function replaceCode() {
  if (!newCodeTimer) {
    $('#new-code').textContent = 'Unpair the phone?';
    newCodeTimer = setTimeout(stopConfirmingNewCode, NEW_CODE_CONFIRM_MS);
    return;
  }
  stopConfirmingNewCode();
  try {
    await link.request({ type: 'pairing:new' });
    await loadPairing();
    toast('New code ready. The phone has to scan again.');
  } catch (error) {
    report(error);
  }
}

/* ---------- Server messages ---------- */

function onCalibration({ calibration, canUndo, canRedo, origin }) {
  Object.assign(state, { confirmed: calibration, canUndo, canRedo });
  if (edit !== null && origin === state.connectionId) {
    renderHistory();
    return;
  }
  state.calibration = calibration;
  render();
}

function onSession(message) {
  const enteredGame = message.view === 'game' && state.session?.view !== 'game';
  state.session = message;
  if (enteredGame) {
    handles.stopDrag();
    loadPairing();
  }
  render();
}

function onGame({ game }) {
  state.game = game;
  render();
}

function onWelcome({ connectionId, canControl }) {
  Object.assign(state, { connectionId, canControl });
  loadPairing();
  render();
}

const handlers = {
  welcome: onWelcome,
  calibration: onCalibration,
  session: onSession,
  game: onGame,
  error: ({ message }) => toast(message),
};

function onStatus(status) {
  state.status = status;
  if (status === 'connected') {
    hasConnected = true;
  } else {
    abandonEdit();
  }
  render();
}

/* ---------- Controls ---------- */

// Reloading or even focusing a wall that is already up knocks it out of fullscreen.
function openWall() {
  if (state.session?.output.connected) {
    toast('The wall window is already open.');
  } else if (!window.open('/output', 'poker-wall', 'popup,width=1280,height=720')) {
    toast('The browser blocked the window. Allow pop-ups for this page.');
  }
}

function nextPattern() {
  const { pattern } = state.calibration;
  applyChoice({ pattern: PATTERNS[(PATTERNS.indexOf(pattern) + 1) % PATTERNS.length] });
}

function buildThemePicker() {
  const list = $('#themes');
  for (const theme of themes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme';
    button.title = theme.note;
    button.dataset.themeId = theme.id;
    button.setAttribute('aria-pressed', 'false');

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--swatch-felt', theme.felt);
    swatch.style.setProperty('--swatch-rail', theme.rail);
    swatch.style.setProperty('--swatch-accent', theme.accent);

    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = theme.name;

    button.append(swatch, name);
    button.addEventListener('click', () => applyChoice({ themeId: theme.id }));
    list.append(button);
  }
}

function pressKey(event) {
  const key = event.key.toLowerCase();
  const isCommand = event.metaKey || event.ctrlKey;

  if (isCommand && key === 'z') {
    event.preventDefault();
    command({ type: event.shiftKey ? 'calibration:redo' : 'calibration:undo' });
  } else if (isCommand || event.altKey) {
    return;
  } else if (ARROWS[event.key] && handles.selected()) {
    event.preventDefault();
    nudge(...ARROWS[event.key], event.shiftKey ? 10 : 1);
  } else if (event.key === 'Tab') {
    // A keyboard walking the panel keeps going, and Shift+Tab is always the way out of the points.
    if (event.shiftKey || event.target.closest('.panel, .topbar')) return;
    event.preventDefault();
    handles.selectNext();
  } else if (event.key === 'Escape') {
    handles.clearSelection();
  } else if (key === 'h' && !event.repeat) {
    setSession({ showPoints: !state.session.showPoints });
  } else if (key === 'p' && !event.repeat) {
    nextPattern();
  }
}

function onKeyDown(event) {
  if (event.target.matches('input') || !canEdit() || state.session.view !== 'projection') return;
  // Keys wait for the drag to end, except Tab, which would otherwise leave the point mid-drag.
  if (!handles.isDragging()) pressKey(event);
  else if (event.key === 'Tab') event.preventDefault();
}

// A mouse click shouldn't leave focus on a button, where Tab would walk the panel, not the points.
function dropMouseFocus(event) {
  if (event.detail > 0) event.target.closest('button')?.blur();
}

function bindControls() {
  document.querySelectorAll('[data-view-target]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const { viewTarget: view } = tab.dataset;
      finishEdit();
      setSession(view === 'game' ? { view, selectedPoint: null } : { view });
    });
  });
  document.querySelectorAll('[data-pattern]').forEach((button) => {
    button.addEventListener('click', () => applyChoice({ pattern: button.dataset.pattern }));
  });
  document.querySelectorAll('#table-size input').forEach((input) => {
    input.addEventListener('change', updateTable);
    input.addEventListener('blur', () => renderTableInputs(null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
  });

  $('#show-points').addEventListener('click', () => {
    setSession({ showPoints: !state.session.showPoints });
  });
  $('#undo').addEventListener('click', () => command({ type: 'calibration:undo' }));
  $('#redo').addEventListener('click', () => command({ type: 'calibration:redo' }));
  $('#reset-fine').addEventListener('click', () => {
    command({ type: 'calibration:reset', scope: 'fine' });
  });
  $('#reset-all').addEventListener('click', () => {
    command({ type: 'calibration:reset', scope: 'all' });
  });
  $('#open-wall').addEventListener('click', openWall);
  $('#new-code').addEventListener('click', replaceCode);

  $('.topbar').addEventListener('click', dropMouseFocus);
  $('.calibration').addEventListener('click', dropMouseFocus);
  window.addEventListener('keydown', onKeyDown);
  // The socket here is to this computer, so it never notices the laptop joining a network.
  window.addEventListener('online', loadPairing);
  setInterval(refreshPairing, PAIRING_REFRESH_MS);
}

/* ---------- Start ---------- */

function start() {
  try {
    wall = createWall($('#table'));
  } catch (error) {
    fail(error.message);
    return;
  }

  handles = createHandles($('#handles'), $('#quad polygon'), {
    points: pointList,
    moveTo,
    beginEdit: startEdit,
    endEdit: finishEdit,
    onSelect,
  });

  buildThemePicker();
  bindControls();

  link = connect({
    role: 'control',
    onMessage: (message) => handlers[message.type]?.(message),
    onStatus,
  });
}

start();
