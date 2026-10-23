import { gameToDzi, dziToGame, scaleForZoom, zoomForScale, levelForScale, tileSpan, exactTileRect, parentCrop, stepCamera, PAN_MS, assignColors, colorForName, safehouseCorners, parseView, MIN_ZOOM, clampFloor, floorLabel, parseFloor, FLOOR_MIN, FLOOR_MAX } from "./projection.js";
import { TOWNS } from "./towns.js";

const $ = (id) => document.getElementById(id);
const canvas = $("map");
const ctx = canvas.getContext("2d");
let minScale = 0.001; // set from MIN_ZOOM once the map geometry is known
const MAX_SCALE = 1;
const MAX_FALLBACK = 4;
const MAX_LOADS = 8;

let meta = null;
let players = [];
let colors = new Map();
let safehouses = [];
let showSafehouses = true;
try { showSafehouses = localStorage.getItem("zmap-safehouses") !== "0"; } catch {}
let showTowns = true;
try { showTowns = localStorage.getItem("zmap-towns") !== "0"; } catch {}
const ownerColor = (h) => colors.get(h.owner) || colorForName(h.owner || h.title || "?");
const cam = { x: 0, y: 0, scale: 0.001 }; // dzi px at screen centre, canvas px per dzi px
// Where the camera is heading; `cam` eases toward it (see stepCamera). ax/ay: screen point a zoom is anchored on.
const goal = { x: 0, y: 0, scale: 0.001, ax: null, ay: null };
const syncGoal = () => Object.assign(goal, { x: cam.x, y: cam.y, scale: cam.scale, ax: null, ay: null });
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let dirty = true;
const redraw = () => (dirty = true);

// ---- tiles ----------------------------------------------------------------
// States: ImageBitmap (ready), "empty" (host has nothing rendered there: 404, draw
// nothing), {loading:true}, {retryAt} (network or server error, retried later).
const tiles = new Map();
const queue = [];
let loading = 0;

// The key doubles as the URL path, so it names the floor (ground floor keeps the short form).
let floor = 0; // -1 basement, 0 ground, 1-7 upper floors
const tileKey = (l, c, r) => (floor ? `f${floor}/${l}/${c}_${r}` : `${l}/${c}_${r}`);
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
  if (t === "empty") return;
  if (isReady(t)) {
    touch(tileKey(l, c, r));
    const d = exactTileRect(t.width, t.height, size, meta.map);
    ctx.drawImage(t, x, y, d.w + 1, d.h + 1);
    return;
  }
  for (let up = 1, pc = c, pr = r; up <= MAX_FALLBACK && l - up >= 0; up++) {
    pc >>= 1; pr >>= 1;
    const pl = l - up;
    const parent = tiles.get(tileKey(pl, pc, pr));
    if (parent === "empty") return;
    if (isReady(parent)) {
      touch(tileKey(pl, pc, pr));
      const k = parentCrop(c, r, up, parent.width, parent.height, meta.map);
      if (k) ctx.drawImage(parent, k.sx, k.sy, k.sw, k.sh, x, y, size * k.fw + 1, size * k.fh + 1);
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
  if (showSafehouses) drawSafehouses();
  if (showTowns) drawTowns();
  drawPlayers();
}

function drawSafehouses() {
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const h of safehouses) {
    const pts = safehouseCorners(h, meta.map).map((d) => toScreen(d.x, d.y));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    if (maxX < 0 || maxY < 0 || minX > innerWidth || minY > innerHeight) continue;
    const color = ownerColor(h);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Label only when the outline is big enough to hold it.
    if (maxX - minX > 70 && (h.owner || h.title)) {
      const label = h.owner || h.title;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#12151a";
      ctx.strokeText(label, cx, cy);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, cx, cy);
    }
  }
  ctx.textAlign = "start";
}

