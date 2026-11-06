// The wall window: a clean page for the projector that shows whatever session.view says. It only
// listens. The one thing it ever reports is its own size.

import { calibrationPoints } from './calibration.js';
import { connect } from './connection.js';
import { storedHostKey } from './host-key.js';
import { createMarkers } from './markers.js';
import { createWall } from './wall.js';

const REPORT_DELAY_MS = 100;
const HINT = 'Drag this window to the projector, then click to go fullscreen.';
const REFUSED_HINT = 'Fullscreen was blocked. Use View > Enter Full Screen.';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#wall');
const hint = $('#hint');

let connection = null;
const latest = { calibration: null, session: null, game: null };

function fail(message) {
  const fatal = $('#fatal');
  fatal.textContent = message;
  fatal.hidden = false;
  hint.hidden = true;
}

function startWall() {
  try {
    return createWall(canvas);
  } catch (error) {
    fail(error.message);
    return null;
  }
}

const wall = startWall();
const markers = createMarkers($('#markers'));

/* ---------- Showing state ---------- */

function syncMarkers() {
  const { calibration, session } = latest;
  markers.update({
    points: calibrationPoints(calibration, wall.warp()),
    visible: session.view === 'projection' && session.showPoints,
    selectedId: session.selectedPoint,
  });
}

// Nothing shows until a full snapshot is in. Otherwise a reload mid-game could flash the test
// pattern on the wall between the calibration and the session arriving.
function onMessage(message) {
  if (message.type === 'calibration') latest.calibration = message.calibration;
  else if (message.type === 'session') latest.session = message;
  else if (message.type === 'game') latest.game = message.game;

  const { calibration, session, game } = latest;
  if (!wall || !calibration || !session || !game) return;
  wall.update({ calibration, view: session.view, game });
  syncMarkers();
}

/* ---------- Size ---------- */

// The real pixels on the wall, which is what a one pixel nudge has to mean.
function wallSize() {
  const scale = window.devicePixelRatio || 1;
  return {
    width: Math.round(window.innerWidth * scale),
    height: Math.round(window.innerHeight * scale),
  };
}

function reportSize() {
  const { width, height } = wallSize();
  // A minimized window can measure zero, which is no use to anyone.
  if (width >= 1 && height >= 1) connection?.send({ type: 'output:size', width, height });
}

let reportTimer = 0;
function reportSizeSoon() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportSize, REPORT_DELAY_MS);
}

// Fires when the window moves to a screen with a different pixel density, which is no resize.
function watchPixelRatio() {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    'change',
    () => {
      reportSizeSoon();
      watchPixelRatio();
    },
    { once: true },
  );
}

/* ---------- Fullscreen ---------- */

function syncFullscreen() {
  const fullscreen = Boolean(document.fullscreenElement);
  document.body.classList.toggle('fullscreen', fullscreen);
  hint.hidden = fullscreen || !wall;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    hint.textContent = HINT;
  } catch {
    hint.textContent = REFUSED_HINT;
    syncFullscreen();
  }
}

/* ---------- Staying awake ---------- */

// The dealer plays from the phone, so nobody touches the laptop during a game and its screen would
// sleep and take the wall with it. The browser drops the lock whenever this page is hidden, so it
// is taken again on return. Wake Lock needs a secure context, and localhost counts as one.
async function keepScreenAwake() {
  if (document.visibilityState !== 'visible') return;
  await navigator.wakeLock?.request('screen').catch(() => {});
}

/* ---------- Start ---------- */

document.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreen);
window.addEventListener('resize', reportSizeSoon);
window.addEventListener('keydown', (event) => {
  const isPlain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat;
  if (isPlain && event.key.toLowerCase() === 'f') toggleFullscreen();
});

document.addEventListener('visibilitychange', keepScreenAwake);

hint.textContent = HINT;
syncFullscreen();
watchPixelRatio();
keepScreenAwake();

connection = connect({
  role: 'output',
  key: storedHostKey(),
  onMessage,
  onStatus: (status) => {
    if (status === 'connected') reportSize();
  },
});
