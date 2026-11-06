// The game scene, drawn in table space (inches, origin at center) into the same canvas the test
// patterns use, so the keystone applies to it automatically. A wall has far less contrast than a
// monitor and is read from across a room, so everything here is big, bold and bright, and type
// is sized from the table rather than in fixed inches.

import { seatLayout } from './geometry.js';
import { drawFelt, pill } from './tableArt.js';

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif';
const WHITE = '#FFFFFF';
const INK = '#07090A';
const ALL_IN = '#FF3B30';
const DIM_TEXT = 'rgba(255, 255, 255, 0.42)';

// Text narrows this far before it starts getting shorter, which keeps long names tall.
const MIN_SQUEEZE = 0.68;
const LEADING = 1.18;
const NUMBER_LEADING = 1.02;

// Center type in inches on a 36 inch wide table.
const TITLE_SIZE = 2.8;
const WAITING_SIZE = 4;
const NUMBER_SIZE = 11;
const ROW_SIZE = 2;
const FOOT_SIZE = 1.8;

// Shares of the center block's height. Each row of side pots takes a little from the pot number.
const TITLE_SHARE = 0.25;
const WAITING_SHARE = 0.42;
const NUMBER_SHARE = 0.46;
const NUMBER_SHARE_PER_ROW = 0.05;

const ROW_GAP = '     ';

const STREET_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

const chips = (amount) => amount.toLocaleString('en-US');

function roundedRect(ctx, { x, y, w, h }, radius) {
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, radius);
}

// Fits by narrowing first and then shrinking. Canvas font sizes misbehave at about 1px, so type
// is laid out at 100px and scaled down.
function drawText(ctx, value, x, y, options) {
  const { size, color, weight = 800, maxWidth = Infinity, halo } = options;
  ctx.save();
  ctx.font = `${weight} 100px ${FONT}`;
  const natural = (ctx.measureText(value).width * size) / 100;
  const squeeze = Math.min(1, Math.max(MIN_SQUEEZE, maxWidth / natural));
  const shrink = Math.min(1, maxWidth / (natural * squeeze));
  ctx.translate(x, y);
  ctx.scale(((size * shrink) / 100) * squeeze, (size * shrink) / 100);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (halo) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = 16;
    ctx.strokeText(value, 0, 0);
  }
  ctx.fillStyle = color;
  ctx.fillText(value, 0, 0);
  ctx.restore();
}

function textWidth(ctx, value, size, weight = 800) {
  ctx.save();
  ctx.font = `${weight} 100px ${FONT}`;
  const width = (ctx.measureText(value).width * size) / 100;
  ctx.restore();
  return width;
}

/* ---------- Plates ---------- */

function plateLook(player, game, theme) {
  const isWinner =
    (game.phase === 'handComplete' && player.payout > 0) || player.id === game.gameWinnerId;
  if (player.id === game.actingId || isWinner) {
    const { onAccent } = theme.ui;
    return {
      fill: theme.accent,
      edge: WHITE,
      edgeWidth: 0.11,
      name: onAccent,
      value: onAccent,
      badgeText: WHITE,
    };
  }
  if (player.status === 'folded' || player.status === 'out') {
    return { fill: INK, name: DIM_TEXT, value: DIM_TEXT, badgeText: INK };
  }
  return {
    fill: INK,
    edge: theme.line,
    edgeWidth: 0.028,
    name: WHITE,
    value: theme.line,
    badgeText: INK,
  };
}

function blindBadge(player, game) {
  if (player.id === game.smallBlindId) return 'SB';
  if (player.id === game.bigBlindId) return 'BB';
  return null;
}

function drawBadge(ctx, value, x, y, size, look) {
  const box = { x, y, w: size * 1.9, h: size * 1.32 };
  roundedRect(ctx, box, box.h * 0.3);
  ctx.fillStyle = look.name;
  ctx.fill();
  drawText(ctx, value, x, y, { size, color: look.badgeText, weight: 900 });
}