// Town names show when zoomed out and fade away as you zoom in to street level.
const TOWNS_FULL_ZOOM = 15.8, TOWNS_GONE_ZOOM = 16.8;
function drawTowns() {
  const alpha = Math.min(1, Math.max(0, (TOWNS_GONE_ZOOM - zoomForScale(cam.scale, meta.map)) / (TOWNS_GONE_ZOOM - TOWNS_FULL_ZOOM)));
  if (alpha === 0) return;
  ctx.font = "600 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#12151a";
  ctx.fillStyle = "#e6e9ee";
  ctx.globalAlpha = alpha;
  for (const t of TOWNS) {
    const d = gameToDzi(t.x, t.y, meta.map);
    const s = toScreen(d.x, d.y);
    if (s.x < -100 || s.y < -20 || s.x > innerWidth + 100 || s.y > innerHeight + 20) continue;
    ctx.strokeText(t.name, s.x, s.y);
    ctx.fillText(t.name, s.x, s.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
}

function drawPlayers() {
  ctx.font = "14px system-ui, sans-serif"; // same as the player list
  ctx.textBaseline = "middle";
  for (const p of players) {
    const d = gameToDzi(p.dx, p.dy, meta.map);
    const s = toScreen(d.x, d.y);
    if (s.x < -100 || s.y < -20 || s.x > innerWidth + 100 || s.y > innerHeight + 20) continue;
    // Players on another floor stay visible but faded.
    ctx.globalAlpha = clampFloor(p.z) === floor ? 1 : 0.4;
    // Same look as the list swatch (.swatch): colour disc, dark border, faint light outer ring.
    const R = 7;
    ctx.beginPath();
    ctx.arc(s.x, s.y, R + 1.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
    ctx.fillStyle = "#12151a";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, R - 2, 0, Math.PI * 2);
    ctx.fillStyle = colors.get(p.name) || "#f2b134";
    ctx.fill();
    if (p.hp !== null && p.hp !== undefined) {
      // Small health bar under the dot: green to red.
      const w = 22, x = s.x - w / 2, y = s.y + 12;
      ctx.fillStyle = "#12151a";
      ctx.fillRect(x - 1, y - 1, w + 2, 6);
      ctx.fillStyle = `hsl(${Math.round(p.hp * 1.2)}, 75%, 50%)`;
      ctx.fillRect(x, y, (w * p.hp) / 100, 4);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#12151a";
    const label = p.car ? `${p.name} 🚗` : p.name;
    ctx.strokeText(label, s.x + 14, s.y);
    ctx.fillStyle = "#e6e9ee"; // --text
    ctx.fillText(label, s.x + 14, s.y);
  }
  ctx.globalAlpha = 1;
}

// Ease each player's displayed position toward its latest reported one.
const GLIDE_MS = 300; // time constant of the glide
const SNAP_TILES = 500; // farther than this is a teleport/respawn: jump instead of gliding
let lastFrame = 0;
function glidePlayers(dt) {
  const k = 1 - Math.exp(-dt / GLIDE_MS);
  for (const p of players) {
    const ex = p.x - p.dx, ey = p.y - p.dy;
    if (ex === 0 && ey === 0) continue;
    if (Math.hypot(ex, ey) < 0.05 || Math.hypot(ex, ey) > SNAP_TILES) {
      p.dx = p.x; p.dy = p.y;
    } else {
      p.dx += ex * k; p.dy += ey * k;
    }
    dirty = true;
  }
}

function loop(now) {
  const dt = lastFrame ? Math.min(now - lastFrame, 100) : 0;
  lastFrame = now;
  glidePlayers(dt);
  if (meta && (cam.x !== goal.x || cam.y !== goal.y || cam.scale !== goal.scale)) {
    stepCamera(cam, goal, reduceMotion ? Infinity : dt, innerWidth, innerHeight);
    dirty = true;
    syncUrl();
  }
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

// ---- interaction ----------------------------------------------------------
// Wheel and button zooms set a goal the camera eases to; pinch (`instant`) follows the fingers exactly.
function zoomAt(sx, sy, factor, instant = false) {
  if (instant || reduceMotion) {
    const before = toDzi(sx, sy);
    cam.scale = Math.min(MAX_SCALE, Math.max(minScale, cam.scale * factor));
    const after = toDzi(sx, sy);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    syncGoal();
  } else {
    goal.scale = Math.min(MAX_SCALE, Math.max(minScale, goal.scale * factor));
    goal.ax = sx; goal.ay = sy;
  }
  redraw();
  syncUrl();
}

const FLING_MAX = 3; // px/ms cap on release speed
const pointers = new Map();
let pinchDist = 0;
let samples = []; // recent single-finger drag points, for the fling on release
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add("drag");
  pinchDist = 0;
  samples = [];
  goal.x = cam.x; goal.y = cam.y; // grabbing the map stops any glide
});
canvas.addEventListener("pointermove", (e) => {
  showCoords(e.clientX, e.clientY);
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };
  if (pointers.size === 1) {
    cam.x -= (cur.x - prev.x) / cam.scale;
    cam.y -= (cur.y - prev.y) / cam.scale;
    goal.x = cam.x; goal.y = cam.y;
    const t = performance.now();
    samples.push({ t, x: cur.x, y: cur.y });
    samples = samples.filter((p) => t - p.t <= 100);
  }
  pointers.set(e.pointerId, cur);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist, true);
    pinchDist = dist;
  }
  redraw();
});
const endPointer = (e) => {
  const wasSingle = pointers.size === 1 && pointers.has(e.pointerId);
  pointers.delete(e.pointerId);
  pinchDist = 0;
  if (pointers.size) return;
  canvas.classList.remove("drag");
  // Let go while still moving: coast on in the drag direction.
  const t = performance.now();
  const first = samples[0], last = samples[samples.length - 1];
  if (wasSingle && e.type === "pointerup" && !reduceMotion && last && first !== last && t - last.t < 80) {
    const dtMs = Math.max(last.t - first.t, 1);
    const cap = (v) => Math.max(-FLING_MAX, Math.min(FLING_MAX, v));
    goal.x = cam.x - (cap((last.x - first.x) / dtMs) / cam.scale) * PAN_MS;
    goal.y = cam.y - (cap((last.y - first.y) / dtMs) / cam.scale) * PAN_MS;
  }
  samples = [];
  syncUrl();
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // Firefox reports lines
  zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
}, { passive: false });

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
    if (floor) q.set("floor", floor);
    try { history.replaceState(null, "", `?${q}`); } catch {}
  }, 300);
}

