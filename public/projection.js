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

// Marker colours, picked to stand out on the olive map and from each other.
export const PLAYER_COLORS = ["#f2b134", "#ff4d4d", "#36d1ff", "#b388ff", "#ff7eb6", "#ffffff", "#4d7cff", "#ff7a1a", "#e6ff4d", "#2ee6c5"];

// The four corners of a safehouse rectangle (x, y, w, h in game tiles) as a diamond in dzi pixels.
export function safehouseCorners(h, m) {
  return [[h.x, h.y], [h.x + h.w, h.y], [h.x + h.w, h.y + h.h], [h.x, h.y + h.h]].map(([gx, gy]) => gameToDzi(gx, gy, m));
}

// A name's own colour, ignoring who else is online (used for owners who are offline).
export const colorForName = (name, palette = PLAYER_COLORS) => palette[hashName(name) % palette.length];

const hashName = (name) => {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return h;
};

// Name -> colour for the players online. Each name prefers a colour derived from the name, so a
// player keeps their colour between sessions; when two online players want the same one, the
// later name (alphabetically, so every viewer agrees) takes the next free colour.
export function assignColors(names, palette = PLAYER_COLORS) {
  const out = new Map();
  const used = new Set();
  for (const name of [...new Set(names)].sort()) {
    const want = hashName(name) % palette.length;
    let pick = want;
    for (let i = 0; i < palette.length && used.has(pick); i++) pick = (want + i + 1) % palette.length;
    if (used.has(pick)) {
      // More players than colours: fall back to evenly spaced hues.
      out.set(name, `hsl(${(out.size * 137.5) % 360} 85% 60%)`);
      continue;
    }
    used.add(pick);
    out.set(name, palette[pick]);
  }
  return out;
}

// ---- camera easing --------------------------------------------------------
// The camera (`cam`) eases toward a goal each frame, so wheel zoom, flings and "centre on player"
// glide instead of jumping. Time constants in ms: how long it takes to cover ~63% of the way (smaller = more friction, stops sooner).
// The last fraction of a pixel / percent of zoom snaps to the goal instead of creeping in.
export const PAN_MS = 110;
export const ZOOM_MS = 85;

// Advance `cam` toward `goal` by `dt` ms for a viewport of vw x vh px. Zooming eases in log space
// about the goal's screen anchor (ax, ay; null = screen centre) so the point under the cursor stays
// put; the pan part of the goal is shifted by the same correction. Returns true while still moving.
// dt = Infinity jumps straight to the goal (reduced motion).
export function stepCamera(cam, goal, dt, vw, vh) {
  const kz = 1 - Math.exp(-dt / ZOOM_MS);
  const kp = 1 - Math.exp(-dt / PAN_MS);
  if (goal.scale !== cam.scale) {
    const ratio = goal.scale / cam.scale;
    const next = Math.abs(Math.log(ratio)) < 0.002 ? goal.scale : cam.scale * ratio ** kz;
    const ax = (goal.ax ?? vw / 2) - vw / 2, ay = (goal.ay ?? vh / 2) - vh / 2;
    const dx = ax / cam.scale - ax / next, dy = ay / cam.scale - ay / next;
    cam.x += dx; cam.y += dy;
    goal.x += dx; goal.y += dy;
    cam.scale = next;
  }
  const ex = goal.x - cam.x, ey = goal.y - cam.y;
  if (Math.hypot(ex, ey) * cam.scale < 0.4) {
    cam.x = goal.x; cam.y = goal.y;
  } else {
    cam.x += ex * kp; cam.y += ey * kp;
  }
  return cam.x !== goal.x || cam.y !== goal.y || cam.scale !== goal.scale;
}

// ---- floors ---------------------------------------------------------------
// The tile host publishes one render per floor: -1 = basement, 0 = ground, 1-7 = upper floors.
export const FLOOR_MIN = -1;
export const FLOOR_MAX = 7;
export const clampFloor = (f) => Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, Math.round(Number(f)) || 0));
export const floorLabel = (f) => (f === 0 ? "G" : f > 0 ? String(f) : `B${-f}`);
export function parseFloor(search) {
  const raw = new URLSearchParams(search).get("floor");
  return raw === null || !Number.isFinite(Number(raw)) ? 0 : clampFloor(raw);
}
