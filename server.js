// Live Project Zomboid (Build 41) world map. Read-only, zero dependencies.
// Config comes from environment variables, see deploy/zmap.env.example.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILES_ROOT = "https://tiles.pzmap.org";
const B41_TILE_DIR = "41.78.16/base/layer0_files";
const USER_AGENT = "zomboid-world-map/1.0 (+https://github.com/ruku1143/zomboid-world-map)";
const MOD_INTERVAL_SECONDS = 2; // ZMapPositions.lua write interval

// Build 41 geometry and isometric projection, from pzmap.org / upstream WorldMap.tsx.
export const MAP_B41 = {
  tileSize: 1024,
  fullWidth: 2285184,
  fullHeight: 990400,
  maxLevel: 22,
  renderedMaxLevel: 16,
  isoX0: 1017856,
  isoY0: -152000,
  isoHalfSqr: 64,
  isoQuarterSqr: 32,
};

export function loadConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    serverName: env.SERVER_NAME || "Project Zomboid",
    dataPath: env.PZ_DATA_PATH || "",
    installPath: env.PZ_INSTALL_PATH || "",
    refreshSeconds: num(env.REFRESH_SECONDS, 5),
    bindAddr: env.BIND_ADDR || "127.0.0.1",
    port: num(env.PORT, 8780),
    tileCacheDir: env.TILE_CACHE_DIR || path.join(HERE, "tile-cache"),
    tileCacheMaxBytes: num(env.TILE_CACHE_MAX_MB, 1024) * 1024 * 1024,
    tilesRoot: env.TILES_ROOT || TILES_ROOT,
  };
}

// ---- positions ------------------------------------------------------------

export function readPlayers(cfg, now = Date.now()) {
  const file = path.join(cfg.dataPath, "Lua", "zmap_players.json");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { available: false, stale: true, updatedAt: null, players: [] };
  }
  const ageMs = now - stat.mtimeMs;
  const staleAfterMs = Math.max(cfg.refreshSeconds, MOD_INTERVAL_SECONDS) * 3000;
  let players = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    players = (Array.isArray(data.players) ? data.players : [])
      .filter((p) => p && typeof p.name === "string" && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ name: p.name, x: p.x, y: p.y, z: Number.isFinite(p.z) ? p.z : 0 }));
  } catch {
    // Mid-write read; the client keeps its last good state and retries.
    return { available: true, stale: ageMs > staleAfterMs, updatedAt: stat.mtimeMs, players: [], error: "unreadable" };
  }
  const stale = ageMs > staleAfterMs;
  // A stale file means the server (or mod) stopped: nobody is shown as online.
  return { available: true, stale, updatedAt: stat.mtimeMs, players: stale ? [] : players };
}

// ---- build detection ------------------------------------------------------

export function readBuildInfo(cfg) {
  let buildId = null;
  let branch = null;
  let version = null;
  try {
    const acf = fs.readFileSync(path.join(cfg.installPath, "steamapps", "appmanifest_380870.acf"), "utf8");
    buildId = (acf.match(/"buildid"\s+"(\d+)"/) || [])[1] || null;
    branch = (acf.match(/"BetaKey"\s+"([^"]*)"/) || [])[1] || null;
  } catch {}
  try {
    const fd = fs.openSync(path.join(cfg.dataPath, "server-console.txt"), "r");
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    version = (buf.toString("utf8").split(/\r?\n/)[0].match(/version=(\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
  } catch {}
  const supported = version === null ? null : version.startsWith("41.");
  return { buildId, branch, version, supported };
}

// Clears the tile cache when the Steam buildid changes. Returns true if purged.
export function checkBuildChange(cfg, build) {
  if (!build.buildId) return false;
  const stateFile = path.join(cfg.tileCacheDir, "build.json");
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(stateFile, "utf8")).buildId;
  } catch {}
  if (previous === build.buildId) return false;
  const purged = previous !== null;
  if (purged) {
    for (const entry of fs.readdirSync(cfg.tileCacheDir)) {
      if (entry !== "build.json") fs.rmSync(path.join(cfg.tileCacheDir, entry), { recursive: true, force: true });
    }
    tileIndex = null;
  }
  fs.mkdirSync(cfg.tileCacheDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ buildId: build.buildId }));
  return purged;
}