function drawAllIn(ctx, x, y, width, size) {
  const box = { x, y, w: width, h: size * 1.3 };
  roundedRect(ctx, box, box.h * 0.26);
  ctx.fillStyle = ALL_IN;
  ctx.fill();
  drawText(ctx, 'ALL IN', x, y, { size, color: WHITE, weight: 900, maxWidth: width * 0.9 });
}

// The stack, or ALL IN or OUT in its place, centered on the plate along with any blind badge.
function drawStackRow(ctx, player, game, plate, y, size, look) {
  const room = plate.w * 0.92;
  const badge = blindBadge(player, game);
  const badgeSize = size * 0.72;
  const badgeW = badge ? badgeSize * 1.9 : 0;
  const gap = badge ? size * 0.3 : 0;
  const maxWidth = room - badgeW - gap;
  const isAllIn = player.status === 'allIn';
  const value = player.status === 'out' ? 'OUT' : chips(player.stack);
  const width = isAllIn ? maxWidth : Math.min(maxWidth, textWidth(ctx, value, size));
  const left = plate.x - (badgeW + gap + width) / 2;
  const valueX = left + badgeW + gap + width / 2;

  if (badge) drawBadge(ctx, badge, left + badgeW / 2, y, badgeSize, look);
  if (isAllIn) drawAllIn(ctx, valueX, y, width, size);
  else drawText(ctx, value, valueX, y, { size, color: look.value, maxWidth });
}

function drawPlate(ctx, layout, seat, player, game, theme) {
  const { plate } = seat;
  const look = plateLook(player, game, theme);

  roundedRect(ctx, plate, layout.corner);
  ctx.fillStyle = look.fill;
  ctx.fill();
  if (look.edge) {
    ctx.strokeStyle = look.edge;
    ctx.lineWidth = plate.h * look.edgeWidth;
    ctx.stroke();
  }

  const size = plate.h * 0.4;
  const nameY = plate.y - plate.h * 0.215;
  drawText(ctx, player.name, plate.x, nameY, { size, color: look.name, maxWidth: plate.w * 0.92 });
  drawStackRow(ctx, player, game, plate, plate.y + plate.h * 0.24, size * 0.98, look);
}

/* ---------- Bets ---------- */

