// Live Project Zomboid (Build 42) world map. Read-only, zero dependencies.
// Config comes from environment variables, see deploy/zmap.env.example.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FLOOR_MIN, FLOOR_MAX } from "./public/projection.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILES_ROOT = "https://tiles.pzmap.org";
const USER_AGENT = "zomboid-world-map/1.0 (+https://github.com/ruku1143/zomboid-world-map)";
const MOD_INTERVAL_SECONDS = 1; // ZMapPositions.lua write interval
const POSITIONS_FILE = "zmap_players.txt"; // B42 only lets Lua write .txt
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_MAX = 20000;

// The map the tiles are for: the 42.20.0 render on tiles.pzmap.org, built from the values in its
// layer0.dzi and map_info.json. The host blocks those files from servers, so they are copied here
// by hand; see "When a new game build is published" in the README.
export const MAP = mapFromDescriptors(
  "42.20.0",
  { tileSize: 2048, width: 2318656, height: 1019040 },
  { x0: 1040384, y0: -139296, sqr: 128, scale: 1 },
);

// Isometric projection: imageX = (x0 + (gx - gy) * sqr / 2) / scale
//                       imageY = (y0 + (gx + gy) * sqr / 4) / scale
export function mapFromDescriptors(dir, dzi, proj) {
  const maxLevel = Math.ceil(Math.log2(Math.max(dzi.width, dzi.height)));
  return {
    dir,
    format: "jpg",
    tileSize: dzi.tileSize,
    fullWidth: dzi.width,
    fullHeight: dzi.height,
    maxLevel,
    isoX0: proj.x0 / proj.scale,
    isoY0: proj.y0 / proj.scale,
    isoHalfSqr: proj.sqr / 2 / proj.scale,
    isoQuarterSqr: proj.sqr / 4 / proj.scale,
  };
}

export function loadConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    serverName: env.SERVER_NAME || "Project Zomboid",
    serverIni: env.SERVER_INI || "pzserver", // <data>/Server/<name>.ini, where PublicName lives
    dataPath: env.PZ_DATA_PATH || "",
    refreshSeconds: num(env.REFRESH_SECONDS, 5),
    bindAddr: env.BIND_ADDR || "127.0.0.1",
    port: num(env.PORT, 8780),
    tileCacheDir: env.TILE_CACHE_DIR || path.join(HERE, "tile-cache"),
    tileCacheMaxBytes: num(env.TILE_CACHE_MAX_MB, 1024) * 1024 * 1024,
    tilesRoot: env.TILES_ROOT || TILES_ROOT,
    // Where dead players are remembered across restarts, and how long their marker stays (0 = until they respawn).
    stateFile: env.STATE_FILE || path.join(HERE, "dead-players.json"),
    deadKeepHours: Number.isFinite(Number(env.DEAD_KEEP_HOURS)) && Number(env.DEAD_KEEP_HOURS) > 0 ? Number(env.DEAD_KEEP_HOURS) : 0,
  };
}

// ---- version --------------------------------------------------------------

// package.json version plus the checked-out commit, read straight from .git so it works
// without the git binary and when git would refuse the repo ("dubious ownership").
export function readVersion(root = HERE) {
  let version = null;
  let commit = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null;
  } catch {}
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    let sha = head;
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      try {
        sha = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
      } catch {
        const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
        sha = packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] || "";
      }
    }
    if (/^[0-9a-f]{40}$/.test(sha)) commit = sha.slice(0, 7);
  } catch {}
  return { version, commit };
}

// ---- server name ----------------------------------------------------------

// PublicName from the game's own ini, so the page title follows the server's settings.
// Falls back to SERVER_NAME when the file is unreadable or the name is empty.
export function readServerName(cfg) {
  try {
    const ini = fs.readFileSync(path.join(cfg.dataPath, "Server", `${cfg.serverIni}.ini`), "utf8");
    const name = (ini.match(/^PublicName=(.*)$/m) || [])[1]?.trim();
    if (name) return name.slice(0, 100);
  } catch {}
  return cfg.serverName;
}

// ---- in-game time: from the mod's file, sanitised like the rest ----------

