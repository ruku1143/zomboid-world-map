// Live Project Zomboid (Build 42) world map. Read-only, zero dependencies.
// Config comes from environment variables, see deploy/zmap.env.example.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILES_ROOT = "https://tiles.pzmap.org";
const USER_AGENT = "zomboid-world-map/1.0 (+https://github.com/ruku1143/zomboid-world-map)";
const MOD_INTERVAL_SECONDS = 2; // ZMapPositions.lua write interval
const POSITIONS_FILES = ["zmap_players.txt", "zmap_players.json"]; // B42 only lets Lua write .txt
const MAP_TTL_MS = 24 * 60 * 60 * 1000;
const MAP_RETRY_MS = 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_MAX = 20000;

// Geometry of the 42.20.0 render on tiles.pzmap.org (from its map_info.json and
// layer0.dzi). Used only when the real descriptors cannot be fetched.
export const MAP_FALLBACK = mapFromDescriptors(
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
    renderedMaxLevel: maxLevel,
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
    dataPath: env.PZ_DATA_PATH || "",
    installPath: env.PZ_INSTALL_PATH || "",
    refreshSeconds: num(env.REFRESH_SECONDS, 5),
    bindAddr: env.BIND_ADDR || "127.0.0.1",
    port: num(env.PORT, 8780),
    tileCacheDir: env.TILE_CACHE_DIR || path.join(HERE, "tile-cache"),
    tileCacheMaxBytes: num(env.TILE_CACHE_MAX_MB, 1024) * 1024 * 1024,
    tilesRoot: env.TILES_ROOT || TILES_ROOT,
    mapDir: env.MAP_DIR || "", // optional: force a tiles.pzmap.org build directory
  };
}

// ---- positions ------------------------------------------------------------

