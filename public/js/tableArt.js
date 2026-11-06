// Draws one flat, undistorted table into a canvas whose units are inches. The warp is
// applied afterwards. The game scene in gameArt.js draws into this same space.

import { perimeterAt, pointOnPill } from './geometry.js';

const CARD = { width: 2.75, height: 3.75, gap: 0.5 };
const SEAT_SLOTS = 10; // Nine players plus the dealer at bottom center.

export function pill(ctx, { lengthIn, widthIn }, inset) {
  const halfL = lengthIn / 2 - inset;
  const halfH = widthIn / 2 - inset;
  ctx.beginPath();
  ctx.roundRect(-halfL, -halfH, halfL * 2, halfH * 2, halfH);
}

function text(ctx, value, x, y, sizeIn, color, weight = 500) {
  // Canvas font sizes misbehave at about 1px, so type is drawn at 100px and scaled down.
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sizeIn / 100, sizeIn / 100);
  ctx.font = `${weight} 100px ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(value, 0, 0);
  ctx.restore();
}

export function drawFelt(ctx, table, theme) {
  const { lengthIn, railIn } = table;

  if (railIn > 0) {
    const rail = ctx.createLinearGradient(0, -table.widthIn / 2, 0, table.widthIn / 2);
    rail.addColorStop(0, theme.rail);
    rail.addColorStop(1, theme.railEdge);
    pill(ctx, table, 0);
    ctx.fillStyle = rail;
    ctx.fill();
  }

  const felt = ctx.createRadialGradient(0, 0, 0, 0, 0, lengthIn / 2);
  felt.addColorStop(0, theme.felt);
  felt.addColorStop(1, theme.feltEdge);
  pill(ctx, table, railIn);
  ctx.fillStyle = felt;
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 0.15;
  ctx.stroke();
}

function drawMarkings(ctx, table, theme) {
  const { railIn, widthIn } = table;
  const feltHalf = widthIn / 2 - railIn;
  const lineInset = railIn + feltHalf * 0.32;

  pill(ctx, table, lineInset);
  ctx.strokeStyle = theme.line;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 0.2;
  ctx.stroke();
  ctx.globalAlpha = 1;

  const seatInset = railIn + (lineInset - railIn) / 2;
  const seatRadius = Math.min(1.8, (lineInset - railIn) / 2 - 0.4);
  const step = perimeterAt(table, seatInset) / SEAT_SLOTS;

  for (let slot = 0; slot < SEAT_SLOTS; slot += 1) {
    const [x, y] = pointOnPill(table, seatInset, step * slot);
    if (slot === 0) {
      ctx.beginPath();
      ctx.roundRect(x - seatRadius * 1.5, y - seatRadius * 0.75, seatRadius * 3, seatRadius * 1.5, 0.4);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 0.15;
      ctx.stroke();
      text(ctx, 'DEALER', x, y, seatRadius * 0.55, theme.accent, 600);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, seatRadius, 0, Math.PI * 2);
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.12;
      ctx.stroke();
      ctx.globalAlpha = 1;
      text(ctx, String(slot), x, y, seatRadius * 0.9, theme.line, 500);
    }
  }

  const rowWidth = CARD.width * 5 + CARD.gap * 4;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 0.1;
  for (let i = 0; i < 5; i += 1) {
    const x = -rowWidth / 2 + i * (CARD.width + CARD.gap);
    ctx.beginPath();
    ctx.roundRect(x, -CARD.height / 2, CARD.width, CARD.height, 0.25);
    ctx.stroke();
  }

  const suitY = -(CARD.height / 2 + (feltHalf * 0.68 - CARD.height / 2) / 2);
  ['♠', '♥', '♦', '♣'].forEach((suit, i) => {
    text(ctx, `${suit}︎`, (i - 1.5) * 2.4, suitY, 1.5, theme.accent);
  });
}

function drawOutline(ctx, table, theme) {
  pill(ctx, table, 0.4);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  if (table.railIn > 0) {
    pill(ctx, table, table.railIn);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 0.25;
    ctx.stroke();
  }

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  ctx.moveTo(-6, 0);
  ctx.lineTo(6, 0);
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 6);
  ctx.stroke();
}

function drawGrid(ctx, table, theme) {
  const { lengthIn, widthIn } = table;
  const halfL = lengthIn / 2;
  const halfH = widthIn / 2;

  ctx.save();
  pill(ctx, table, 0);
  ctx.clip();

  const lines = (step, color, lineWidth) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let x = 0; x <= halfL; x += step) {
      ctx.moveTo(x, -halfH);
      ctx.lineTo(x, halfH);
      ctx.moveTo(-x, -halfH);
      ctx.lineTo(-x, halfH);
    }
    for (let y = 0; y <= halfH; y += step) {
      ctx.moveTo(-halfL, y);
      ctx.lineTo(halfL, y);
      ctx.moveTo(-halfL, -y);
      ctx.lineTo(halfL, -y);
    }
    ctx.stroke();
  };

  lines(3, 'rgba(255, 255, 255, 0.28)', 0.1);
  lines(12, theme.accent, 0.22);
  ctx.restore();

  text(ctx, 'Squares should look square', 6, 6, 1.5, theme.accent, 600);

  pill(ctx, table, 0.3);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 0.6;
  ctx.stroke();
}

export function drawTable(ctx, table, theme, pattern) {
  if (pattern === 'outline') {
    drawOutline(ctx, table, theme);
  } else if (pattern === 'grid') {
    drawGrid(ctx, table, theme);
  } else {
    drawFelt(ctx, table, theme);
    drawMarkings(ctx, table, theme);
  }
}