export function cleanGameTime(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { y, mo, d, h, mi } = raw;
  if (![y, mo, d, h, mi].every(Number.isInteger)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { y, mo, d, h, mi };
}

// ---- safehouses: sanitised from the mod's file, which is trusted but may be mid-write or odd ----
const SAFEHOUSE_MAX = 500;
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

export function cleanSafehouses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => h && [h.x, h.y, h.w, h.h].every(Number.isFinite) && h.w > 0 && h.h > 0)
    .slice(0, SAFEHOUSE_MAX)
    .map((h) => ({
      owner: clip(h.owner, 64),
      title: clip(h.title, 64),
      x: h.x, y: h.y, w: h.w, h: h.h,
      members: (Array.isArray(h.members) ? h.members : []).filter((m) => typeof m === "string").slice(0, 50).map((m) => m.slice(0, 64)),
    }));
}

// ---- dead players: the mod reports a death while it knows of one, the server keeps it ----
const DEAD_MAX = 200;
const deadStore = new Map(); // state file -> Map(name -> {name, x, y, z, diedAt})

export function cleanDead(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => d && typeof d.name === "string" && Number.isFinite(d.x) && Number.isFinite(d.y))
    .slice(0, DEAD_MAX)
    .map((d) => ({ name: d.name.slice(0, 64), x: d.x, y: d.y, z: Number.isFinite(d.z) ? d.z : 0 }));
}

function loadDead(cfg) {
  let m = deadStore.get(cfg.stateFile);
  if (m) return m;
  m = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"));
    if (Array.isArray(saved)) for (const d of saved) {
      const [c] = cleanDead([d]);
      if (c) m.set(c.name, { ...c, diedAt: Number.isFinite(d.diedAt) ? d.diedAt : Date.now() });
    }
  } catch {}
  deadStore.set(cfg.stateFile, m);
  return m;
}

// Adds new deaths, drops anyone alive again or expired, saves if anything changed.
// `reported` is null when the mod's file couldn't be read: then only expiry applies.
function updateDead(cfg, reported, alive, now) {
  const m = loadDead(cfg);
  let changed = false;
  for (const d of reported || []) {
    if (!m.has(d.name) && !alive.has(d.name) && m.size < DEAD_MAX) { m.set(d.name, { ...d, diedAt: now }); changed = true; }
  }
  for (const [name, d] of m) {
    if (alive.has(name) || (cfg.deadKeepHours && now - d.diedAt > cfg.deadKeepHours * 3600_000)) { m.delete(name); changed = true; }
  }
  if (changed) {
    try { fs.writeFileSync(cfg.stateFile, JSON.stringify([...m.values()])); } catch (e) { console.error("zmap: could not save", cfg.stateFile, e.message); }
  }
  return [...m.values()];
}

// ---- positions ------------------------------------------------------------

export function readPlayers(cfg, now = Date.now()) {
  const file = path.join(cfg.dataPath, "Lua", POSITIONS_FILE);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { available: false, stale: true, reason: "no-file", updatedAt: null, players: [], dead: [...loadDead(cfg).values()], safehouses: [], gameTime: null };
  }
  const ageMs = now - stat.mtimeMs;
  const staleAfterMs = Math.max(cfg.refreshSeconds, MOD_INTERVAL_SECONDS) * 3000;
  const stale = ageMs > staleAfterMs;
  const base = { available: true, stale, reason: stale ? "stale" : null, ageSeconds: Math.round(ageMs / 1000), updatedAt: stat.mtimeMs };
  let players = [];
  let safehouses = [];
  let gameTime = null;
  let reportedDead = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    safehouses = cleanSafehouses(data.safehouses);
    gameTime = cleanGameTime(data.time);
    reportedDead = cleanDead(data.dead);
    players = (Array.isArray(data.players) ? data.players : [])
      .filter((p) => p && typeof p.name === "string" && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ name: p.name, x: p.x, y: p.y, z: Number.isFinite(p.z) ? p.z : 0, hp: Number.isFinite(p.hp) ? Math.max(0, Math.min(100, Math.round(p.hp))) : null, car: typeof p.car === "boolean" ? p.car : null }));
  } catch {
    // Mid-write read; the client keeps its last good state and retries.
    return { ...base, players: [], dead: [...loadDead(cfg).values()], safehouses: [], gameTime: null, error: "unreadable" };
  }
  // A stale file says nothing new about deaths or respawns; the remembered ones stay.
  const dead = stale ? [...loadDead(cfg).values()] : updateDead(cfg, reportedDead, new Set(players.map((p) => p.name)), now);
  // A stale file means the server (or mod) stopped: nobody is shown as online and the clock is
  // hidden (it would be frozen). Safehouses are persistent, so the last known ones stay on the map.
  return { ...base, players: stale ? [] : players, dead, safehouses, gameTime: stale ? null : gameTime };
}

