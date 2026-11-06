// All table geometry is in inches, with the origin at the table's center.
// Output positions are normalized to the viewport: (0,0) top left, (1,1) bottom right.
//
// The warp has two stages:
//   1. A homography pinned by four keystone points. A flat table under a projector
//      is exactly this transform, so these four points do the real calibration.
//   2. A thin-plate spline of small table-space offsets, driven by the fine points.
//      It absorbs a table that isn't a perfect pill and survives keystone changes,
//      because the offsets describe the table rather than the projector.

export const MARGIN_IN = 2;
export const MESH_COLS = 120;
export const MESH_ROWS = 60;
export const SPRITE_CELLS = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeTable({ lengthIn, widthIn, railIn }) {
  const width = clamp(widthIn, 24, 72);
  return {
    // A pill needs a straight section, otherwise the keystone points collapse together.
    lengthIn: clamp(lengthIn, width + 12, 144),
    widthIn: width,
    railIn: clamp(railIn, 0, 8),
  };
}

export function tableBounds({ lengthIn, widthIn }) {
  return { halfW: lengthIn / 2 + MARGIN_IN, halfH: widthIn / 2 + MARGIN_IN };
}

// `distance` runs clockwise on screen from bottom center, so it heads left first.
export function pointOnPill({ lengthIn, widthIn }, inset, distance) {
  const r = widthIn / 2 - inset;
  const s = (lengthIn - widthIn) / 2;
  const arc = Math.PI * r;
  const perimeter = 4 * s + 2 * arc;
  let d = ((distance % perimeter) + perimeter) % perimeter;

  if (d < s) return [-d, r];
  d -= s;
  if (d < arc) {
    const angle = Math.PI / 2 + d / r;
    return [-s + r * Math.cos(angle), r * Math.sin(angle)];
  }
  d -= arc;
  if (d < 2 * s) return [-s + d, -r];
  d -= 2 * s;
  if (d < arc) {
    const angle = -Math.PI / 2 + d / r;
    return [s + r * Math.cos(angle), r * Math.sin(angle)];
  }
  return [s - (d - arc), r];
}

export function perimeterAt({ lengthIn, widthIn }, inset) {
  return 2 * (lengthIn - widthIn) + 2 * Math.PI * (widthIn / 2 - inset);
}

export function controlPoints({ lengthIn, widthIn }) {
  const r = widthIn / 2;
  const s = lengthIn / 2 - r;
  const c = r * Math.SQRT1_2;
  return {
    keystone: [
      { id: 'tl', x: -s, y: -r, label: 'Keystone, top left' },
      { id: 'tr', x: s, y: -r, label: 'Keystone, top right' },
      { id: 'br', x: s, y: r, label: 'Keystone, bottom right' },
      { id: 'bl', x: -s, y: r, label: 'Keystone, bottom left' },
    ],
    fine: [
      { id: 'top', x: 0, y: -r, label: 'Top rail, center' },
      { id: 'r-up', x: s + c, y: -c, label: 'Right end, upper' },
      { id: 'r-tip', x: s + r, y: 0, label: 'Right end, tip' },
      { id: 'r-down', x: s + c, y: c, label: 'Right end, lower' },
      { id: 'bottom', x: 0, y: r, label: 'Bottom rail, center' },
      { id: 'l-down', x: -s - c, y: c, label: 'Left end, lower' },
      { id: 'l-tip', x: -s - r, y: 0, label: 'Left end, tip' },
      { id: 'l-up', x: -s - c, y: -c, label: 'Left end, upper' },
    ],
  };
}

export function defaultCorners({ lengthIn, widthIn }, aspect) {
  const perInch = Math.min((0.86 * aspect) / lengthIn, 0.8 / widthIn);
  const dx = ((lengthIn - widthIn) / 2) * (perInch / aspect);
  const dy = (widthIn / 2) * perInch;
  return [
    [0.5 - dx, 0.5 - dy],
    [0.5 + dx, 0.5 - dy],
    [0.5 + dx, 0.5 + dy],
    [0.5 - dx, 0.5 + dy],
  ];
}

// A crossed or concave quad folds the image over itself, so drags that would
// produce one are refused.
export function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const [cx, cy] = quad[(i + 2) % 4];
    const turn = Math.sign((bx - ax) * (cy - by) - (by - ay) * (cx - bx));
    if (turn === 0 || (sign !== 0 && turn !== sign)) return false;
    sign = turn;
  }
  return true;
}