export function readPlayers(cfg, now = Date.now()) {
  let file = null;
  let stat = null;
  for (const name of POSITIONS_FILES) {
    try {
      const candidate = path.join(cfg.dataPath, "Lua", name);
      const s = fs.statSync(candidate);
      if (!stat || s.mtimeMs > stat.mtimeMs) {
        file = candidate;
        stat = s;
      }
    } catch {}
  }
  if (!file) return { available: false, stale: true, reason: "no-file", updatedAt: null, players: [] };
  const ageMs = now - stat.mtimeMs;
  const staleAfterMs = Math.max(cfg.refreshSeconds, MOD_INTERVAL_SECONDS) * 3000;
  const stale = ageMs > staleAfterMs;
  const base = { available: true, stale, reason: stale ? "stale" : null, ageSeconds: Math.round(ageMs / 1000), updatedAt: stat.mtimeMs };
  let players = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    players = (Array.isArray(data.players) ? data.players : [])
      .filter((p) => p && typeof p.name === "string" && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ name: p.name, x: p.x, y: p.y, z: Number.isFinite(p.z) ? p.z : 0 }));
  } catch {
    // Mid-write read; the client keeps its last good state and retries.
    return { ...base, players: [], error: "unreadable" };
  }
  // A stale file means the server (or mod) stopped: nobody is shown as online.
  return { ...base, players: stale ? [] : players };
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
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // Usually on the first line, but do not depend on it: take the first match near the top.
    version = (buf.toString("utf8", 0, n).match(/\bversion=(\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
  } catch {}
  const supported = version === null ? null : version.startsWith("42.");
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
  fs.mkdirSync(cfg.tileCacheDir, { recursive: true });
  if (purged) {
    for (const entry of fs.readdirSync(cfg.tileCacheDir)) {
      if (entry !== "build.json") fs.rmSync(path.join(cfg.tileCacheDir, entry), { recursive: true, force: true });
    }
    tileIndex = null;
    negative.clear();
    mapState = null;
  }
  fs.writeFileSync(stateFile, JSON.stringify({ buildId: build.buildId }));
  return purged;
}

// ---- curl (Cloudflare challenges Node's TLS stack on descriptor paths) -----

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

// ---- map discovery --------------------------------------------------------

// Descriptors: curl first, then Node's own fetch. Which one Cloudflare lets through
// depends on the network the box is on, so try both before giving up.
async function getDescriptor(url) {
  let first = { status: 0 };
  try {
    first = await curlGet(url);
    if (first.status === 200) return first;
  } catch (e) {
    first = { status: 0, error: e };
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
    return { status: res.status, body: Buffer.alloc(0) };
  } catch {
    if (first.error) throw first.error;
    return first;
  }
}

// Returns {map} on success, or {why} naming the HTTP status of each descriptor.
async function fetchDescriptors(cfg, dir) {
  const base = `${cfg.tilesRoot}/${dir}/base`;
  const [dziRes, infoRes] = await Promise.all([getDescriptor(`${base}/layer0.dzi`), getDescriptor(`${base}/map_info.json`)]);
  if (dziRes.status !== 200 || infoRes.status !== 200) {
    return { why: `${dir}: layer0.dzi HTTP ${dziRes.status}, map_info.json HTTP ${infoRes.status}` };
  }
  const xml = dziRes.body.toString("utf8");
  const tileSize = Number(xml.match(/TileSize="(\d+)"/)?.[1]);
  const width = Number(xml.match(/Width="(\d+)"/)?.[1]);
  const height = Number(xml.match(/Height="(\d+)"/)?.[1]);
  let info;
  try {
    info = JSON.parse(infoRes.body.toString("utf8"));
  } catch {
    return { why: `${dir}: map_info.json is not JSON` };
  }
  const x0 = Number(info?.x0);
  const y0 = Number(info?.y0);
  const sqr = Number(info?.sqr);
  const skip = Number(info?.skip);
  if (!tileSize || !width || !height || !Number.isFinite(x0) || !Number.isFinite(y0) || !sqr) {
    return { why: `${dir}: descriptors missing expected fields` };
  }
  return { map: mapFromDescriptors(dir, { tileSize, width, height }, { x0, y0, sqr, scale: 1 << (Number.isFinite(skip) ? skip : 0) }) };
}

// Candidate build directories, best first: explicit override, the running game
// version (e.g. 42.21.0), then the known-good fallback.
export function mapCandidates(cfg, build) {
  return [...new Set([cfg.mapDir, build?.version, MAP_FALLBACK.dir].filter(Boolean))];
}

let mapState = null; // {map, source, reason, at}
let mapInflight = null;

// Tests only: forget the cached map resolution.
export function _resetMapState() {
  mapState = null;
  mapInflight = null;
}

export async function resolveMap(cfg) {
  const ttl = mapState?.source === "dynamic" ? MAP_TTL_MS : MAP_RETRY_MS;
  if (mapState && Date.now() - mapState.at < ttl) return mapState;
  if (!mapInflight) {
    mapInflight = (async () => {
      const build = readBuildInfo(cfg);
      const reasons = [];
      for (const dir of mapCandidates(cfg, build)) {
        try {
          const r = await fetchDescriptors(cfg, dir);
          if (r.map) return (mapState = { map: r.map, source: "dynamic", reason: null, at: Date.now() });
          reasons.push(r.why);
        } catch (e) {
          reasons.push(`${dir}: ${e.code === "ENOENT" ? "curl is not installed" : `curl failed (${e.message})`}`);
          if (e.code === "ENOENT") break;
        }
      }
      return (mapState = { map: MAP_FALLBACK, source: "fallback", reason: reasons.join("; "), at: Date.now() });
    })().finally(() => {
      mapInflight = null;
    });
  }
  return mapInflight;
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

// Node's fetch first; curl as a fallback because Cloudflare in front of the
// tile host can reject Node's TLS fingerprint.
async function fetchUpstream(url) {
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

async function serveTile(cfg, map, level, tile, res) {
  const rel = `${map.dir}/${level}/${tile}`;
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
      const p = fetchUpstream(`${cfg.tilesRoot}/${map.dir}/base/layer0_files/${level}/${tile}`).finally(() => inflight.delete(rel));
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
      const { map, source, reason } = await resolveMap(cfg);
      return json(res, 200, { serverName: cfg.serverName, refreshSeconds: cfg.refreshSeconds, build, map, mapSource: source, mapNote: reason });
    }
    const tm = p.match(/^\/tiles\/(\d{1,2})\/(\d{1,6}_\d{1,6})\.jpg$/);
    if (tm) {
      const { map } = await resolveMap(cfg);
      const level = Number(tm[1]);
      if (level > map.maxLevel) return json(res, 400, { error: "invalid level" });
      return serveTile(cfg, map, level, `${tm[2]}.jpg`, res);
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
  const check = () => {
    try {
      if (checkBuildChange(cfg, readBuildInfo(cfg))) console.log("PZ build changed, tile cache cleared");
    } catch (e) {
      console.error("build check failed:", e.message);
    }
  };
  check();
  setInterval(check, 60_000).unref();
  resolveMap(cfg).then((s) => console.log(`map: ${s.map.dir} (${s.source}${s.reason ? `: ${s.reason}` : ""})`));
  createServer(cfg).listen(cfg.port, cfg.bindAddr, () =>
    console.log(`zmap listening on http://${cfg.bindAddr}:${cfg.port}`),
  );
}
