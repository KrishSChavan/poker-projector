// What goes on the wall, shared by the wall window and the laptop preview. The table layer only
// repaints when what it shows changes. The dealer chip is a sprite with its own small texture and
// mesh, so gliding it around the table never touches the big texture.

import { CHIP_SPRITE_SCALE, drawDealerChip, drawGame } from './gameArt.js';
import { chipPath, createWarp, seatLayout, tableBounds } from './geometry.js';
import { createRenderer } from './renderer.js';
import { drawTable } from './tableArt.js';
import { themeById } from './themes.js';

const TEXTURE_WIDTH = 2560;
const CHIP_TEXTURE_SIZE = 256;
const GLIDE_MS = 1000;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const sameTable = (a, b) =>
  a.lengthIn === b.lengthIn && a.widthIn === b.widthIn && a.railIn === b.railIn;

export function createWall(canvas) {
  const art = document.createElement('canvas');
  const chipArt = document.createElement('canvas');
  chipArt.width = CHIP_TEXTURE_SIZE;
  chipArt.height = CHIP_TEXTURE_SIZE;

  let calibration = null;
  let view = 'projection';
  let game = null;
  let warp = null;
  let seating = null;
  let tableStale = true;
  let chipStale = true;
  let chip = { dealerId: null, position: null, glide: null };

  const renderer = createRenderer(canvas, { beforeDraw, onRestored });

  function paintTable() {
    const { table, themeId, pattern } = calibration;
    const theme = themeById(themeId);
    const { halfW, halfH } = tableBounds(table);
    const scale = TEXTURE_WIDTH / (halfW * 2);
    art.width = TEXTURE_WIDTH;
    art.height = Math.round(halfH * 2 * scale);

    const ctx = art.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, art.width / 2, art.height / 2);
    if (view === 'game') drawGame(ctx, table, theme, game);
    else drawTable(ctx, table, theme, pattern);
    renderer.setTexture(art);
    tableStale = false;
  }

  function paintChip() {
    drawDealerChip(chipArt.getContext('2d'), CHIP_TEXTURE_SIZE, themeById(calibration.themeId));
    renderer.setSpriteTexture(chipArt);
    chipStale = false;
  }

  // Worked out once per table and player count, because the glide needs it on every frame.
  function currentLayout() {
    const { table } = calibration;
    const count = game.players.length;
    const isCurrent = seating && seating.count === count && sameTable(seating.table, table);
    if (!isCurrent) seating = { table, count, layout: seatLayout(table, count) };
    return seating.layout;
  }

  function showChipAt(position) {
    chip.position = position;
    const size = currentLayout().chipRadius * CHIP_SPRITE_SCALE;
    renderer.setSpriteMesh(warp.spriteVertices(...position, size));
  }

  function stepGlide(now) {
    const { glide } = chip;
    glide.startedAt ??= now;
    const progress = Math.min(1, (now - glide.startedAt) / GLIDE_MS);
    if (progress < 1) {
      showChipAt(glide.path(easeInOut(progress)));
      renderer.requestDraw();
    } else {
      // The spot can have moved during the trip if a player joined or left.
      chip.glide = null;
      showChipAt(chipSpot());
    }
  }

  function beforeDraw(now) {
    if (!calibration) return;
    if (tableStale) paintTable();
    if (chipStale) paintChip();
    if (chip.glide) stepGlide(now);
  }

  function onRestored() {
    tableStale = true;
    chipStale = true;
    chip = { ...chip, glide: null };
    if (warp) renderer.setMesh(warp.vertices());
    syncChip();
  }

  // Where the chip belongs right now, or null when there's nothing to show it on.
  function chipSpot() {
    if (view !== 'game' || !game || !warp) return null;
    const seat = game.players.findIndex((player) => player.id === game.dealerId);
    if (seat < 0) return null;
    const { x, y } = currentLayout().seats[seat].chip;
    return [x, y];
  }

  // A new dealer is the only thing that glides. Anything else moves the plates too, in one jump,
  // so the chip goes with them. An undone hand runs the chip back the way it came.
  function syncChip(handWentBack = false) {
    const spot = chipSpot();
    if (!spot) {
      chip = { dealerId: null, position: null, glide: null };
      renderer.setSpriteMesh(null);
      return;
    }
    const isNewDealer = chip.position && chip.dealerId !== game.dealerId;
    if (isNewDealer) {
      const path = chipPath(currentLayout(), chip.position, spot, handWentBack ? -1 : 1);
      chip.glide = { path, startedAt: null };
    } else if (!chip.glide) {
      showChipAt(spot);
    }
    chip.dealerId = game.dealerId;
  }

  function setCalibration(next) {
    const showsNewArt =
      !calibration ||
      !sameTable(calibration.table, next.table) ||
      calibration.themeId !== next.themeId ||
      calibration.pattern !== next.pattern;
    if (!calibration || calibration.themeId !== next.themeId) chipStale = true;
    if (showsNewArt) tableStale = true;
    calibration = next;
    warp = createWarp(next.table, next.corners, next.offsets);
    renderer.setMesh(warp.vertices());
  }

  // Anything left out, or passed unchanged, costs nothing, so callers can send all of it.
  function update({ calibration: nextCalibration, view: nextView, game: nextGame }) {
    const handBefore = game?.handNumber ?? 0;
    if (nextCalibration && nextCalibration !== calibration) setCalibration(nextCalibration);
    if (nextView !== undefined && nextView !== view) {
      view = nextView;
      tableStale = true;
    }
    if (nextGame !== undefined && nextGame !== game) {
      game = nextGame;
      if (view === 'game') tableStale = true;
    }
    syncChip((game?.handNumber ?? 0) < handBefore);
    renderer.requestDraw();
  }

  const redraw = new ResizeObserver(() => renderer.requestDraw());
  // Device pixels also catch a move between screens that keeps the same size in CSS pixels.
  try {
    redraw.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    redraw.observe(canvas);
  }

  return { update, warp: () => warp };
}