function solve(matrix, rhs) {
  const n = rhs.length;
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-12) throw new Error('Singular matrix');
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = rows[row][col] / rows[col][col];
      for (let k = col; k <= n; k += 1) rows[row][k] -= factor * rows[col][k];
    }
  }
  const out = new Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = rows[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= rows[row][k] * out[k];
    out[row] = sum / rows[row][row];
  }
  return out;
}

export function homography(from, to) {
  const matrix = [];
  const rhs = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  return [...solve(matrix, rhs), 1];
}

function invert3([a, b, c, d, e, f, g, h, i]) {
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

const applyH = (H, x, y) => [
  H[0] * x + H[1] * y + H[2],
  H[3] * x + H[4] * y + H[5],
  H[6] * x + H[7] * y + H[8],
];

// How far one end of the table can recede relative to the other. Real keystone is well
// inside this. Past it the table's horizon nears the image and the warp blows up.
const MAX_DEPTH_RATIO = 4;

// A quad too small for the solver is as unusable as a crossed one.
function quadHomography(table, corners) {
  try {
    return homography(controlPoints(table).keystone.map((p) => [p.x, p.y]), corners);
  } catch {
    return null;
  }
}

export function isUsableQuad(table, corners) {
  if (!isConvex(corners)) return false;
  const H = quadHomography(table, corners);
  if (!H) return false;
  const { halfW, halfH } = tableBounds(table);
  // w varies linearly across the table, so its extremes are at the corners of the mesh.
  const depths = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(
    ([sx, sy]) => applyH(H, sx * halfW, sy * halfH)[2] / H[8],
  );
  return Math.min(...depths) > 0 && Math.max(...depths) / Math.min(...depths) <= MAX_DEPTH_RATIO;
}

function thinPlateSpline(anchors, values, scale) {
  const n = anchors.length;
  const points = anchors.map(([x, y]) => [x / scale, y / scale]);
  const kernel = (dx, dy) => {
    const r2 = dx * dx + dy * dy;
    return r2 === 0 ? 0 : (r2 * Math.log(r2)) / 2;
  };

  const matrix = [];
  for (let i = 0; i < n; i += 1) {
    const row = points.map(([x, y]) => kernel(points[i][0] - x, points[i][1] - y));
    matrix.push([...row, 1, points[i][0], points[i][1]]);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const row = points.map(([x, y]) => [1, x, y][axis]);
    matrix.push([...row, 0, 0, 0]);
  }

  const weightsX = solve(matrix, [...values.map((v) => v[0]), 0, 0, 0]);
  const weightsY = solve(matrix, [...values.map((v) => v[1]), 0, 0, 0]);

  return (rawX, rawY) => {
    const x = rawX / scale;
    const y = rawY / scale;
    let dx = weightsX[n] + weightsX[n + 1] * x + weightsX[n + 2] * y;
    let dy = weightsY[n] + weightsY[n + 1] * x + weightsY[n + 2] * y;
    for (let i = 0; i < n; i += 1) {
      const u = kernel(x - points[i][0], y - points[i][1]);
      dx += weightsX[i] * u;
      dy += weightsY[i] * u;
    }
    return [dx, dy];
  };
}

export function createWarp(table, corners, offsets) {
  const { keystone, fine } = controlPoints(table);
  const raw = homography(keystone.map((p) => [p.x, p.y]), corners);

  // Scaling so w = 1 at the table's center keeps w positive across the table,
  // which clip space needs.
  const centerW = raw[8];
  const H = raw.map((value) => value / centerW);
  const inverse = invert3(H);

  const anchors = [...keystone, ...fine].map((p) => [p.x, p.y]);
  const values = [...keystone, ...fine].map((p) => offsets[p.id] ?? [0, 0]);
  const hasOffsets = values.some(([dx, dy]) => dx !== 0 || dy !== 0);
  const spline = hasOffsets ? thinPlateSpline(anchors, values, table.lengthIn) : () => [0, 0];

  const forward = (x, y) => {
    const [dx, dy] = spline(x, y);
    const [X, Y, W] = applyH(H, x + dx, y + dy);
    return [X / W, Y / W];
  };

  // Undoes the keystone only, which is what a fine point's offset is measured against.
  const toTable = (u, v) => {
    const [x, y, w] = applyH(inverse, u, v);
    return [x / w, y / w];
  };

  // Each vertex is [clipX·w, clipY·w, w, u, v]. Passing w through lets the GPU do
  // perspective-correct texturing rather than warping each triangle affinely.
  const vertexAt = (x, y) => {
    const [dx, dy] = spline(x, y);
    const [X, Y, W] = applyH(H, x + dx, y + dy);
    return [2 * X - W, W - 2 * Y, W];
  };

  const grid = (cols, rows, left, top, width, height) => {
    const data = new Float32Array((cols + 1) * (rows + 1) * 5);
    let at = 0;
    for (let row = 0; row <= rows; row += 1) {
      const v = row / rows;
      for (let col = 0; col <= cols; col += 1) {
        const u = col / cols;
        data.set(vertexAt(left + u * width, top + v * height), at);
        data[at + 3] = u;
        data[at + 4] = v;
        at += 5;
      }
    }
    return data;
  };

  const vertices = () => {
    const { halfW, halfH } = tableBounds(table);
    return grid(MESH_COLS, MESH_ROWS, -halfW, -halfH, halfW * 2, halfH * 2);
  };

  // A small square of table centered on (x, y), for anything that moves on its own.
  const spriteVertices = (x, y, size) =>
    grid(SPRITE_CELLS, SPRITE_CELLS, x - size / 2, y - size / 2, size, size);

  return { forward, toTable, vertexAt, vertices, spriteVertices };
}

export function gridIndices(cols, rows) {
  const indices = new Uint16Array(cols * rows * 6);
  const stride = cols + 1;
  let at = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], at);
      at += 6;
    }
  }
  return indices;
}

