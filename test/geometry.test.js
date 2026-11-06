import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createGame, toView } from '../game/engine.js';
import { drawGame } from '../public/js/gameArt.js';
import {
  SPRITE_CELLS,
  chipPath,
  controlPoints,
  createWarp,
  defaultCorners,
  gridIndices,
  isConvex,
  isUsableQuad,
  meshIndices,
  normalizeTable,
  overlaps,
  perimeterAt,
  pointOnPill,
  seatLayout,
  spriteIndices,
} from '../public/js/geometry.js';
import { themeById } from '../public/js/themes.js';

const table = { lengthIn: 96, widthIn: 48, railIn: 3 };
const skewed = [
  [0.31, 0.22],
  [0.72, 0.18],
  [0.8, 0.83],
  [0.24, 0.76],
];

function assertClose(actual, expected, tolerance = 1e-6) {
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} is not close to ${expected}`);
  });
}

test('keystone points land exactly on their corners', () => {
  const warp = createWarp(table, skewed, {});
  controlPoints(table).keystone.forEach((point, i) => {
    assertClose(warp.forward(point.x, point.y), skewed[i]);
  });
});

test('toTable reverses a keystone-only warp', () => {
  const warp = createWarp(table, skewed, {});
  assertClose(warp.toTable(...warp.forward(17, -9)), [17, -9]);
});

test('a perspective warp keeps straight lines straight', () => {
  const warp = createWarp(table, skewed, {});
  const [ax, ay] = warp.forward(-30, -10);
  const [bx, by] = warp.forward(0, -10);
  const [cx, cy] = warp.forward(30, -10);
  assert.ok(Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) < 1e-9);
});

test('a fine offset moves its own point and leaves the keystone pinned', () => {
  const offsets = { 'r-tip': [2.5, -1.5] };
  const warp = createWarp(table, skewed, offsets);
  const base = createWarp(table, skewed, {});
  const tip = controlPoints(table).fine.find((point) => point.id === 'r-tip');

  assertClose(warp.forward(tip.x, tip.y), base.forward(tip.x + 2.5, tip.y - 1.5));
  controlPoints(table).keystone.forEach((point, i) => {
    assertClose(warp.forward(point.x, point.y), skewed[i]);
  });
});

test('fine offsets stay attached to the table when the keystone changes', () => {
  const offsets = { top: [0, -2] };
  const moved = skewed.map(([x, y]) => [x + 0.05, y - 0.02]);
  const warp = createWarp(table, moved, offsets);
  const top = controlPoints(table).fine.find((point) => point.id === 'top');
  assertClose(warp.forward(top.x, top.y), createWarp(table, moved, {}).forward(top.x, top.y - 2));
});

test('mesh vertices sit on the same warp as forward()', () => {
  const warp = createWarp(table, skewed, { 'l-tip': [1, 1] });
  const data = warp.vertices();
  const stride = 5;
  const center = (121 * 30 + 60) * stride;
  const w = data[center + 2];
  const [x, y] = [(data[center] / w + 1) / 2, (1 - data[center + 1] / w) / 2];
  assertClose([x, y], warp.forward(0, 0), 1e-5);
});

test('isConvex rejects crossed and concave quads', () => {
  assert.ok(isConvex(skewed));
  assert.equal(isConvex([skewed[0], skewed[2], skewed[1], skewed[3]]), false);
  assert.equal(isConvex([[0, 0], [1, 0], [0.2, 0.2], [0, 1]]), false);
});

test('isUsableQuad allows real keystone and refuses a near-collapsed quad', () => {
  assert.ok(isUsableQuad(table, skewed));
  const collapsing = [[0.28, 0.1], [0.72, 0.1], [0.3, 0.12], [0.285, 0.89]];
  assert.ok(isConvex(collapsing) === false || !isUsableQuad(table, collapsing));
  const barelyConvex = [[0.28, 0.1], [0.72, 0.1], [0.5, 0.55], [0.28, 0.89]];
  assert.ok(isConvex(barelyConvex));
  assert.equal(isUsableQuad(table, barelyConvex), false);
});

test('normalizeTable keeps a straight section', () => {
  assert.deepEqual(normalizeTable({ lengthIn: 40, widthIn: 48, railIn: 20 }), {
    lengthIn: 60,
    widthIn: 48,
    railIn: 8,
  });
});

test('default corners keep the table proportional on screen', () => {
  const aspect = 16 / 9;
  const [tl, tr, , bl] = defaultCorners(table, aspect);
  const straightPx = (tr[0] - tl[0]) * aspect;
  const widthPx = bl[1] - tl[1];
  assert.ok(Math.abs(straightPx / widthPx - 1) < 1e-9);
});

const gameTable = { lengthIn: 70, widthIn: 36, railIn: 5 };
const tableSizes = [
  gameTable,
  { lengthIn: 96, widthIn: 48, railIn: 3 },
  { lengthIn: 48, widthIn: 36, railIn: 5 },
  { lengthIn: 84, widthIn: 72, railIn: 8 },
  { lengthIn: 144, widthIn: 24, railIn: 0 },
  { lengthIn: 60, widthIn: 24, railIn: 4 },
  { lengthIn: 100, widthIn: 30, railIn: 6 },
];

function clip(warp, x, y) {
  const [X, Y, W] = warp.vertexAt(x, y);
  return [(X / W + 1) / 2, (1 - Y / W) / 2];
}

test('vertexAt lands on the same point as forward()', () => {
  const warp = createWarp(table, skewed, { 'l-tip': [1, 1], top: [0, -2] });
  for (const [x, y] of [[0, 0], [-30, 12], [41, -20]]) {
    assertClose(clip(warp, x, y), warp.forward(x, y), 1e-9);
  }
});

test('vertexAt keeps w for perspective-correct texturing', () => {
  const warp = createWarp(table, skewed, {});
  const [, , left] = warp.vertexAt(-40, 0);
  const [, , right] = warp.vertexAt(40, 0);
  assert.ok(left > 0 && right > 0);
  assert.notEqual(left, right);
});

test('spriteVertices cover the asked-for square of table, through the warp', () => {
  const warp = createWarp(table, skewed, { 'r-tip': [2, 1] });
  const data = warp.spriteVertices(10, -4, 6);
  const side = SPRITE_CELLS + 1;
  assert.equal(data.length, side * side * 5);
  const corner = (col, row) => data.subarray((row * side + col) * 5, (row * side + col) * 5 + 5);
  const point = (vertex) => [(vertex[0] / vertex[2] + 1) / 2, (1 - vertex[1] / vertex[2]) / 2];

  assertClose(point(corner(0, 0)), warp.forward(7, -7), 1e-5);
  assertClose(point(corner(SPRITE_CELLS, SPRITE_CELLS)), warp.forward(13, -1), 1e-5);
  assertClose([...corner(0, 0).subarray(3)], [0, 0]);
  assertClose([...corner(SPRITE_CELLS, SPRITE_CELLS).subarray(3)], [1, 1]);
});

test('grid indices stay inside their vertices, for the table and the sprite', () => {
  assert.equal(gridIndices(2, 3).length, 2 * 3 * 6);
  assert.equal(Math.max(...gridIndices(2, 3)), 3 * 4 - 1);
  assert.equal(meshIndices().length, 120 * 60 * 6);
  assert.equal(Math.max(...spriteIndices()), (SPRITE_CELLS + 1) ** 2 - 1);
});

test('pointOnPill heads left from bottom center, which is clockwise on screen', () => {
  const r = gameTable.widthIn / 2;
  const s = (gameTable.lengthIn - gameTable.widthIn) / 2;
  assertClose(pointOnPill(gameTable, 0, 0), [0, r]);
  assertClose(pointOnPill(gameTable, 0, 5), [-5, r]);
  const perimeter = perimeterAt(gameTable, 0);
  assertClose(pointOnPill(gameTable, 0, perimeter / 4), [-s - r, 0]);
  assertClose(pointOnPill(gameTable, 0, perimeter / 2), [0, -r]);
  assertClose(pointOnPill(gameTable, 0, (perimeter * 3) / 4), [s + r, 0]);
  assertClose(pointOnPill(gameTable, 0, perimeter), [0, r]);
});

test('seats sit at their share of the way around, clockwise from bottom center', () => {
  for (let count = 2; count <= 9; count += 1) {
    const { seats } = seatLayout(gameTable, count);
    const angle = ({ plate }) => {
      const turned = Math.atan2(-plate.x, plate.y);
      return turned < 0 ? turned + Math.PI * 2 : turned;
    };
    const angles = seats.map(angle);
    assert.ok(angles.every((value, i) => i === 0 || value > angles[i - 1]), `${count}: ${angles}`);
    seats.forEach(({ plate }, i) => {
      const mirror = seats[count - 1 - i].plate;
      assert.ok(Math.abs(plate.x + mirror.x) < 1e-6 && Math.abs(plate.y - mirror.y) < 1e-6);
    });
  }
});

test('two players sit at the two tips, and an odd count puts one at top center', () => {
  const [left, right] = seatLayout(gameTable, 2).seats;
  assert.ok(left.plate.x < 0 && Math.abs(left.plate.y) < 1e-6);
  assert.ok(right.plate.x > 0 && Math.abs(right.plate.y) < 1e-6);
  const { seats } = seatLayout(gameTable, 9);
  assert.ok(Math.abs(seats[4].plate.x) < 1e-6 && seats[4].plate.y < 0);
});

test('plates, bets and chips never collide, at any player count or table size', () => {
  for (const size of tableSizes) {
    for (let count = 2; count <= 9; count += 1) {
      const { seats } = seatLayout(size, count);
      const where = `${size.lengthIn}x${size.widthIn}, ${count} players`;
      seats.forEach((a, i) => {
        seats.forEach((b, j) => {
          if (i === j) return;
          assert.ok(!overlaps(a.plate, b.plate), `plates ${i},${j} at ${where}`);
          for (const tab of [a.bet, a.dealerBet]) {
            assert.ok(!overlaps(tab, b.plate), `bet ${i} on plate ${j} at ${where}`);
            assert.ok(!overlaps(tab, b.bet), `bets ${i},${j} at ${where}`);
            assert.ok(!overlaps(tab, b.chip), `bet ${i} under chip ${j} at ${where}`);
          }
          assert.ok(!overlaps(a.chip, b.plate), `chip ${i} on plate ${j} at ${where}`);
        });
        assert.ok(!overlaps(a.dealerBet, a.chip), `dealer bet ${i} at ${where}`);
      });
    }
  }
});

test('every plate stays inside the pill', () => {
  for (const size of tableSizes) {
    const r = size.widthIn / 2;
    const s = (size.lengthIn - size.widthIn) / 2;
    for (let count = 1; count <= 9; count += 1) {
      const { seats, corner } = seatLayout(size, count);
      for (const { plate } of seats) {
        const dx = Math.max(Math.abs(plate.x) + plate.w / 2 - corner - s, 0);
        const reach = Math.hypot(dx, Math.abs(plate.y) + plate.h / 2 - corner) + corner;
        assert.ok(reach <= r + 1e-6, `${size.lengthIn}x${size.widthIn}, ${count}: ${reach}`);
      }
    }
  }
});

test('the center block clears everything and stays big enough to read', () => {
  for (const size of tableSizes) {
    for (let count = 0; count <= 9; count += 1) {
      const { seats, center } = seatLayout(size, count);
      const where = `${size.lengthIn}x${size.widthIn}, ${count} players`;
      for (const { plate, bet, dealerBet, chip } of seats) {
        for (const rect of [plate, bet, dealerBet, chip]) {
          assert.ok(!overlaps(center, rect), `center at ${where}`);
        }
      }
      assert.ok(center.w > size.widthIn * 0.4, `center ${center.w} wide at ${where}`);
      assert.ok(center.h > size.widthIn * 0.2, `center ${center.h} tall at ${where}`);
    }
  }
});

test('chipPath starts and ends exactly on its two spots', () => {
  const layout = seatLayout(gameTable, 6);
  const [from, to] = [layout.seats[0].chip, layout.seats[2].chip].map(({ x, y }) => [x, y]);
  const path = chipPath(layout, from, to);
  assertClose(path(0), from, 1e-9);
  assertClose(path(1), to, 1e-9);
});

function sweep(path) {
  let total = 0;
  let last = null;
  for (let i = 0; i <= 200; i += 1) {
    const [x, y] = path(i / 200);
    const angle = Math.atan2(y, x);
    if (last !== null) {
      let step = angle - last;
      if (step > Math.PI) step -= Math.PI * 2;
      if (step < -Math.PI) step += Math.PI * 2;
      total += step;
    }
    last = angle;
  }
  return total;
}

test('chipPath always runs clockwise, even when the next dealer is just behind', () => {
  for (let count = 2; count <= 9; count += 1) {
    const layout = seatLayout(gameTable, count);
    layout.seats.forEach(({ chip }, seat) => {
      for (let step = 1; step < count; step += 1) {
        const next = layout.seats[(seat + step) % count].chip;
        const turned = sweep(chipPath(layout, [chip.x, chip.y], [next.x, next.y]));
        const expected = (Math.PI * 2 * step) / count;
        assert.ok(turned > 0, `${count} players, ${seat} by ${step}: ${turned}`);
        assert.ok(Math.abs(turned - expected) < 1.5, `${turned} is not near ${expected}`);
      }
    });
  }
});

test('chipPath can run back the other way, for an undone hand', () => {
  const layout = seatLayout(gameTable, 6);
  const [from, to] = [layout.seats[3].chip, layout.seats[2].chip].map(({ x, y }) => [x, y]);
  assert.ok(sweep(chipPath(layout, from, to, -1)) < 0);
  assert.ok(sweep(chipPath(layout, from, to, -1)) > -Math.PI);
});

test('chipPath never leaves the table', () => {
  for (let count = 2; count <= 9; count += 1) {
    const layout = seatLayout(gameTable, count);
    const { chip: first } = layout.seats[0];
    for (const { chip } of layout.seats.slice(1)) {
      const path = chipPath(layout, [first.x, first.y], [chip.x, chip.y]);
      for (let i = 0; i <= 50; i += 1) {
        const [x, y] = path(i / 50);
        const s = (gameTable.lengthIn - gameTable.widthIn) / 2;
        assert.ok(Math.hypot(Math.max(Math.abs(x) - s, 0), y) < gameTable.widthIn / 2);
      }
    }
  }
});

test('chipPath only ever brushes the plates of the players it passes', () => {
  const inside = ([x, y], { x: px, y: py, w, h }) =>
    Math.abs(x - px) < w / 2 && Math.abs(y - py) < h / 2;
  for (let count = 2; count <= 9; count += 1) {
    const layout = seatLayout(gameTable, count);
    const { seats } = layout;
    seats.forEach(({ chip }, seat) => {
      for (let step = 1; step < count; step += 1) {
        const to = (seat + step) % count;
        const target = seats[to].chip;
        const path = chipPath(layout, [chip.x, chip.y], [target.x, target.y]);
        for (let i = 1; i < 40; i += 1) {
          const point = path(i / 40);
          seats.forEach(({ plate }, other) => {
            const why = `${count} players, ${seat} to ${to}, over ${other}`;
            if (other !== seat && other !== to) assert.ok(!inside(point, plate), why);
          });
        }
      }
    });
  }
});

test('the game layout scales with the table', () => {
  const small = seatLayout(gameTable, 6);
  const big = seatLayout({ lengthIn: 140, widthIn: 72, railIn: 10 }, 6);
  assert.ok(Math.abs(big.seats[0].plate.h / small.seats[0].plate.h - 2) < 1e-9);
  assert.ok(Math.abs(big.chipRadius / small.chipRadius - 2) < 1e-9);
});

function viewAfter(names, actions) {
  const seated = names.map((name) => ({ type: 'addPlayer', name }));
  const state = [...seated, { type: 'startGame' }, ...actions].reduce(
    (game, action) => applyAction(game, action),
    createGame(),
  );
  return toView(state);
}

// Stands in for a canvas and keeps what the scene wrote and each shape it filled.
function paint(game) {
  const record = { texts: [], fills: [], rect: null };
  const ctx = new Proxy(
    {
      measureText: (value) => ({ width: value.length * 50 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillText: (value) => record.texts.push(value),
      roundRect: (...rect) => {
        record.rect = rect;
      },
      fill: () => record.fills.push({ rect: record.rect, style: ctx.fillStyle }),
    },
    { get: (target, key) => target[key] ?? (() => {}) },
  );
  drawGame(ctx, gameTable, themeById('noir'), game);
  return record;
}

test('the wall names the winner when everyone else folded', () => {
  const game = viewAfter(['Ann', 'Ben', 'Cal'], [{ type: 'fold' }, { type: 'fold' }]);
  assert.equal(game.phase, 'showdown');
  const { texts } = paint(game);
  assert.ok(texts.includes('Cal wins'), texts.join());
  assert.ok(!texts.includes('Showdown'));
});

test('the wall says Showdown while any pot is contested', () => {
  const street = [{ type: 'nextStreet' }, { type: 'check' }, { type: 'check' }];
  const game = viewAfter(['Ann', 'Ben'], [
    { type: 'call' },
    { type: 'check' },
    ...street,
    ...street,
    ...street,
  ]);
  assert.equal(game.phase, 'showdown');
  assert.ok(paint(game).texts.includes('Showdown'));

  const [ann, ben] = game.players;
  const pots = [
    { label: 'Main pot', amount: 15, eligibleIds: [ann.id, ben.id] },
    { label: 'Side pot 1', amount: 5, eligibleIds: [ben.id] },
  ];
  const { texts } = paint({ ...game, pots });
  assert.ok(texts.includes('Showdown'));
  assert.ok(!texts.includes('Ben wins'));
});

test('folded and out plates are solid, so nothing on the table shows through them', () => {
  const game = viewAfter(['Ann', 'Ben', 'Cal'], [{ type: 'fold' }]);
  const [first, second, third] = game.players;
  const players = [first, { ...second, status: 'out' }, third];
  const { fills } = paint({ ...game, players });
  const { seats } = seatLayout(gameTable, players.length);
  for (const seat of [0, 1]) {
    const { x, y, w, h } = seats[seat].plate;
    const { style } = fills.find(({ rect }) => rect?.[0] === x - w / 2 && rect?.[1] === y - h / 2);
    assert.match(style, /^#[0-9a-f]{6}$/i, `seat ${seat}`);
  }
});