function updateFloorUi() {
  $("floorLabel").textContent = floorLabel(floor);
  $("floorLabel").classList.toggle("away", floor !== 0);
  $("floorUp").disabled = floor >= FLOOR_MAX;
  $("floorDown").disabled = floor <= FLOOR_MIN;
}

function setFloor(next) {
  next = clampFloor(next);
  if (next === floor) return;
  // Tiles still waiting in the queue belong to the floor being left: forget them.
  for (const key of queue.splice(0)) tiles.delete(key);
  floor = next;
  updateFloorUi();
  redraw();
  syncUrl();
}
$("floorUp").addEventListener("click", () => setFloor(floor + 1));
$("floorDown").addEventListener("click", () => setFloor(floor - 1));
$("floorLabel").addEventListener("click", () => setFloor(0));

function centerOnGame(gx, gy) {
  const d = gameToDzi(gx, gy, meta.map);
  goal.x = d.x; goal.y = d.y; // glides there
  goal.ax = null; goal.ay = null;
  redraw();
  syncUrl();
}

// ---- players --------------------------------------------------------------
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatGameTime = (t) => `${MONTHS[t.mo - 1]} ${t.d}, ${t.y} · ${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}`;

function renderPlayers(data) {
  const prev = new Map(players.map((p) => [p.name, p]));
  players = data.players;
  for (const p of players) {
    const old = prev.get(p.name);
    p.dx = old ? old.dx : p.x;
    p.dy = old ? old.dy : p.y;
  }
  colors = assignColors(players.map((p) => p.name));
  const list = $("players");
  list.replaceChildren(...players.map((p) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = colors.get(p.name);
    name.append(swatch, p.car ? `${p.name} 🚗` : p.name);
    const sub = document.createElement("small");
    const z = clampFloor(p.z);
    sub.textContent = `${p.hp == null ? "" : `${p.hp}% HP · `}${z ? `${z > 0 ? "F" : "B"}${Math.abs(z)} · ` : ""}${p.x}, ${p.y} · ${ago(data.updatedAt)}`;
    li.append(name, sub);
    li.addEventListener("click", () => { centerOnGame(p.x, p.y); setFloor(clampFloor(p.z)); });
    return li;
  }));
  renderSafehouses(data.safehouses || []);
  $("clock").textContent = data.gameTime ? formatGameTime(data.gameTime) : "";
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

