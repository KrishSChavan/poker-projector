import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TABLE,
  calibrationPoints,
  createDefaultCalibration,
  movePoint,
  resizeTable,
  sanitizeCalibration,
} from '../public/js/calibration.js';
import { createWarp, perimeterAt, pointOnPill } from '../public/js/geometry.js';
import { createCalibrationEditor } from '../server/calibrationEditor.js';

const warpFor = ({ table, corners, offsets }) => createWarp(table, corners, offsets);

test('the default calibration is the 70 by 36 table in the first theme', () => {
  const calibration = createDefaultCalibration();
  assert.deepEqual(calibration.table, DEFAULT_TABLE);
  assert.equal(calibration.themeId, 'emerald');
  assert.equal(calibration.pattern, 'table');
});

test('sanitizeCalibration keeps valid saves and drops unknown fields', () => {
  const saved = createDefaultCalibration();
  const clean = sanitizeCalibration({
    ...saved,
    themeId: 'gone',
    pattern: 'gone',
    offsets: { 'l-up': [1, 2], bogus: [3, 4], 'r-tip': 'nope' },
    extra: true,
  });
  assert.deepEqual(clean.offsets, { 'l-up': [1, 2] });
  assert.equal(clean.themeId, 'emerald');
  assert.equal(clean.pattern, 'table');
  assert.equal('extra' in clean, false);
});

test('a quad too small for the solver is refused rather than throwing', () => {
  const saved = createDefaultCalibration();
  const size = 1e-14;
  const corners = [
    [0.5, 0.5],
    [0.5 + size, 0.5],
    [0.5 + size, 0.5 + size],
    [0.5, 0.5 + size],
  ];
  assert.equal(sanitizeCalibration({ ...saved, corners }), null);

  const collapsing = { ...saved, corners: corners.with(0, saved.corners[0]) };
  const warp = warpFor(saved);
  const moved = movePoint(collapsing, warp, 'tl', [0.5, 0.5]);
  assert.equal(moved, collapsing);
});

test('sanitizeCalibration refuses a broken quad or a malformed shape', () => {
  const saved = createDefaultCalibration();
  const [a, b, c, d] = saved.corners;
  assert.equal(sanitizeCalibration({ ...saved, corners: [a, c, b, d] }), null);
  assert.equal(sanitizeCalibration({ ...saved, corners: [a, b, c] }), null);
  assert.equal(sanitizeCalibration({ ...saved, table: { lengthIn: 'x' } }), null);
  assert.equal(sanitizeCalibration(null), null);
});

test('calibrationPoints lists four keystone pins, eight fine points and the center', () => {
  const calibration = createDefaultCalibration();
  const points = calibrationPoints(calibration, warpFor(calibration));
  assert.equal(points.filter((point) => point.kind === 'keystone').length, 4);
  assert.equal(points.filter((point) => point.kind === 'fine').length, 8);
  assert.equal(points.filter((point) => point.kind === 'move').length, 1);
});

test('movePoint moves a keystone pin to the requested position', () => {
  const calibration = createDefaultCalibration();
  const moved = movePoint(calibration, warpFor(calibration), 'tl', [0.3, 0.2]);
  assert.deepEqual(moved.corners[0], [0.3, 0.2]);
  assert.deepEqual(moved.corners[1], calibration.corners[1]);
});

test('movePoint refuses a keystone move that would fold the table', () => {
  const calibration = createDefaultCalibration();
  const moved = movePoint(calibration, warpFor(calibration), 'br', [0.1, 0.1]);
  assert.equal(moved, calibration);
});

test('movePoint puts a fine point exactly where it was dragged', () => {
  const calibration = createDefaultCalibration();
  const warp = warpFor(calibration);
  const tip = calibrationPoints(calibration, warp).find((point) => point.id === 'r-tip');
  const target = [tip.position[0] + 0.01, tip.position[1] + 0.01];
  const moved = movePoint(calibration, warp, 'r-tip', target);
  const after = calibrationPoints(moved, warpFor(moved)).find((point) => point.id === 'r-tip');
  assert.ok(Math.abs(after.position[0] - target[0]) < 1e-6);
  assert.ok(Math.abs(after.position[1] - target[1]) < 1e-6);
});

test('movePoint slides the whole table but keeps it inside the output', () => {
  const calibration = createDefaultCalibration();
  const moved = movePoint(calibration, warpFor(calibration), 'move', [5, 5]);
  for (const [x, y] of moved.corners) {
    assert.ok(x <= 1 + 1e-9 && y <= 1 + 1e-9);
  }
  assert.ok(moved.corners[0][0] > calibration.corners[0][0]);
});

const WALL_ASPECT = 16 / 9;
const keystoned = {
  ...createDefaultCalibration(),
  corners: [
    [0.33, 0.2],
    [0.66, 0.16],
    [0.7, 0.86],
    [0.3, 0.8],
  ],
};
const newSizes = [
  { lengthIn: 90, widthIn: 36, railIn: 5 },
  { lengthIn: 60, widthIn: 36, railIn: 5 },
  { lengthIn: 70, widthIn: 42, railIn: 5 },
  { lengthIn: 56, widthIn: 28, railIn: 5 },
  { lengthIn: 144, widthIn: 24, railIn: 5 },
  { lengthIn: 48, widthIn: 36, railIn: 5 },
];

