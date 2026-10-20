import { gameToDzi, dziToGame, scaleForZoom, zoomForScale, levelForScale, tileSpan, parseView } from "./projection.js";

const $ = (id) => document.getElementById(id);
const canvas = $("map");
const ctx = canvas.getContext("2d");
const MIN_SCALE = 0.0003;
const MAX_SCALE = 1;
const MAX_FALLBACK = 4;
const MAX_LOADS = 8;

let meta = null;
let players = [];
const cam = { x: 0, y: 0, scale: 0.001 }; // dzi px at screen centre, canvas px per dzi px
let dirty = true;
const redraw = () => (dirty = true);

// ---- tiles ----------------------------------------------------------------
const tiles = new Map(); // key -> HTMLImageElement | "empty" | {retryAt}
const queue = [];
let loading = 0;

function tileKey(l, c, r) { return `${l}/${c}_${r}`; }

function requestTile(l, c, r) {
  const key = tileKey(l, c, r);
  const hit = tiles.get(key);
  if (hit && !(hit.retryAt && hit.retryAt < Date.now())) return;
  if (queue.includes(key)) return;
  tiles.set(key, { loading: true });
  queue.push(key);
  pump();
}

function pump() {
  while (loading < MAX_LOADS && queue.length) {
    const key = queue.pop(); // newest first: what is on screen now wins
    loading++;
    const img = new Image();
    img.onload = () => { tiles.set(key, img); loading--; redraw(); pump(); };
    img.onerror = () => { tiles.set(key, { retryAt: Date.now() + 10000 }); loading--; pump(); };
    img.src = `tiles/${key}.jpg`;
  }
}

function drawTile(l, c, r, x, y, size) {
  const img = tiles.get(tileKey(l, c, r));
  if (img instanceof HTMLImageElement) { ctx.drawImage(img, x, y, size + 1, size + 1); return; }
  // Coarser ancestor as a stand-in while the exact tile loads.
  for (let up = 1, pc = c, pr = r; up <= MAX_FALLBACK && l - up >= 0; up++) {
    pc >>= 1; pr >>= 1;
    const pl = l - up;
    const parent = tiles.get(tileKey(pl, pc, pr));
    if (parent instanceof HTMLImageElement) {
      const n = 2 ** up;
      const sw = parent.naturalWidth / n, sh = parent.naturalHeight / n;
      ctx.drawImage(parent, (c - pc * n) * sw, (r - pr * n) * sh, sw, sh, x, y, size + 1, size + 1);
      return;
    }
    requestTile(pl, pc, pr);
  }
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
      drawTile(level, c, r, s.x, s.y, span * cam.scale);
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
  cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
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
  $("empty").textContent = data.stale ? "No data from the server. It may be offline." : "Nobody is online.";
  $("status").textContent = data.stale
    ? "Server offline or no data"
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

function banner(text) {
  $("banner").textContent = text;
  $("banner").hidden = !text;
}

// ---- boot -----------------------------------------------------------------
async function init() {
  meta = await (await fetch("api/meta")).json();
  document.title = `${meta.serverName} Map`;
  $("title").textContent = meta.serverName;
  if (meta.build.supported === false) banner(`Game version ${meta.build.version} is not Build 41. The map shown may not match this world.`);
  const view = parseView(location.search, meta.map);
  if (view) {
    const d = gameToDzi(view.x, view.y, meta.map);
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(view.zoom, meta.map);
  } else {
    const d = gameToDzi(10800, 10000, meta.map); // Muldraugh area
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(14, meta.map);
  }
  cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale));
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