function renderSafehouses(list) {
  safehouses = list;
  $("safehouses").replaceChildren(...list.map((h) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = ownerColor(h);
    name.append(swatch, h.owner || h.title || "Safehouse");
    const sub = document.createElement("small");
    const others = h.members.filter((m) => m !== h.owner);
    sub.textContent = others.length ? `+ ${others.join(", ")}` : `${h.w}x${h.h}`;
    li.title = `${h.title || "Safehouse"} · ${h.w}x${h.h} at ${h.x}, ${h.y}`;
    li.append(name, sub);
    li.addEventListener("click", () => centerOnGame(h.x + h.w / 2, h.y + h.h / 2));
    return li;
  }));
  $("shHead").hidden = list.length === 0;
}

$("shShow").checked = showSafehouses;
$("shShow").addEventListener("change", (e) => {
  showSafehouses = e.target.checked;
  try { localStorage.setItem("zmap-safehouses", showSafehouses ? "1" : "0"); } catch {}
  redraw();
});

$("townsShow").checked = showTowns;
$("townsShow").addEventListener("change", (e) => {
  showTowns = e.target.checked;
  try { localStorage.setItem("zmap-towns", showTowns ? "1" : "0"); } catch {}
  redraw();
});

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
  $("bannerText").textContent = text;
  $("banner").hidden = !text;
}
$("bannerClose").addEventListener("click", () => { $("banner").hidden = true; });

// ---- boot -----------------------------------------------------------------
async function init() {
  meta = await (await fetch("api/meta")).json();
  minScale = scaleForZoom(MIN_ZOOM, meta.map);
  tileVersion = `${meta.map.dir}-${meta.map.tileSize}`;
  document.title = `${meta.serverName} Map`;
  $("version").textContent = ["v" + meta.app?.version, meta.app?.commit].filter((x) => x && x !== "vundefined" && x !== "vnull").join(" · ");
  $("title").textContent = meta.serverName;
  if (meta.build.supported === false) banner(`Game version ${meta.build.version} is a different build than the map (Build ${meta.map.dir.split(".")[0]}). The map may not match this world.`);
  floor = parseFloor(location.search);
  updateFloorUi();
  const view = parseView(location.search, meta.map);
  if (view) {
    const d = gameToDzi(view.x, view.y, meta.map);
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(view.zoom, meta.map);
  } else {
    const d = gameToDzi(10800, 10000, meta.map); // Muldraugh area
    cam.x = d.x; cam.y = d.y; cam.scale = scaleForZoom(14, meta.map);
  }
  cam.scale = Math.min(MAX_SCALE, Math.max(minScale, cam.scale));
  syncGoal();
  redraw();
  poll();
}

$("toggle").addEventListener("click", () => {
  const expanded = !$("panel").classList.toggle("hidden");
  $("toggle").setAttribute("aria-expanded", String(expanded));
});
// The top bar wraps on narrow screens, so things pinned under it follow its real height.
if (window.ResizeObserver) {
  new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${$("bar").offsetHeight}px`)).observe($("bar"));
}
addEventListener("resize", resize);
resize();
loop();
init().catch(() => banner("Could not load map configuration."));