export const meshIndices = () => gridIndices(MESH_COLS, MESH_ROWS);
export const spriteIndices = () => gridIndices(SPRITE_CELLS, SPRITE_CELLS);

// The game scene's layout. Every size is a fraction of the table, never fixed inches, and
// everything is a { x, y, w, h } rectangle around its center, so it can all be checked for
// overlaps. Plates stay upright: on a wall the whole room reads from the same side.

// The table every fraction here was tuned on: 70 by 36.
const REFERENCE_WIDTH = 36;
const REFERENCE_SHAPE = REFERENCE_WIDTH / 70;
const PLATE_HEIGHT = 0.2;
const PLATE_WIDTH_MAX = 0.415;
const PLATE_CORNER = 0.2; // of the plate's height
const PLATE_TRACK = 0.12; // inset of the path plate centers start on
const PUSH_KEEPS_HEIGHT = 0.5;
const EDGE_GAP = 0.012; // between a plate and the edge of the pill
const PLATE_GAP = 0.02;
const TAB_HEIGHT = 0.08;
const TAB_WIDTH = 0.27;
const TAB_WIDTH_MIN = 0.13;
const SIDE_TAB_WIDTH = 0.19;
const CHIP_RADIUS = 0.055;
const CHIP_LOOP_HEIGHT = 0.24; // from the center line to the top and bottom of the chip's loop
const CHIP_LOOP_WIDTH = 0.28; // how far either side of center those two runs hold straight
const CHIP_LOOP_INSET = 0.92; // the loop runs this far in from the resting spots, to miss plates
const CHIP_LOOP_SMOOTHING = 3;
const CHIP_SETTLE = 0.25; // the share of a trip spent easing between the loop and a resting spot
const CHIP_OVERLAP = 0.27; // of its radius, onto the plate's corner, where no text reaches
const TIP_ZONE = 0.3; // a plate this close to the center line, by its height, faces sideways
const FRONT_GAP = 0.008;
const CENTER_GAP = 0.006;
const CENTER_STEPS = 48;
const CENTER_ASPECT = 2;

// One measure for everything on the felt, so a stubby table scales like a smaller table rather
// than running out of room lengthways.
const unitOf = ({ lengthIn, widthIn }) => Math.min(widthIn, lengthIn * REFERENCE_SHAPE);

export const overlaps = (a, b, gap = 0) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;

const lerp = (from, to, amount) => from + (to - from) * amount;

