// Warms the tile cache so the map does not depend on tiles.pzmap.org while you use it.
// Usage: node prefetch.js [maxLevel]   (default 17, about 0.5 GB; each level up is roughly 3x more)
// Needs the same environment as the service (see deploy/zmap.env.example). Safe to re-run:
// tiles already on disk are skipped.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, MAP as map, fetchUpstream, cacheTile, readCachedTile } from "./server.js";
import { tileSpan } from "./public/projection.js";

const CONCURRENCY = 4;
const RETRIES = 2;

export async function prefetch(cfg, maxLevel, log = console.log) {
  const top = Math.min(maxLevel, map.maxLevel);
  const totals = { fetched: 0, cached: 0, empty: 0, failed: 0 };
  for (let level = 0; level <= top; level++) {
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
        const rel = `${map.dir}/${level}/${tile}`;
        if (readCachedTile(cfg, rel)) { totals.cached++; continue; }
        let r = { status: 502 };
        for (let attempt = 0; attempt <= RETRIES && r.status !== 200 && r.status !== 404; attempt++) {
          r = await fetchUpstream(`${cfg.tilesRoot}/${map.dir}/base/layer0_files/${level}/${tile}`);
        }
        if (r.status === 200) { cacheTile(cfg, rel, r.body); totals.fetched++; }
        else if (r.status === 404) totals.empty++;
        else totals.failed++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    log(`level ${level}: ${jobs.length} cells, ${totals.fetched - before.fetched} downloaded, ${totals.cached - before.cached} already cached, ${totals.empty - before.empty} empty, ${totals.failed - before.failed} failed`);
  }
  return totals;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const level = Number(process.argv[2] ?? 17);
  if (!Number.isInteger(level) || level < 0 || level > 22) {
    console.error("usage: node prefetch.js [maxLevel 0-22]");
    process.exit(1);
  }
  const t = await prefetch(cfg, level);
  console.log(`done: ${t.fetched} downloaded, ${t.cached} already cached, ${t.empty} empty, ${t.failed} failed`);
  process.exit(t.failed ? 2 : 0);
}
