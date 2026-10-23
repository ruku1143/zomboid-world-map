// Warms the tile cache so the map does not depend on tiles.pzmap.org while you use it.
// Usage: node prefetch.js [maxLevel] [--floors=all|0,1,-1]
//   maxLevel: default 17 (about 150 MB for the ground floor; each level up is roughly 3x more)
//   --floors: ground floor only by default; "all" is basement to floor 7, or a comma list such as 0,1,2
// Needs the same environment as the service (see deploy/zmap.env.example). Safe to re-run:
// tiles already on disk are skipped.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, MAP as map, fetchUpstream, cacheTile, readCachedTile, tilePaths, FLOOR_MIN, FLOOR_MAX } from "./server.js";
import { tileSpan } from "./public/projection.js";

const CONCURRENCY = 4;
const RETRIES = 2;

// "all" -> every floor (ground first); "0,2,-1" -> those floors. Throws on anything else.
export function parseFloors(arg) {
  if (arg === undefined) return [0];
  if (arg === "all") return [0, ...Array.from({ length: FLOOR_MAX - FLOOR_MIN + 1 }, (_, i) => FLOOR_MIN + i).filter((f) => f !== 0)];
  const parts = String(arg).split(",").map((x) => x.trim());
  const floors = parts.map(Number);
  if (parts.some((x) => x === "") || floors.some((f) => !Number.isInteger(f) || f < FLOOR_MIN || f > FLOOR_MAX)) {
    throw new Error(`floors must be "all" or a comma list of integers from ${FLOOR_MIN} to ${FLOOR_MAX}`);
  }
  return [...new Set(floors)];
}

export async function prefetch(cfg, maxLevel, log = console.log, floors = [0]) {
  const top = Math.min(maxLevel, map.maxLevel);
  const totals = { fetched: 0, cached: 0, empty: 0, failed: 0 };
  for (const floor of floors) for (let level = 0; level <= top; level++) {
    const span = tileSpan(level, map);
    const jobs = [];
    for (let r = 0; r < Math.ceil(map.fullHeight / span); r++) {
      for (let c = 0; c < Math.ceil(map.fullWidth / span); c++) jobs.push(`${c}_${r}.jpg`);
    }
    const before = { ...totals };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const tile = jobs[next++];
        const { rel, upstream } = tilePaths(cfg, floor, level, tile);
        if (readCachedTile(cfg, rel)) { totals.cached++; continue; }
        let r = { status: 502 };
        for (let attempt = 0; attempt <= RETRIES && r.status !== 200 && r.status !== 404; attempt++) {
          r = await fetchUpstream(upstream);
        }
        if (r.status === 200) { cacheTile(cfg, rel, r.body); totals.fetched++; }
        else if (r.status === 404) totals.empty++;
        else totals.failed++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    log(`floor ${floor} level ${level}: ${jobs.length} cells, ${totals.fetched - before.fetched} downloaded, ${totals.cached - before.cached} already cached, ${totals.empty - before.empty} empty, ${totals.failed - before.failed} failed`);
  }
  return totals;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const args = process.argv.slice(2);
  const floorsArg = args.find((a) => a.startsWith("--floors="))?.slice("--floors=".length);
  const level = Number(args.find((a) => !a.startsWith("--")) ?? 17);
  let floors;
  try { floors = parseFloors(floorsArg); } catch (e) { console.error(e.message); process.exit(1); }
  if (!Number.isInteger(level) || level < 0 || level > 22) {
    console.error("usage: node prefetch.js [maxLevel 0-22] [--floors=all|0,1,-1]");
    process.exit(1);
  }
  const t = await prefetch(cfg, level, console.log, floors);
  console.log(`done: ${t.fetched} downloaded, ${t.cached} already cached, ${t.empty} empty, ${t.failed} failed`);
  process.exit(t.failed ? 2 : 0);
}
