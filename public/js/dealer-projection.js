// Calibration from the phone: a small map of the wall with the warped pill and all 13 points.
// Drags are relative, so a fingertip never hides or jumps the point it is moving, and the D-pad
// does the fine work. Undo and redo live on the server, shared with the laptop.

import { calibrationPoints, movePoint } from './calibration.js';
import { $ } from './dealer-dom.js';
import { createWarp } from './geometry.js';
import { themeById } from './themes.js';

const HIT_RADIUS_PX = 36;
const SELECTED_BIAS_PX = 16;
const DRAG_SLOP_PX = 4;
const SEND_INTERVAL_MS = 33;
const NUDGE_GROUP_MS = 500;
const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 70;
const FALLBACK_WALL = { width: 1920, height: 1080 };
const EDGE_STEPS = 24;
const ARC_STEPS = 40;

function pillOutline(table, inset) {
  const r = table.widthIn / 2 - inset;
  const s = table.lengthIn / 2 - table.widthIn / 2;
  const edge = (i) => (2 * s * i) / EDGE_STEPS;
  const arc = (i) => (Math.PI * i) / ARC_STEPS;
  const steps = (count) => Array.from({ length: count + 1 }, (_, i) => i);
  return [
    ...steps(EDGE_STEPS).map((i) => [edge(i) - s, -r]),
    ...steps(ARC_STEPS).map((i) => [s + r * Math.sin(arc(i)), -r * Math.cos(arc(i))]),
    ...steps(EDGE_STEPS).map((i) => [s - edge(i), r]),
    ...steps(ARC_STEPS).map((i) => [-s - r * Math.sin(arc(i)), r * Math.cos(arc(i))]),
  ];
}

function warpedPath(warp, outline) {
  const parts = outline.map(([x, y]) => warp.forward(x, y).map((value) => value.toFixed(5)));
  return `M${parts.map((part) => part.join(' ')).join('L')}Z`;
}