// ---- game version ---------------------------------------------------------

const majorOf = (v) => String(v).split(".")[0];

// The running game version from server-console.txt. `supported` compares only the major build
// (42) with the one the map is for: the server runs 42.21.0 against 42.20.0 tiles, so comparing
// the full version would warn forever.
export function readBuildInfo(cfg) {
  let version = null;
  let fd;
  try {
    fd = fs.openSync(path.join(cfg.dataPath, "server-console.txt"), "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    // Usually on the first line, but do not depend on it: take the first match near the top.
    version = (buf.toString("utf8", 0, n).match(/\bversion=(\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { version, supported: version === null ? null : majorOf(version) === majorOf(MAP.dir) };
}

// ---- curl (Cloudflare can reject Node's TLS stack) -------------------------

const CURL_MARKER = Buffer.from("\n__CURL_HTTP_STATUS__:");

// Always an argument array, never a shell; `--` stops curl parsing the URL as a flag.
function curlGet(url, timeoutS = 8) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "--max-time", String(timeoutS), "-A", USER_AGENT, "-w", `${CURL_MARKER.toString()}%{http_code}`, "--", url],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: (timeoutS + 2) * 1000 },
      (err, stdout) => {
        if (err && !stdout?.length) return reject(err);
        const idx = stdout.lastIndexOf(CURL_MARKER);
        if (idx === -1) return reject(new Error("curl output missing status"));
        const status = Number(stdout.subarray(idx + CURL_MARKER.length).toString().trim());
        resolve({ status, body: stdout.subarray(0, idx) });
      },
    );
  });
}

// ---- tile proxy and disk cache -------------------------------------------

let tileIndex = null; // Map relPath -> {size, mtime}, rebuilt lazily from disk
let tileBytes = 0;
const inflight = new Map();
const negative = new Map(); // relPath -> expiry; upstream answered 404 = empty area

const tilesDir = (cfg) => path.join(cfg.tileCacheDir, "tiles");

function walkTiles(root, prefix, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkTiles(root, rel, out);
    else out.push(rel);
  }
}

function buildTileIndex(cfg) {
  tileIndex = new Map();
  tileBytes = 0;
  const files = [];
  walkTiles(tilesDir(cfg), "", files);
  for (const rel of files) {
    const st = fs.statSync(path.join(tilesDir(cfg), rel));
    tileIndex.set(rel, { size: st.size, mtime: st.mtimeMs });
    tileBytes += st.size;
  }
}

export function cacheTile(cfg, rel, buf) {
  if (!tileIndex) buildTileIndex(cfg);
  const file = path.join(tilesDir(cfg), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const prev = tileIndex.get(rel);
  if (prev) tileBytes -= prev.size;
  tileIndex.set(rel, { size: buf.length, mtime: Date.now() });
  tileBytes += buf.length;
  if (tileBytes > cfg.tileCacheMaxBytes) {
    const oldestFirst = [...tileIndex.entries()].sort((a, b) => a[1].mtime - b[1].mtime);
    for (const [key, meta] of oldestFirst) {
      if (tileBytes <= cfg.tileCacheMaxBytes || key === rel) break;
      fs.rmSync(path.join(tilesDir(cfg), key), { force: true });
      tileIndex.delete(key);
      tileBytes -= meta.size;
    }
  }
}

export function readCachedTile(cfg, rel) {
  try {
    const file = path.join(tilesDir(cfg), rel);
    const buf = fs.readFileSync(file);
    const now = new Date();
    fs.utimes(file, now, now, () => {}); // LRU touch
    if (tileIndex?.has(rel)) tileIndex.get(rel).mtime = now.getTime();
    return buf;
  } catch {
    return null;
  }
}

export const hasCachedTile = (cfg, rel) => fs.existsSync(path.join(tilesDir(cfg), rel));

// Node's fetch first; curl as a fallback because Cloudflare in front of the
// tile host can reject Node's TLS fingerprint.
export async function fetchUpstream(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) return { status: 404 };
    if (res.ok) return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
  } catch {}
  try {
    const r = await curlGet(url, 20);
    if (r.status === 200 || r.status === 404) return r;
  } catch {}
  return { status: 502 };
}

