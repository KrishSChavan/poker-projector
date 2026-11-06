// Pure calibration logic shared by the laptop, the phone and the server. A calibration
// is plain JSON: { table, corners, offsets, themeId, pattern }.

import {
  controlPoints,
  createWarp,
  defaultCorners,
  isUsableQuad,
  normalizeTable,
  perimeterAt,
  pointOnPill,
} from './geometry.js';
import { themeById } from './themes.js';

export const DEFAULT_TABLE = { lengthIn: 70, widthIn: 36, railIn: 5 };
export const DEFAULT_ASPECT = 16 / 9;
export const PATTERNS = ['table', 'outline', 'grid'];

const RIM_SAMPLES = 180;
const SMALLEST_REFIT = 0.4;
const REFIT_STEP = 0.01;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every(isNumber);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

export function createDefaultCalibration(aspect = DEFAULT_ASPECT) {
  return {
    table: { ...DEFAULT_TABLE },
    corners: defaultCorners(DEFAULT_TABLE, aspect),
    offsets: {},
    themeId: themeById().id,
    pattern: PATTERNS[0],
  };
}

// Returns a clean calibration, or null when `raw` can't be trusted. Unknown fine points,
// themes and patterns are dropped rather than rejected, so older saves keep working.
export function sanitizeCalibration(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const { lengthIn, widthIn, railIn } = raw.table ?? {};
  if (![lengthIn, widthIn, railIn].every(isNumber)) return null;
  if (!Array.isArray(raw.corners) || raw.corners.length !== 4 || !raw.corners.every(isPair)) {
    return null;
  }

  const table = normalizeTable({ lengthIn, widthIn, railIn });
  if (!isUsableQuad(table, raw.corners)) return null;

  const offsets = {};
  for (const { id } of controlPoints(table).fine) {
    if (isPair(raw.offsets?.[id])) offsets[id] = raw.offsets[id];
  }

  return {
    table,
    corners: raw.corners.map(([x, y]) => [x, y]),
    offsets,
    themeId: themeById(raw.themeId).id,
    pattern: PATTERNS.includes(raw.pattern) ? raw.pattern : PATTERNS[0],
  };
}

export function calibrationPoints(calibration, warp) {
  const { keystone, fine } = controlPoints(calibration.table);
  return [
    ...keystone.map((point, i) => ({
      ...point,
      kind: 'keystone',
      position: calibration.corners[i],
    })),
    ...fine.map((point) => ({
      ...point,
      kind: 'fine',
      position: warp.forward(point.x, point.y),
    })),
    { id: 'move', kind: 'move', label: 'Move whole table', position: warp.forward(0, 0) },
  ];
}

function withCorner(calibration, index, [x, y]) {
  const corners = calibration.corners.map((corner) => [...corner]);
  corners[index] = [clamp01(x), clamp01(y)];
  return isUsableQuad(calibration.table, corners) ? { ...calibration, corners } : calibration;
}

function withTableMoved(calibration, warp, [x, y]) {
  const [cx, cy] = warp.forward(0, 0);
  const xs = calibration.corners.map((corner) => corner[0]);
  const ys = calibration.corners.map((corner) => corner[1]);
  const dx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), x - cx));
  const dy = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), y - cy));
  return {
    ...calibration,
    corners: calibration.corners.map(([px, py]) => [px + dx, py + dy]),
  };
}

function withFineMoved(calibration, warp, id, [x, y]) {
  const point = controlPoints(calibration.table).fine.find((candidate) => candidate.id === id);
  const [tableX, tableY] = warp.toTable(x, y);
  const limit = calibration.table.widthIn / 4;
  const clamp = (value) => Math.min(limit, Math.max(-limit, value));
  return {
    ...calibration,
    offsets: {
      ...calibration.offsets,
      [id]: [clamp(tableX - point.x), clamp(tableY - point.y)],
    },
  };
}

// Returns the calibration with one point moved to a normalized output position. A move
// that would wreck the warp returns the input unchanged.
export function movePoint(calibration, warp, id, position) {
  const index = controlPoints(calibration.table).keystone.findIndex((point) => point.id === id);
  if (index >= 0) return withCorner(calibration, index, position);
  if (id === 'move') return withTableMoved(calibration, warp, position);
  return withFineMoved(calibration, warp, id, position);
}

function isOnWall({ table, corners, offsets }) {
  const warp = createWarp(table, corners, offsets);
  const perimeter = perimeterAt(table, 0);
  return Array.from({ length: RIM_SAMPLES }, (_, i) =>
    warp.forward(...pointOnPill(table, 0, (perimeter * i) / RIM_SAMPLES)),
  ).every(([x, y]) => x === clamp01(x) && y === clamp01(y));
}

// The new table as a scaled copy on the old table's keystone. That leaves fine offsets out of the
// corners, where they would count twice, and scales them so each bend keeps its size on the wall.
function refit(calibration, table, scale) {
  const { keystone } = controlPoints(table);
  const flat = createWarp(calibration.table, calibration.corners, {});
  const offsets = Object.entries(calibration.offsets).map(([id, [x, y]]) => [
    id,
    [x / scale, y / scale],
  ]);
  return {
    ...calibration,
    table,
    corners: keystone.map(({ x, y }) => flat.forward(x * scale, y * scale)),
    offsets: Object.fromEntries(offsets),
  };
}

// Returns the calibration at a new table size, or null when the table can't go on the wall. The
// keystone points move with the length and width, so corners left where they were would squash
// the table. This keeps the keystone and takes the biggest size that fits inside the old table,
// then shrinks further if that still hangs off the wall.
export function resizeTable(calibration, table) {
  const { lengthIn, widthIn } = calibration.table;
  if (table.lengthIn === lengthIn && table.widthIn === widthIn) return { ...calibration, table };
  const fit = Math.min(lengthIn / table.lengthIn, widthIn / table.widthIn);
  for (let shrink = 1; shrink > SMALLEST_REFIT; shrink -= REFIT_STEP) {
    const next = refit(calibration, table, fit * shrink);
    if (isOnWall(next)) return next;
  }
  return null;
}
