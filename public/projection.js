// Pure map math shared by the client and the tests (Build 41 isometric projection).
// "dzi" = pixel in the full-resolution Deep Zoom image.

export function gameToDzi(gx, gy, m) {
  return { x: m.isoX0 + (gx - gy) * m.isoHalfSqr, y: m.isoY0 + (gx + gy) * m.isoQuarterSqr };
}

export function dziToGame(dx, dy, m) {
  const ax = dx - m.isoX0;
  const ay = dy - m.isoY0;
  return { x: ax / (2 * m.isoHalfSqr) + ay / (2 * m.isoQuarterSqr), y: -ax / (2 * m.isoHalfSqr) + ay / (2 * m.isoQuarterSqr) };
}

// Zooming out further than this shows incomplete, blocky tiles on the coarse levels of the tile host.
export const MIN_ZOOM = 12.1;

// URL "zoom" is the Deep Zoom level whose resolution matches the view:
// canvas px per dzi px = 2^(zoom - maxLevel).
export const scaleForZoom = (zoom, m) => 2 ** (zoom - m.maxLevel);
export const zoomForScale = (scale, m) => Math.log2(scale) + m.maxLevel;

// Coarsest tile level that is at least as sharp as the current scale.
export function levelForScale(scale, m) {
  return Math.min(m.renderedMaxLevel, Math.max(0, Math.ceil(zoomForScale(scale, m))));
}

// Size of one tile of `level` in full-resolution dzi pixels.
export const tileSpan = (level, m) => m.tileSize * 2 ** (m.maxLevel - level);

// Tiles on the right and bottom edge of a level are smaller than tileSize (standard Deep Zoom),
// so a bitmap covers bitmapSize/tileSize of its grid cell. `size` is the cell's size on screen.
export function exactTileRect(bw, bh, size, m) {
  const k = size / m.tileSize;
  return { w: bw * k, h: bh * k };
}

// Source rectangle of the cell (c, r) inside its `up`-levels-coarser ancestor, in the ancestor's
// bitmap pixels. Uses the nominal tileSize, not the bitmap size: an edge ancestor is smaller than
// tileSize and scaling by its real size would shift and stretch the stand-in. fw/fh are the
// fractions of the cell the ancestor actually covers; null if it covers none of it.
export function parentCrop(c, r, up, pw, ph, m) {
  const n = 2 ** up;
  const cell = m.tileSize / n;
  const sx = (c % n) * cell;
  const sy = (r % n) * cell;
  const sw = Math.min(cell, pw - sx);
  const sh = Math.min(cell, ph - sy);
  if (sw <= 0 || sh <= 0) return null;
  return { sx, sy, sw, sh, fw: sw / cell, fh: sh / cell };
}

export function parseView(search, m) {
  const q = new URLSearchParams(search);
  const x = parseFloat(q.get("x"));
  const y = parseFloat(q.get("y"));
  const zoom = parseFloat(q.get("zoom"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, zoom: Number.isFinite(zoom) ? Math.min(m.maxLevel, Math.max(MIN_ZOOM, zoom)) : 14 };
}