// A rounded rectangle is inside the pill exactly when its corner circles are.
function plateFits(table, x, y, { w, h, corner }) {
  const s = (table.lengthIn - table.widthIn) / 2;
  const limit = table.widthIn / 2 - unitOf(table) * EDGE_GAP - corner;
  const dx = Math.max(Math.abs(x) + w / 2 - corner - s, 0);
  return Math.hypot(dx, Math.abs(y) + h / 2 - corner) <= limit;
}

// Slides a plate in until it stops poking out of the pill. On the curved ends it mostly slides
// sideways, which keeps the plates stacked there far enough apart for their bets.
function pushInside(table, [x, y], plate) {
  if (plateFits(table, x, y, plate)) return [x, y];
  const s = (table.lengthIn - table.widthIn) / 2;
  const toX = clamp(x, -s, s);
  const toY = y * PUSH_KEEPS_HEIGHT;
  let outside = 0;
  let inside = 1;
  for (let i = 0; i < 20; i += 1) {
    const middle = (outside + inside) / 2;
    if (plateFits(table, lerp(x, toX, middle), lerp(y, toY, middle), plate)) inside = middle;
    else outside = middle;
  }
  return [lerp(x, toX, inside), lerp(y, toY, inside)];
}

function placePlates(table, count, size) {
  const inset = unitOf(table) * PLATE_TRACK;
  const perimeter = perimeterAt(table, inset);
  return Array.from({ length: count }, (_, seat) => {
    const anchor = pointOnPill(table, inset, (perimeter * (seat + 0.5)) / count);
    const [x, y] = pushInside(table, anchor, size);
    return { x, y, w: size.w, h: size.h };
  });
}

function platesClear(plates, gap) {
  return plates.every((a, i) => plates.slice(i + 1).every((b) => !overlaps(a, b, gap)));
}

// The widest plates that leave a gap between neighbors around the whole table.
function fitPlates(table, count) {
  const unit = unitOf(table);
  const fullHeight = unit * PLATE_HEIGHT;
  const corner = fullHeight * PLATE_CORNER;
  const widest = unit * PLATE_WIDTH_MAX;
  let size = { w: widest, h: fullHeight, corner };
  for (let shrink = 1; shrink > 0.4; shrink -= 0.01) {
    size = { w: widest * shrink, h: fullHeight * Math.min(1, shrink * 1.4), corner };
    const plates = placePlates(table, count, size);
    if (platesClear(plates, unit * PLATE_GAP)) return plates;
  }
  return placePlates(table, count, size);
}

// A plate's front along its top or bottom edge, whichever faces the center line: a row with the
// bet tab and the dealer chip. The chip takes the end nearest the middle of the table, and a
// dealer's tab gives up that end.
function frontInRow(unit, { x, y, w, h }) {
  const radius = unit * CHIP_RADIUS;
  const tabH = unit * TAB_HEIGHT;
  const tabW = Math.min(w, unit * TAB_WIDTH);
  const inward = y < 0 ? 1 : -1;
  const edge = y + (inward * h) / 2;
  const end = x === 0 ? inward : -Math.sign(x);
  const chip = {
    x: x + end * (w / 2 - radius),
    y: edge + inward * radius * (1 - CHIP_OVERLAP),
    w: radius * 2,
    h: radius * 2,
  };
  const rowW = w - radius * 2 - unit * FRONT_GAP;
  const rowY = edge + (inward * tabH) / 2;
  return {
    bet: { x, y: rowY, w: tabW, h: tabH },
    dealerBet: { x: x - (end * (w - rowW)) / 2, y: rowY, w: Math.min(rowW, tabW), h: tabH },
    chip,
  };
}

// The same front on the side edge facing the middle, with the chip above or below the tab.
function frontToSide(unit, { x, y, w }, chipSide) {
  const radius = unit * CHIP_RADIUS;
  const tabH = unit * TAB_HEIGHT;
  const tabW = unit * SIDE_TAB_WIDTH;
  const inward = x < 0 ? 1 : -1;
  const edge = x + (inward * w) / 2;
  const bet = { x: edge + (inward * tabW) / 2, y, w: tabW, h: tabH };
  const chip = {
    x: edge + inward * radius * (1 - CHIP_OVERLAP),
    y: y + chipSide * (tabH / 2 + unit * FRONT_GAP + radius),
    w: radius * 2,
    h: radius * 2,
  };
  return { bet, dealerBet: bet, chip };
}

