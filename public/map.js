import { gameToDzi, dziToGame, scaleForZoom, zoomForScale, levelForScale, tileSpan, exactTileRect, parentCrop, parseView, MIN_ZOOM } from "./projection.js";

const $ = (id) => document.getElementById(id);
const canvas = $("map");
const ctx = canvas.getContext("2d");
let minScale = 0.001; // set from MIN_ZOOM once the map geometry is known
const MAX_SCALE = 1;
const MAX_FALLBACK = 4;
const MAX_LOADS = 8;

let meta = null;
let players = [];
const cam = { x: 0, y: 0, scale: 0.001 }; // dzi px at screen centre, canvas px per dzi px
let dirty = true;
const redraw = () => (dirty = true);

// ---- tiles ----------------------------------------------------------------
// States: ImageBitmap (ready), "empty" (host has nothing rendered there: 404, draw
// nothing), {loading:true}, {retryAt} (network or server error, retried later).
const tiles = new Map();
const queue = [];
let loading = 0;

const tileKey = (l, c, r) => `${l}/${c}_${r}`;
// Tile URLs carry the map build so the browser (and any CDN) never reuses a tile cached for another one.
let tileVersion = "0";

// Decoded 2048px tiles are ~16 MB each, so keep only the most recently drawn ones.
const MAX_READY = 80;
const lru = new Map();
function touch(key) {
  lru.delete(key);
  lru.set(key, true);
  while (lru.size > MAX_READY) {
    const oldest = lru.keys().next().value;
    lru.delete(oldest);
    tiles.get(oldest)?.close?.();
    tiles.delete(oldest);
  }
}
const isReady = (t) => typeof ImageBitmap !== "undefined" && t instanceof ImageBitmap;

function requestTile(l, c, r) {
  const key = tileKey(l, c, r);
  const hit = tiles.get(key);
  if (hit) {
    if (hit === "empty" || isReady(hit) || hit.loading) return;
    if (hit.retryAt && hit.retryAt > Date.now()) return;
  }
  tiles.set(key, { loading: true });
  queue.push(key);
  pump();
}

async function loadTile(key) {
  try {
    const res = await fetch(`tiles/${key}.jpg?v=${tileVersion}`);
    if (res.status === 404) return tiles.set(key, "empty");
    if (!res.ok) throw new Error(String(res.status));
    tiles.set(key, await createImageBitmap(await res.blob()));
    touch(key);
  } catch {
    tiles.set(key, { retryAt: Date.now() + 10000 });
    setTimeout(redraw, 10500);
  }
}

function pump() {
  while (loading < MAX_LOADS && queue.length) {
    const key = queue.pop(); // newest first: what is on screen now wins
    loading++;
    loadTile(key).finally(() => { loading--; redraw(); pump(); });
  }
}

// Draws the exact tile, or a stand-in from a coarser level while it loads or after an
// error. Nothing is drawn for an "empty" tile: the host has no map there.
function drawTile(l, c, r, x, y, size) {
  const t = tiles.get(tileKey(l, c, r));
  if (t === "empty") return "empty";
  if (isReady(t)) {
    touch(tileKey(l, c, r));
    const d = exactTileRect(t.width, t.height, size, meta.map);
    ctx.drawImage(t, x, y, d.w + 1, d.h + 1);
    return `exact ${t.width}x${t.height}`;
  }
  for (let up = 1, pc = c, pr = r; up <= MAX_FALLBACK && l - up >= 0; up++) {
    pc >>= 1; pr >>= 1;
    const pl = l - up;
    const parent = tiles.get(tileKey(pl, pc, pr));
    if (parent === "empty") return "empty parent";
    if (isReady(parent)) {
      touch(tileKey(pl, pc, pr));
      const k = parentCrop(c, r, up, parent.width, parent.height, meta.map);
      if (k) ctx.drawImage(parent, k.sx, k.sy, k.sw, k.sh, x, y, size * k.fw + 1, size * k.fh + 1);
      return `stand-in from level ${pl} ${parent.width}x${parent.height}`;
    }
    requestTile(pl, pc, pr);
  }
  return typeof t === "object" && t?.retryAt ? "FAILED, retrying" : "loading";
}