// Repeats while held. Keyboard presses arrive as clicks with no pointer behind them.
function holdToRepeat(node, run) {
  let timer = 0;
  const stop = () => clearTimeout(timer);
  const repeat = () => {
    if (run()) timer = setTimeout(repeat, REPEAT_INTERVAL_MS);
  };
  node.addEventListener('pointerdown', () => {
    stop();
    if (run()) timer = setTimeout(repeat, REPEAT_DELAY_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    node.addEventListener(type, stop);
  }
  node.addEventListener('click', (event) => {
    if (event.detail === 0) run();
  });
}

export function createProjection({ link, onChange, onError }) {
  const map = $('#map');
  const rim = $('#map-rim');
  const felt = $('#map-felt');
  const seam = $('#map-seam');
  const markers = $('#map-points');
  const readout = $('#point-readout');
  const wallNote = $('#wall-note');
  const nodes = new Map();
  let calibration = null;
  let warp = null;
  let points = [];
  let canUndo = false;
  let canRedo = false;
  let session = null;
  let selectedId = null;
  let stepPx = 1;
  let drag = null;
  let edit = null;
  let sendTimer = 0;
  let groupTimer = 0;
  let lastSentAt = 0;

  const wallPixels = () => (session?.output.connected ? session.output : FALLBACK_WALL);

  function rebuild() {
    warp = createWarp(calibration.table, calibration.corners, calibration.offsets);
    points = calibrationPoints(calibration, warp);
  }

  function renderMarkers() {
    for (const { id, kind, label, position } of points) {
      if (!nodes.has(id)) {
        const node = document.createElement('span');
        node.className = `marker ${kind}`;
        node.dataset.point = id;
        node.title = label;
        markers.append(node);
        nodes.set(id, node);
      }
      const { style, classList } = nodes.get(id);
      style.left = `${position[0] * 100}%`;
      style.top = `${position[1] * 100}%`;
      classList.toggle('selected', id === selectedId);
    }
  }

  function renderReadout() {
    const point = points.find(({ id }) => id === selectedId);
    if (!point) {
      readout.textContent = 'Tap a point to select it';
      return;
    }
    const { width, height } = wallPixels();
    const [x, y] = point.position;
    readout.textContent = `${point.label}: ${Math.round(x * width)}, ${Math.round(y * height)}`;
  }

  function renderControls() {
    document.querySelectorAll('[data-pattern]').forEach((node) => {
      node.setAttribute('aria-pressed', String(node.dataset.pattern === calibration.pattern));
    });
    document.querySelectorAll('[data-step]').forEach((node) => {
      node.setAttribute('aria-pressed', String(Number(node.dataset.step) === stepPx));
    });
    document.querySelectorAll('[data-nudge]').forEach((node) => {
      node.toggleAttribute('data-off', selectedId === null);
    });
    $('#calibration-undo').toggleAttribute('data-off', !canUndo);
    $('#calibration-redo').toggleAttribute('data-off', !canRedo);
    onChange();
  }

  function renderMap() {
    const { table, themeId } = calibration;
    const { felt: feltColor, rail, line } = themeById(themeId);
    rim.setAttribute('d', warpedPath(warp, pillOutline(table, 0)));
    rim.setAttribute('fill', rail);
    rim.setAttribute('stroke', line);
    felt.setAttribute('d', warpedPath(warp, pillOutline(table, table.railIn)));
    felt.setAttribute('fill', feltColor);
    seam.setAttribute('d', felt.getAttribute('d'));
    seam.setAttribute('stroke', line);
    renderMarkers();
    renderReadout();
  }

  function render() {
    if (!calibration) return;
    renderMap();
    renderControls();
  }

  function apply(next) {
    if (next === calibration) return;
    calibration = next;
    rebuild();
    renderMap();
  }

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
      link.send({ type: 'calibration:update', calibration });
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
      await link.request({ type: 'calibration:update', calibration });
    } catch (error) {
      if (error.code !== 'disconnected') onError(error.message);
    }
    if (edit === finishing) edit = null;
  }

  function select(id) {
    if (id === selectedId) return;
    finishEdit();
    selectedId = id;
    render();
    link.request({ type: 'session:set', selectedPoint: id }).catch(() => {});
  }

  // The selected point wins close calls, so points that end up on top of each other stay usable.
  function nearestPoint({ clientX, clientY }) {
    const { left, top, width, height } = map.getBoundingClientRect();
    let nearest = null;
    let best = HIT_RADIUS_PX;
    for (const point of points) {
      const [x, y] = point.position;
      const reach = Math.hypot(left + x * width - clientX, top + y * height - clientY);
      const distance = point.id === selectedId ? reach - SELECTED_BIAS_PX : reach;
      if (distance < best) {
        best = distance;
        nearest = point;
      }
    }
    return nearest;
  }

  function onPointerDown(event) {
    if (!link.isOnline() || !calibration || drag) return;
    const point = nearestPoint(event);
    select(point?.id ?? null);
    if (!point) return;
    map.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      id: point.id,
      position: [...point.position],
      lastX: event.clientX,
      lastY: event.clientY,
      isMoving: false,
    };
  }

  // A small slop keeps a tap that only selects a point from also moving it.
  function onPointerMove(event) {
    if (event.pointerId !== drag?.pointerId) return;
    if (!drag.isMoving) {
      const moved = Math.hypot(event.clientX - drag.lastX, event.clientY - drag.lastY);
      if (moved < DRAG_SLOP_PX) return;
      drag.isMoving = true;
      beginEdit();
    }
    const { width, height } = map.getBoundingClientRect();
    drag.position = [
      drag.position[0] + (event.clientX - drag.lastX) / width,
      drag.position[1] + (event.clientY - drag.lastY) / height,
    ];
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    apply(movePoint(calibration, warp, drag.id, drag.position));
    queueUpdate();
  }

  function onPointerEnd(event) {
    if (event.pointerId !== drag?.pointerId) return;
    const { isMoving } = drag;
    drag = null;
    if (isMoving) finishEdit();
  }

  function nudge(dx, dy) {
    const point = points.find(({ id }) => id === selectedId);
    if (!point || !link.isOnline()) return false;
    beginEdit();
    const { width, height } = wallPixels();
    const [x, y] = point.position;
    apply(
      movePoint(calibration, warp, point.id, [
        x + (dx * stepPx) / width,
        y + (dy * stepPx) / height,
      ]),
    );
    queueUpdate();
    clearTimeout(groupTimer);
    groupTimer = setTimeout(finishEdit, NUDGE_GROUP_MS);
    return true;
  }

  function command(message) {
    link.request(message).catch((error) => {
      if (error.code !== 'disconnected') onError(error.message);
    });
  }

  async function stepHistory(type) {
    await finishEdit();
    command({ type });
  }

  map.addEventListener('pointerdown', onPointerDown);
  map.addEventListener('pointermove', onPointerMove);
  map.addEventListener('pointerup', onPointerEnd);
  map.addEventListener('pointercancel', onPointerEnd);

  document.querySelectorAll('[data-nudge]').forEach((node) => {
    const [dx, dy] = node.dataset.nudge.split(',').map(Number);
    holdToRepeat(node, () => nudge(dx, dy));
  });

  document.querySelectorAll('[data-step]').forEach((node) => {
    node.addEventListener('click', () => {
      stepPx = Number(node.dataset.step);
      renderControls();
    });
  });

  document.querySelectorAll('[data-pattern]').forEach((node) => {
    node.addEventListener('click', () => {
      const { pattern } = node.dataset;
      apply({ ...calibration, pattern });
      command({ type: 'calibration:update', calibration });
    });
  });

  $('#show-points').addEventListener('click', () => {
    command({ type: 'session:set', showPoints: !session.showPoints });
  });
  $('#calibration-undo').addEventListener('click', () => stepHistory('calibration:undo'));
  $('#calibration-redo').addEventListener('click', () => stepHistory('calibration:redo'));

  return {
    // While editing, this client's own echoes are older than what is on screen.
    onCalibration(message) {
      ({ canUndo, canRedo } = message);
      const isOwnEcho = edit !== null && message.origin === link.connectionId();
      if (!isOwnEcho) {
        ({ calibration } = message);
        rebuild();
      }
      render();
    },
    onSession(next) {
      session = next;
      selectedId = next.selectedPoint;
      const { width, height, connected } = next.output;
      map.style.setProperty('--wall-aspect', String(width / height));
      wallNote.hidden = connected || next.saveFailed;
      $('#show-points').setAttribute('aria-checked', String(next.showPoints));
      render();
    },
  };
}