function frontOptions(unit, plate) {
  const clockwise = plate.x < 0 ? -1 : 1;
  const beside = [frontToSide(unit, plate, clockwise), frontToSide(unit, plate, -clockwise)];
  const atTip = Math.abs(plate.y) < plate.h * TIP_ZONE;
  return atTip ? beside : [frontInRow(unit, plate), ...beside];
}

// Cuts a tab back from anything it runs into, along its own row.
function trimTab(tab, others, gap) {
  let left = tab.x - tab.w / 2;
  let right = tab.x + tab.w / 2;
  for (const other of others) {
    if (!overlaps(tab, other, gap)) continue;
    if (other.x < tab.x) left = Math.max(left, other.x + other.w / 2 + gap);
    else right = Math.min(right, other.x - other.w / 2 - gap);
  }
  return { ...tab, x: (left + right) / 2, w: right - left };
}

// Plates furthest from the center line choose first because they have the least choice, and
// mirrored seats tie, which keeps the two sides of the table the same. Only one chip is ever on
// the table, so chips avoid plates and tabs but not each other.
function placeFronts(unit, plates) {
  const gap = unit * FRONT_GAP;
  const solid = [...plates];
  const chips = [];
  const clearOf = (rect, others) => others.every((other) => !overlaps(rect, other, gap));
  const order = plates
    .map((plate, seat) => ({ plate, seat }))
    .sort((a, b) => Math.abs(b.plate.y) - Math.abs(a.plate.y));
  const fronts = [];

  for (const { plate, seat } of order) {
    const others = solid.filter((rect) => rect !== plate);
    const options = frontOptions(unit, plate).map(({ bet, dealerBet, chip }) => ({
      bet: trimTab(bet, [...others, ...chips], gap),
      dealerBet: trimTab(dealerBet, [...others, ...chips], gap),
      chip,
    }));
    const isClear = ({ bet, dealerBet, chip }) =>
      Math.min(bet.w, dealerBet.w) >= unit * TAB_WIDTH_MIN &&
      clearOf(bet, [...others, ...chips]) &&
      clearOf(dealerBet, [...others, ...chips]) &&
      clearOf(chip, others);
    const front = options.find(isClear) ?? options[0];
    fronts[seat] = front;
    solid.push(front.bet, front.dealerBet);
    chips.push(front.chip);
  }
  return fronts;
}

function widestInFelt({ lengthIn, widthIn, railIn }, halfH) {
  const r = widthIn / 2 - railIn;
  return (lengthIn - widthIn) / 2 + Math.sqrt(Math.max(0, r * r - halfH * halfH));
}

function clearWidth(rects, halfH, width, gap) {
  let clear = width;
  for (const rect of rects) {
    if (rect.y + rect.h / 2 + gap <= -halfH || rect.y - rect.h / 2 - gap >= halfH) continue;
    clear = Math.min(clear, Math.max(Math.abs(rect.x) - rect.w / 2, 0) - gap);
  }
  return clear;
}

// The biggest centered block everything else leaves free. Past CENTER_ASPECT more width does
// nothing for the pot number, so height wins from there.
function centerBlock(table, rects) {
  const gap = unitOf(table) * CENTER_GAP;
  const tallest = table.widthIn / 2 - table.railIn - gap;
  let best = { w: 0, h: 0, score: 0 };
  for (let step = 1; step <= CENTER_STEPS; step += 1) {
    const halfH = (tallest * step) / CENTER_STEPS;
    const halfW = clearWidth(rects, halfH, widestInFelt(table, halfH + gap) - gap, gap);
    const score = Math.min(halfW, halfH * CENTER_ASPECT);
    if (score >= best.score) best = { w: halfW * 2, h: halfH * 2, score };
  }
  return { x: 0, y: 0, w: best.w, h: best.h };
}

// Seat order runs clockwise from bottom center, as a share of the way around the pill. `scale`
// is this table against the one the sizes were tuned on, for sizing type to match.
export function seatLayout(table, count) {
  const unit = unitOf(table);
  const plates = fitPlates(table, count);
  const fronts = placeFronts(unit, plates);
  const seats = plates.map((plate, seat) => ({ plate, ...fronts[seat] }));
  const rects = seats.flatMap(({ plate, bet, dealerBet, chip }) => [plate, bet, dealerBet, chip]);
  const center = centerBlock(table, rects);
  return {
    seats,
    center,
    corner: unit * PLATE_HEIGHT * PLATE_CORNER,
    chipRadius: unit * CHIP_RADIUS,
    scale: unit / REFERENCE_WIDTH,
  };
}