// ---- tile proxy and disk cache -------------------------------------------

let tileIndex = null; // Map relPath -> {size, mtime}, rebuilt lazily from disk
let tileBytes = 0;
const inflight = new Map();

function buildTileIndex(cfg) {
  tileIndex = new Map();
  tileBytes = 0;
  const root = path.join(cfg.tileCacheDir, "b41");
  let levels = [];
  try {
    levels = fs.readdirSync(root);
  } catch {}
  for (const level of levels) {
    for (const file of fs.readdirSync(path.join(root, level))) {
      const st = fs.statSync(path.join(root, level, file));
      tileIndex.set(`${level}/${file}`, { size: st.size, mtime: st.mtimeMs });
      tileBytes += st.size;
    }
  }
}

export function cacheTile(cfg, rel, buf) {
  if (!tileIndex) buildTileIndex(cfg);
  const file = path.join(cfg.tileCacheDir, "b41", rel);
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
      fs.rmSync(path.join(cfg.tileCacheDir, "b41", key), { force: true });
      tileIndex.delete(key);
      tileBytes -= meta.size;
    }
  }
}

export function readCachedTile(cfg, rel) {
  try {
    const file = path.join(cfg.tileCacheDir, "b41", rel);
    const buf = fs.readFileSync(file);
    const now = new Date();
    fs.utimes(file, now, now, () => {}); // LRU touch
    if (tileIndex?.has(rel)) tileIndex.get(rel).mtime = now.getTime();
    return buf;
  } catch {
    return null;
  }
}

function curlFetch(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-sS", "-f", "--max-time", "20", "-A", USER_AGENT, url],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

// Node's fetch first; curl as a fallback because Cloudflare in front of the
// tile host has been known to reject non-curl TLS fingerprints.
async function fetchUpstream(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) return { status: 404 };
    if (res.ok) return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
  } catch {}
  try {
    return { status: 200, body: await curlFetch(url) };
  } catch {
    return { status: 502 };
  }
}

async function serveTile(cfg, level, tile, res) {
  const rel = `${level}/${tile}`;
  let body = readCachedTile(cfg, rel);
  let cache = "hit";
  if (!body) {
    cache = "miss";
    if (!inflight.has(rel)) {
      const p = fetchUpstream(`${cfg.tilesRoot}/${B41_TILE_DIR}/${level}/${tile}`).finally(() => inflight.delete(rel));
      inflight.set(rel, p);
    }
    const r = await inflight.get(rel);
    if (r.status !== 200) {
      res.writeHead(r.status, { "X-Tile-Cache": cache });
      return res.end();
    }
    body = r.body;
    try {
      cacheTile(cfg, rel, body);
    } catch {}
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=86400",
    "X-Tile-Cache": cache,
  });
  res.end(body);
}

// ---- http -----------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

export function createServer(cfg) {
  const publicDir = path.join(HERE, "public");
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/api/players") return json(res, 200, readPlayers(cfg));
    if (p === "/api/meta") {
      const build = readBuildInfo(cfg);
      return json(res, 200, { serverName: cfg.serverName, refreshSeconds: cfg.refreshSeconds, build, map: MAP_B41 });
    }
    const tm = p.match(/^\/tiles\/(\d{1,2})\/(\d{1,6}_\d{1,6})\.jpg$/);
    if (tm) {
      const level = Number(tm[1]);
      if (level > MAP_B41.maxLevel) return json(res, 400, { error: "invalid level" });
      return serveTile(cfg, level, `${tm[2]}.jpg`, res);
    }

    // Static files, with traversal guard.
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !MIME[path.extname(file)]) return json(res, 404, { error: "not found" });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)], "Cache-Control": "no-cache" });
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
  const check = () => {
    try {
      if (checkBuildChange(cfg, readBuildInfo(cfg))) console.log("PZ build changed, tile cache cleared");
    } catch (e) {
      console.error("build check failed:", e.message);
    }
  };
  check();
  setInterval(check, 60_000).unref();
  createServer(cfg).listen(cfg.port, cfg.bindAddr, () =>
    console.log(`zmap listening on http://${cfg.bindAddr}:${cfg.port}`),
  );
}