// Cache path (rel) and upstream URL for a tile. Floor 0 keeps the original cache layout so tiles
// cached before floors existed stay valid; other floors live under f<floor>/. Upstream names the
// floor layer by number: layer0_files, layer1_files, layer-1_files.
export function tilePaths(cfg, floor, level, tile) {
  return {
    rel: floor === 0 ? `${MAP.dir}/${level}/${tile}` : `${MAP.dir}/f${floor}/${level}/${tile}`,
    upstream: `${cfg.tilesRoot}/${MAP.dir}/base/layer${floor}_files/${level}/${tile}`,
  };
}

async function serveTile(cfg, floor, level, tile, res) {
  const { rel, upstream } = tilePaths(cfg, floor, level, tile);
  const expiry = negative.get(rel);
  if (expiry && expiry > Date.now()) {
    res.writeHead(404, { "X-Tile-Cache": "hit", "Cache-Control": "public, max-age=3600" });
    return res.end();
  }
  let body = readCachedTile(cfg, rel);
  let cache = "hit";
  if (!body) {
    cache = "miss";
    if (!inflight.has(rel)) {
      // Cache inside the shared promise so concurrent misses write the tile once.
      const p = fetchUpstream(upstream)
        .then((r) => {
          if (r.status === 200) {
            try {
              cacheTile(cfg, rel, r.body);
            } catch {}
          }
          return r;
        })
        .finally(() => inflight.delete(rel));
      inflight.set(rel, p);
    }
    const r = await inflight.get(rel);
    if (r.status === 404) {
      // An area with nothing rendered: remember it so we do not ask the host again for a while.
      if (negative.size >= NEGATIVE_MAX) negative.delete(negative.keys().next().value);
      negative.set(rel, Date.now() + NEGATIVE_TTL_MS);
      res.writeHead(404, { "X-Tile-Cache": cache, "Cache-Control": "public, max-age=3600" });
      return res.end();
    }
    if (r.status !== 200) {
      res.writeHead(502, { "X-Tile-Cache": cache });
      return res.end();
    }
    body = r.body;
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=86400",
    "X-Tile-Cache": cache,
  });
  res.end(body);
}

// ---- http -----------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

export function createServer(cfg) {
  const publicDir = path.join(HERE, "public");
  const app = readVersion(); // fixed for the life of the process, like the code it describes
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/api/players") return json(res, 200, readPlayers(cfg));
    if (p === "/api/meta") {
      return json(res, 200, { app, serverName: readServerName(cfg), refreshSeconds: cfg.refreshSeconds, build: readBuildInfo(cfg), map: MAP });
    }
    // /tiles/<level>/<col>_<row>.jpg is the ground floor; /tiles/f<floor>/<level>/... other floors.
    const tm = p.match(/^\/tiles\/(?:f(-?\d)\/)?(\d{1,2})\/(\d{1,6}_\d{1,6})\.jpg$/);
    if (tm) {
      const floor = tm[1] === undefined ? 0 : Number(tm[1]);
      const level = Number(tm[2]);
      if (level > MAP.maxLevel) return json(res, 400, { error: "invalid level" });
      if (floor < FLOOR_MIN || floor > FLOOR_MAX) return json(res, 400, { error: "invalid floor" });
      return serveTile(cfg, floor, level, `${tm[3]}.jpg`, res);
    }

    // Static files, with traversal guard.
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !MIME[path.extname(file)]) return json(res, 404, { error: "not found" });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)], "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  if (!cfg.dataPath) {
    console.error("PZ_DATA_PATH is required (see deploy/zmap.env.example)");
    process.exit(1);
  }
  fs.mkdirSync(cfg.tileCacheDir, { recursive: true });
  createServer(cfg).listen(cfg.port, cfg.bindAddr, () =>
    console.log(`zmap listening on http://${cfg.bindAddr}:${cfg.port}`),
  );
}