// Rounds off a closed polygon by cutting its corners. The result can't leave the polygon, so a
// chip riding it can't swing out into a plate.
function cutCorners(points, rounds) {
  let loop = points;
  for (let round = 0; round < rounds; round += 1) {
    loop = loop.flatMap(([x, y], i) => {
      const [nextX, nextY] = loop[(i + 1) % loop.length];
      return [
        [lerp(x, nextX, 0.25), lerp(y, nextY, 0.25)],
        [lerp(x, nextX, 0.75), lerp(y, nextY, 0.75)],
      ];
    });
  }
  return loop;
}

// How far clockwise a point is from bottom center, as an angle.
function clockwiseAngle([x, y]) {
  const angle = Math.atan2(-x, y);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

// The closed path the dealer chip rides: just inside the spot in front of every seat, so it
// passes each player in turn. Straight runs above and below center keep a short table going
// around the pot rather than through it, wherever no plate is in their way.
function chipLoop({ seats, scale, chipRadius }) {
  const unit = scale * REFERENCE_WIDTH;
  const spots = seats.map(({ chip }) => [chip.x * CHIP_LOOP_INSET, chip.y * CHIP_LOOP_INSET]);
  const runY = Math.max(unit * CHIP_LOOP_HEIGHT, ...spots.map(([, y]) => Math.abs(y)));
  const runX = unit * CHIP_LOOP_WIDTH;
  const chipAt = ([x, y]) => ({ x, y, w: chipRadius * 2, h: chipRadius * 2 });
  const isOpen = (stop) => seats.every(({ plate }) => !overlaps(chipAt(stop), plate));
  const runs = [-runX, 0, runX].flatMap((x) => [[x, runY], [x, -runY]]).filter(isOpen);
  const stops = [...spots, ...runs].sort((a, b) => clockwiseAngle(a) - clockwiseAngle(b));
  const points = cutCorners(stops, CHIP_LOOP_SMOOTHING);

  let length = 0;
  const distances = points.map(([x, y], i) => {
    const distance = length;
    const [nextX, nextY] = points[(i + 1) % points.length];
    length += Math.hypot(nextX - x, nextY - y);
    return distance;
  });

  const at = (distance) => {
    const d = ((distance % length) + length) % length;
    const index = distances.findLastIndex((start) => start <= d);
    const [x, y] = points[index];
    const [nextX, nextY] = points[(index + 1) % points.length];
    const along = (d - distances[index]) / ((distances[index + 1] ?? length) - distances[index]);
    return [lerp(x, nextX, along), lerp(y, nextY, along)];
  };

  const nearest = ([x, y]) => {
    const away = points.map(([px, py]) => Math.hypot(px - x, py - y));
    return distances[away.indexOf(Math.min(...away))];
  };

  return { length, at, nearest };
}

// How much of a resting spot's distance from the loop still applies, near that end of a trip.
function settled(fromEnd) {
  const t = clamp(fromEnd / CHIP_SETTLE, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

// The dealer chip's way from one spot to another, clockwise around the loop unless `direction`
// is -1. Takes progress from 0 to 1. Resting spots sit a little off the loop, so each end of the
// trip eases between the two, which also lets a trip start from anywhere.
export function chipPath(layout, from, to, direction = 1) {
  const loop = chipLoop(layout);
  const start = loop.nearest(from);
  const end = loop.nearest(to);
  const clockwise = (((end - start) % loop.length) + loop.length) % loop.length;
  const travel = direction > 0 ? clockwise : clockwise - loop.length;
  const [startX, startY] = loop.at(start);
  const [endX, endY] = loop.at(end);
  const fromOff = [from[0] - startX, from[1] - startY];
  const toOff = [to[0] - endX, to[1] - endY];

  return (progress) => {
    const [x, y] = loop.at(start + travel * progress);
    const leaving = settled(progress);
    const arriving = settled(1 - progress);
    return [
      x + fromOff[0] * leaving + toOff[0] * arriving,
      y + fromOff[1] * leaving + toOff[1] * arriving,
    ];
  };
}