function assertNear(actual, expected, why, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${why}: ${actual} is not near ${expected}`);
}

function assertOnWall(calibration, why) {
  const { table } = calibration;
  const warp = warpFor(calibration);
  const perimeter = perimeterAt(table, 0);
  for (let i = 0; i < 720; i += 1) {
    const [x, y] = warp.forward(...pointOnPill(table, 0, (perimeter * i) / 720));
    const inside = Math.min(x, y, 1 - x, 1 - y);
    assert.ok(inside >= -1e-3, `${why}: rim leaves the wall at ${x}, ${y}`);
  }
}

// How far fine offsets move a point on the wall, against the same table with none.
function bendOf(calibration, id) {
  const place = (candidate) =>
    calibrationPoints(candidate, warpFor(candidate)).find((point) => point.id === id).position;
  const [x, y] = place(calibration);
  const [plainX, plainY] = place({ ...calibration, offsets: {} });
  return [x - plainX, y - plainY];
}

test('resizeTable gives a new length or width its true proportions on the wall', () => {
  const calibration = createDefaultCalibration();
  for (const table of newSizes) {
    const warp = warpFor(resizeTable(calibration, table));
    const [left] = warp.forward(-table.lengthIn / 2, 0);
    const [right] = warp.forward(table.lengthIn / 2, 0);
    const [, top] = warp.forward(0, -table.widthIn / 2);
    const [, bottom] = warp.forward(0, table.widthIn / 2);
    const shape = ((right - left) * WALL_ASPECT) / (bottom - top);
    assertNear(shape, table.lengthIn / table.widthIn, `${table.lengthIn}x${table.widthIn}`);
  }
});

test('resizeTable fits the new table inside the old one, on the same keystone', () => {
  const before = warpFor(keystoned);
  for (const table of newSizes) {
    const after = warpFor(resizeTable(keystoned, table));
    const fit = Math.min(70 / table.lengthIn, 36 / table.widthIn);
    for (const [x, y] of [[0, 0], [-table.lengthIn / 2, 0], [10, -table.widthIn / 2], [-12, 6]]) {
      const [u, v] = after.forward(x, y);
      const [expectedU, expectedV] = before.forward(x * fit, y * fit);
      assertNear(u, expectedU, `${table.lengthIn}x${table.widthIn} u`);
      assertNear(v, expectedV, `${table.lengthIn}x${table.widthIn} v`);
    }
  }
});

test('resizeTable leaves the points alone when only the rail changes', () => {
  const calibration = { ...keystoned, offsets: { top: [0, -2], 'r-tip': [1, 0.5] } };
  const resized = resizeTable(calibration, { ...calibration.table, railIn: 3 });
  assert.equal(resized.table.railIn, 3);
  assert.deepEqual(resized.corners, calibration.corners);
  assert.deepEqual(resized.offsets, calibration.offsets);
});

test('resizeTable keeps fine offsets out of the corners and each bend the same on the wall', () => {
  const plain = createDefaultCalibration();
  const bent = { ...plain, offsets: { top: [0, -2], 'r-tip': [1.5, 0.5], 'l-down': [-1, 1] } };
  for (const table of newSizes) {
    const resized = resizeTable(bent, table);
    assert.deepEqual(resized.corners, resizeTable(plain, table).corners);
    for (const id of Object.keys(bent.offsets)) {
      const [x, y] = bendOf(resized, id);
      const [expectedX, expectedY] = bendOf(bent, id);
      assertNear(x, expectedX, `${table.lengthIn}x${table.widthIn} ${id} x`, 1e-5);
      assertNear(y, expectedY, `${table.lengthIn}x${table.widthIn} ${id} y`, 1e-5);
    }
  }
});

test('resizeTable never leaves the table off the wall', () => {
  const movedRight = movePoint(keystoned, warpFor(keystoned), 'move', [0.8, 0.5]);
  const bendsOffWall = { ...movedRight, offsets: { 'r-tip': [3, 0], top: [0, -2] } };
  for (const calibration of [createDefaultCalibration(), keystoned, movedRight, bendsOffWall]) {
    for (const table of newSizes) {
      const resized = resizeTable(calibration, table);
      assertOnWall(resized, `${table.lengthIn}x${table.widthIn}`);
      assert.ok(resized.corners.flat().every((value) => value >= 0 && value <= 1));
    }
  }
});

test('resizeTable shrinks a table that hangs off the wall only as far as it has to', () => {
  const calibration = movePoint(keystoned, warpFor(keystoned), 'move', [0.8, 0.5]);
  const table = { lengthIn: 72, widthIn: 36, railIn: 5 };
  const [farRight] = warpFor(resizeTable(calibration, table)).forward(table.lengthIn / 2, 0);
  assert.ok(farRight > 0.98 && farRight <= 1, `right tip at ${farRight}`);
});

test('resizeTable refuses a size it cannot get onto the wall', () => {
  const table = { lengthIn: 48, widthIn: 36, railIn: 5 };
  const corners = [
    [0.97, 0.45],
    [0.999, 0.45],
    [0.999, 0.55],
    [0.97, 0.55],
  ];
  const calibration = sanitizeCalibration({ ...createDefaultCalibration(), table, corners });
  const next = resizeTable(calibration, { lengthIn: 50, widthIn: 36, railIn: 5 });
  assert.equal(next, null);
  assert.equal(sanitizeCalibration(next), null);
});

test('one undo takes a resized table back to its old corners and offsets', () => {
  const calibration = sanitizeCalibration({ ...keystoned, offsets: { top: [0, -2] } });
  const editor = createCalibrationEditor(calibration);
  const table = { lengthIn: 90, widthIn: 36, railIn: 5 };
  editor.begin();
  editor.update(sanitizeCalibration(resizeTable(calibration, table)));
  assert.notDeepEqual(editor.current.corners, calibration.corners);
  assert.notDeepEqual(editor.current.offsets, calibration.offsets);
  editor.undo();
  assert.deepEqual(editor.current, calibration);
  assert.equal(editor.canUndo, false);
});