// Add &debug=1 to the URL: outlines every tile with what was drawn for it.
const DEBUG = new URLSearchParams(location.search).has("debug");
function debugTile(l, c, r, x, y, size, what) {
  ctx.strokeStyle = what.startsWith("exact") ? "#3ddc84" : "#ff4d4d";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  ctx.font = "12px monospace";
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 4, y + 4, 330, 34);
  ctx.fillStyle = "#fff";
  ctx.fillText(`L${l} ${c}_${r}  ${what}`, x + 8, y + 18);
  ctx.fillText(`cell ${Math.round(size)}px, dpr ${window.devicePixelRatio}`, x + 8, y + 32);
}

// ---- rendering ------------------------------------------------------------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

const toScreen = (dx, dy) => ({ x: (dx - cam.x) * cam.scale + innerWidth / 2, y: (dy - cam.y) * cam.scale + innerHeight / 2 });
const toDzi = (sx, sy) => ({ x: (sx - innerWidth / 2) / cam.scale + cam.x, y: (sy - innerHeight / 2) / cam.scale + cam.y });

function draw() {
  ctx.fillStyle = "#12151a";
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  if (!meta) return;
  const m = meta.map;
  const level = levelForScale(cam.scale, m);
  const span = tileSpan(level, m);
  const cols = Math.ceil(m.fullWidth / span), rows = Math.ceil(m.fullHeight / span);
  const tl = toDzi(0, 0), br = toDzi(innerWidth, innerHeight);
  const c0 = Math.max(0, Math.floor(tl.x / span)), c1 = Math.min(cols - 1, Math.floor(br.x / span));
  const r0 = Math.max(0, Math.floor(tl.y / span)), r1 = Math.min(rows - 1, Math.floor(br.y / span));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const s = toScreen(c * span, r * span);
      requestTile(level, c, r);
      const what = drawTile(level, c, r, s.x, s.y, span * cam.scale);
      if (DEBUG) debugTile(level, c, r, s.x, s.y, span * cam.scale, what || "none");
    }
  }
  drawPlayers();
}

function drawPlayers() {
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const p of players) {
    const d = gameToDzi(p.x, p.y, meta.map);
    const s = toScreen(d.x, d.y);
    if (s.x < -100 || s.y < -20 || s.x > innerWidth + 100 || s.y > innerHeight + 20) continue;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#f2b134";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#12151a";
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, s.x + 12, s.y);
    ctx.fillStyle = "#fff";
    ctx.fillText(p.name, s.x + 12, s.y);
  }
}

function loop() {
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

// ---- interaction ----------------------------------------------------------
function zoomAt(sx, sy, factor) {
  const before = toDzi(sx, sy);
  cam.scale = Math.min(MAX_SCALE, Math.max(minScale, cam.scale * factor));
  const after = toDzi(sx, sy);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  redraw();
  syncUrl();
}

const pointers = new Map();
let pinchDist = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add("drag");
  pinchDist = 0;
});
canvas.addEventListener("pointermove", (e) => {
  showCoords(e.clientX, e.clientY);
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };
  if (pointers.size === 1) {
    cam.x -= (cur.x - prev.x) / cam.scale;
    cam.y -= (cur.y - prev.y) / cam.scale;
  }
  pointers.set(e.pointerId, cur);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
    pinchDist = dist;
  }
  redraw();
});
const endPointer = (e) => { pointers.delete(e.pointerId); pinchDist = 0; if (!pointers.size) { canvas.classList.remove("drag"); syncUrl(); } };
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

function showCoords(sx, sy) {
  if (!meta) return;
  const d = toDzi(sx, sy);
  const g = dziToGame(d.x, d.y, meta.map);
  $("coords").textContent = `x ${Math.round(g.x)}, y ${Math.round(g.y)}`;
}