// The chip icon is only decoration, so a long amount drops it before it gets smaller.
function drawTab(ctx, rect, value, fill, color, icon) {
  const size = rect.h * 0.74;
  const padding = rect.h * 0.22;
  const natural = textWidth(ctx, value, size);
  const iconSize = size * 0.8;
  const iconRoom = iconSize + size * 0.28;
  const showIcon = Boolean(icon) && natural + iconRoom <= rect.w - padding * 2;
  const room = rect.w - padding * 2 - (showIcon ? iconRoom : 0);
  const width = Math.min(room, natural);
  const tab = { ...rect, w: width + (showIcon ? iconRoom : 0) + padding * 2 };
  roundedRect(ctx, tab, rect.h * 0.3);
  ctx.fillStyle = fill;
  ctx.fill();

  const left = rect.x - tab.w / 2 + padding;
  if (showIcon) {
    ctx.beginPath();
    ctx.arc(left + iconSize / 2, rect.y, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = icon;
    ctx.fill();
  }
  const textLeft = left + (showIcon ? iconRoom : 0);
  drawText(ctx, value, textLeft + width / 2, rect.y, { size, color, maxWidth: room });
}

function drawFront(ctx, seat, player, game, theme) {
  const rect = player.id === game.dealerId ? seat.dealerBet : seat.bet;
  if (player.payout > 0) {
    drawTab(ctx, rect, `+${chips(player.payout)}`, WHITE, INK, null);
  } else if (player.bet > 0) {
    drawTab(ctx, rect, chips(player.bet), INK, WHITE, theme.accent);
  }
}

/* ---------- Center ---------- */

const handLine = ({ handNumber, options }) =>
  `Hand ${handNumber}  ·  Blinds ${chips(options.smallBlind)} / ${chips(options.bigBlind)}`;

// One row holds up to three, and even a full table of pots needs only three rows.
function inRows(texts) {
  const perRow = texts.length === 4 ? 2 : 3;
  const rows = [];
  for (let i = 0; i < texts.length; i += perRow) {
    rows.push(texts.slice(i, i + perRow).join(ROW_GAP));
  }
  return rows;
}

function potRows(pots) {
  if (pots.length < 2) return [];
  const name = pots.length > 3 ? (label) => label.replace(' pot', '') : (label) => label;
  return inRows(pots.map(({ label, amount }) => `${name(label)}: ${chips(amount)}`));
}

function lobbyScene({ players, options }) {
  const count = players.length;
  const joined = count === 0 ? 'No players yet' : `${count} ${count === 1 ? 'player' : 'players'}`;
  const blinds = `Blinds ${chips(options.smallBlind)} / ${chips(options.bigBlind)}`;
  return {
    title: 'Waiting for the dealer',
    titleSize: WAITING_SIZE,
    titleShare: WAITING_SHARE,
    rows: [joined],
    foot: `${chips(options.startingChips)} chips  ·  ${blinds}`,
  };
}

// With everyone else folded there's nothing to show down, and no other hand leaves every pot with
// a single player: two players still in always share the main pot.
function showdownTitle({ pots, players }) {
  if (pots.some(({ eligibleIds }) => eligibleIds.length > 1)) return 'Showdown';
  const winner = players.find(({ id }) => id === pots[0].eligibleIds[0]);
  return `${winner.name} wins`;
}

function runningScene(game) {
  const titles = {
    betting: () => STREET_NAMES[game.street],
    streetClosed: () => `Deal the ${game.nextStreet}`,
    showdown: () => showdownTitle(game),
  };
  return {
    title: titles[game.phase](),
    number: chips(game.pot.total),
    rows: potRows(game.pots),
    foot: handLine(game),
  };
}

// The table has just changed. What the room wants to know is what the next hand will cost.
function betweenHandsScene({ handNumber, options, players }) {
  const seated = players.filter(({ stack }) => stack > 0).length;
  return {
    title: `Hand ${chips(handNumber + 1)} is next`,
    titleSize: WAITING_SIZE,
    titleShare: WAITING_SHARE,
    rows: [`Blinds ${chips(options.smallBlind)} / ${chips(options.bigBlind)}`],
    foot: `${seated} players`,
  };
}

// Every winner's plate shows their +amount, so the center only spells out a simple split.
function handCompleteScene(game) {
  const winners = game.players
    .filter((player) => player.payout > 0)
    .sort((a, b) => b.payout - a.payout);
  const total = winners.reduce((sum, player) => sum + player.payout, 0);
  const shared = game.result.pots.length === 1 ? 'Split pot' : 'Pots awarded';
  const named = winners.map(({ name, payout }) => `${name} +${chips(payout)}`);
  return {
    title: winners.length === 1 ? `${winners[0].name} wins` : shared,
    number: chips(total),
    rows: winners.length === 2 ? [named.join(ROW_GAP)] : [],
    foot: handLine(game),
  };
}

function gameOverScene(game) {
  const winner = game.players.find((player) => player.id === game.gameWinnerId);
  const { handNumber } = game;
  return {
    title: `${winner.name} wins the game`,
    number: chips(winner.stack),
    rows: [],
    foot: `${handNumber} ${handNumber === 1 ? 'hand' : 'hands'} played`,
  };
}

function centerScene(game) {
  if (game.phase === 'lobby') return lobbyScene(game);
  if (game.phase === 'handComplete') return handCompleteScene(game);
  if (game.phase === 'betweenHands') return betweenHandsScene(game);
  if (game.phase === 'gameOver') return gameOverScene(game);
  return runningScene(game);
}

function fittedSize(ctx, text, size, maxWidth) {
  return size * Math.min(1, maxWidth / (textWidth(ctx, text, size) * MIN_SQUEEZE));
}

// The title keeps its size, the number takes its share of the block, and the smaller lines fit
// into what's left. Whatever height the number doesn't need then goes to the number as well,
// which is what makes the pot the biggest number on the wall.
function sizeCenterLines(ctx, center, scene, unit, theme) {
  const { title, number, rows, foot } = scene;
  const { titleSize: wanted = TITLE_SIZE, titleShare = TITLE_SHARE } = scene;
  const titleSize = Math.min(wanted * unit, (center.h * titleShare) / LEADING);
  const smallHeight = (rows.length * ROW_SIZE + FOOT_SIZE) * unit * LEADING;
  const numberRoom = number ? center.h * (NUMBER_SHARE - NUMBER_SHARE_PER_ROW * rows.length) : 0;
  const smallRoom = center.h - titleSize * LEADING - numberRoom;
  const shrink = Math.min(1, smallRoom / smallHeight);
  const left = center.h - titleSize * LEADING - smallHeight * shrink;

  const line = (text, size, color, leading = LEADING) => ({
    text,
    color,
    leading,
    size: fittedSize(ctx, text, size, center.w),
  });
  const small = (text, size, color) => line(text, size * unit * shrink, color);
  return [
    line(title, titleSize, theme.line),
    ...(number
      ? [line(number, Math.min(NUMBER_SIZE * unit, left / NUMBER_LEADING), WHITE, NUMBER_LEADING)]
      : []),
    ...rows.map((text) => small(text, ROW_SIZE, WHITE)),
    small(foot, FOOT_SIZE, theme.line),
  ];
}

function drawCenter(ctx, center, scene, unit, theme) {
  const lines = sizeCenterLines(ctx, center, scene, unit, theme);
  const height = lines.reduce((sum, line) => sum + line.size * line.leading, 0);
  let y = center.y - height / 2;
  for (const line of lines) {
    const lineHeight = line.size * line.leading;
    const options = { ...line, maxWidth: center.w, halo: INK };
    drawText(ctx, line.text, center.x, y + lineHeight / 2, options);
    y += lineHeight;
  }
}

/* ---------- Scene ---------- */

// `game` can be null, which leaves the empty table.
export function drawGame(ctx, table, theme, game) {
  drawFelt(ctx, table, theme);
  // A theme with an unlit rail has no edge to its table without this.
  if (theme.rail === theme.felt) {
    pill(ctx, table, 0.08);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 0.16;
    ctx.stroke();
  }
  if (!game) return;

  const layout = seatLayout(table, game.players.length);
  const { seats } = layout;
  game.players.forEach((player, i) => drawFront(ctx, seats[i], player, game, theme));
  game.players.forEach((player, i) => drawPlate(ctx, layout, seats[i], player, game, theme));
  drawCenter(ctx, layout.center, centerScene(game), layout.scale, theme);
}

/* ---------- Dealer chip sprite ---------- */

// Size of the sprite's square as a multiple of the chip's radius. The rest of it is shadow.
export const CHIP_SPRITE_SCALE = 2.5;

// Draws the chip filling a canvas of `size` pixels. It's white in every theme: nothing else on
// the table is, so it can't be missed, and the theme only touches the stripes on its edge.
export function drawDealerChip(ctx, size, theme) {
  const center = size / 2;
  const radius = size / CHIP_SPRITE_SCALE;
  ctx.clearRect(0, 0, size, size);

  ctx.beginPath();
  ctx.arc(center, center, radius * 1.16, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = WHITE;
  ctx.fill();

  ctx.lineWidth = radius * 0.16;
  ctx.strokeStyle = theme.accent === theme.line ? INK : theme.accent;
  for (let i = 0; i < 8; i += 1) {
    const middle = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.9, middle - 0.2, middle + 0.2);
    ctx.stroke();
  }

  ctx.font = `900 ${radius * 1.3}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText('D', center, center + radius * 0.05);
}