let urlTimer = 0;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    if (!meta) return;
    const g = dziToGame(cam.x, cam.y, meta.map);
    const q = new URLSearchParams({ x: Math.round(g.x), y: Math.round(g.y), zoom: zoomForScale(cam.scale, meta.map).toFixed(1) });
    try { history.replaceState(null, "", `?${q}`); } catch {}
  }, 300);
}

function centerOnGame(gx, gy) {
  const d = gameToDzi(gx, gy, meta.map);
  cam.x = d.x; cam.y = d.y;
  redraw();
  syncUrl();
}

// ---- players --------------------------------------------------------------
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function renderPlayers(data) {
  players = data.players;
  const list = $("players");
  list.replaceChildren(...players.map((p) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = p.name;
    const sub = document.createElement("small");
    sub.textContent = `${p.x}, ${p.y} · ${ago(data.updatedAt)}`;
    li.append(name, sub);
    li.addEventListener("click", () => centerOnGame(p.x, p.y));
    return li;
  }));
  $("empty").hidden = players.length > 0;
  const note = data.reason === "no-file"
    ? "Positions file not found. Is the ZMapPositions mod loaded?"
    : data.reason === "stale"
      ? `No update for ${data.ageSeconds}s. The server may be stopped.`
      : "Nobody is online.";
  $("empty").textContent = note;
  $("status").textContent = data.stale
    ? note
    : `${players.length} online · updated ${ago(data.updatedAt)}`;
  redraw();
}

async function poll() {
  if (!document.hidden) {
    try {
      const res = await fetch("api/players", { cache: "no-store" });
      if (res.ok) renderPlayers(await res.json());
    } catch {
      $("status").textContent = "Connection lost, retrying…";
    }
  }
  setTimeout(poll, meta.refreshSeconds * 1000);
}

function banner(text, level = "warn") {
  $("bannerText").textContent = text;
  $("banner").className = level;
  $("banner").hidden = !text;
}
// A dismissed info banner stays dismissed for this browser; it only returns if the map directory changes.
const dismissKey = () => `zmap-banner-${meta?.map?.dir}`;
function bannerDismissed() {
  try { return localStorage.getItem(dismissKey()) === "1"; } catch { return false; }
}
$("bannerClose").addEventListener("click", () => {
  $("banner").hidden = true;
  try { localStorage.setItem(dismissKey(), "1"); } catch {}
});

// ---- boot -----------------------------------------------------------------
async function init() {
  meta = await (await fetch("api/meta")).json();
  minScale = scaleForZoom(MIN_ZOOM, meta.map);
  tileVersion = encodeURIComponent(`${meta.map.dir}-${meta.map.tileSize}-${meta.build.buildId ?? ""}`);
  document.title = `${meta.serverName} Map`;
  $("title").textContent = meta.serverName;
  if (meta.build.supported === false) banner(`Game version ${meta.build.version} is not Build 42. The map shown may not match this world.`);
  else if (meta.mapSource === "fallback" && !bannerDismissed()) banner(`Showing the ${meta.map.dir} map. The tile host did not answer for the running version (${meta.mapNote}), so the built-in ${meta.map.dir} layout is used. This is fine unless the game map changed in a newer build.`, "info");
  const view = parseView(location.search, meta.map);
  if (view) {
    const d = gameToDzi(view.x, view.y, meta.map);
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(view.zoom, meta.map);
  } else {
    const d = gameToDzi(10800, 10000, meta.map); // Muldraugh area
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(14, meta.map);
  }
  cam.scale = Math.min(MAX_SCALE, Math.max(minScale, cam.scale));
  redraw();
  poll();
}

$("toggle").addEventListener("click", () => {
  const expanded = !$("panel").classList.toggle("hidden");
  $("toggle").setAttribute("aria-expanded", String(expanded));
});
addEventListener("resize", resize);
resize();
loop();
init().catch(() => banner("Could not load map configuration."));
