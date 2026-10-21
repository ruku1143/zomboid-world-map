import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  MAP_FALLBACK, mapFromDescriptors, mapCandidates, loadConfig, readPlayers, readBuildInfo,
  checkBuildChange, cacheTile, readCachedTile, createServer, resolveMap, _resetMapState,
} from "../server.js";
import { gameToDzi, dziToGame, levelForScale, tileSpan, scaleForZoom, zoomForScale, parseView } from "../public/projection.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zmap-"));

function setup(extra = {}) {
  const dataPath = tmp();
  const installPath = tmp();
  fs.mkdirSync(path.join(dataPath, "Lua"));
  fs.mkdirSync(path.join(installPath, "steamapps"));
  const cfg = loadConfig({ PZ_DATA_PATH: dataPath, PZ_INSTALL_PATH: installPath, TILE_CACHE_DIR: tmp(), REFRESH_SECONDS: "5", ...extra });
  return { cfg, dataPath, installPath };
}

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

test("projection round-trips and matches the 42.20.0 origin", () => {
  const m = MAP_FALLBACK;
  for (const [x, y] of [[0, 0], [10800, 10000], [12000, 8000]]) {
    const d = gameToDzi(x, y, m);
    const g = dziToGame(d.x, d.y, m);
    assert.ok(Math.abs(g.x - x) < 1e-6 && Math.abs(g.y - y) < 1e-6);
  }
  assert.deepEqual(gameToDzi(0, 0, m), { x: 1040384, y: -139296 });
  assert.deepEqual(gameToDzi(1, 0, m), { x: 1040384 + 64, y: -139296 + 32 });
});

test("scale divides the projection (skip > 0)", () => {
  const m = mapFromDescriptors("x", { tileSize: 1024, width: 1157312, height: 509520 }, { x0: 1036288, y0: -139296, sqr: 128, scale: 2 });
  assert.deepEqual(gameToDzi(0, 0, m), { x: 518144, y: -69648 });
  assert.equal(m.isoHalfSqr, 32);
  assert.equal(m.maxLevel, 21);
});

test("level and zoom helpers", () => {
  const m = MAP_FALLBACK;
  assert.equal(m.maxLevel, 22);
  assert.equal(scaleForZoom(m.maxLevel, m), 1);
  assert.equal(zoomForScale(scaleForZoom(14, m), m), 14);
  assert.equal(levelForScale(1, m), m.renderedMaxLevel);
  assert.equal(levelForScale(1e-9, m), 0);
  assert.equal(tileSpan(m.maxLevel, m), m.tileSize);
});

test("parseView reads shareable URL params", () => {
  const m = MAP_FALLBACK;
  assert.deepEqual(parseView("?x=10000&y=9000&zoom=12", m), { x: 10000, y: 9000, zoom: 12 });
  assert.equal(parseView("?zoom=3", m), null);
  assert.equal(parseView("?x=1&y=2&zoom=99", m).zoom, m.maxLevel);
});

test("readPlayers: .txt file, fresh, stale, missing and half-written", () => {
  const { cfg, dataPath } = setup();
  const missing = readPlayers(cfg);
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "no-file");
  const file = path.join(dataPath, "Lua", "zmap_players.txt");
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [{ name: "Bob", x: 10, y: 20, z: 0 }, { name: 5 }] }));
  const fresh = readPlayers(cfg);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.reason, null);
  assert.deepEqual(fresh.players, [{ name: "Bob", x: 10, y: 20, z: 0 }]);
  const later = readPlayers(cfg, Date.now() + 60_000);
  assert.equal(later.stale, true);
  assert.equal(later.reason, "stale");
  assert.ok(later.ageSeconds >= 59);
  assert.deepEqual(later.players, []);
  fs.writeFileSync(file, '{"t":1,"play');
  assert.equal(readPlayers(cfg).error, "unreadable");
});

test("readPlayers: an empty list is online-with-nobody, not offline", () => {
  const { cfg, dataPath } = setup();
  fs.writeFileSync(path.join(dataPath, "Lua", "zmap_players.txt"), '{"t":1,"players":[]}');
  const r = readPlayers(cfg);
  assert.equal(r.stale, false);
  assert.deepEqual(r.players, []);
});

test("readBuildInfo parses manifest and console version; B42 is supported", () => {
  const { cfg, dataPath, installPath } = setup();
  fs.writeFileSync(path.join(installPath, "steamapps", "appmanifest_380870.acf"), '"AppState"\n{\n\t"buildid"\t\t"25485538"\n}');
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=42.21.0 4a0e9546ec demo=false\nmore");
  assert.deepEqual(readBuildInfo(cfg), { buildId: "25485538", branch: null, version: "42.21.0", supported: true });
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=41.78.16");
  assert.equal(readBuildInfo(cfg).supported, false);
});

test("mapCandidates: override, running version, fallback, no duplicates", () => {
  const cfg = loadConfig({ MAP_DIR: "42.30.0" });
  assert.deepEqual(mapCandidates(cfg, { version: "42.21.0" }), ["42.30.0", "42.21.0", "42.20.0"]);
  assert.deepEqual(mapCandidates(loadConfig({}), { version: "42.20.0" }), ["42.20.0"]);
  assert.deepEqual(mapCandidates(loadConfig({}), null), ["42.20.0"]);
});

test("tile cache evicts oldest and purges on build change", () => {
  const { cfg } = setup();
  cfg.tileCacheMaxBytes = 25;
  cacheTile(cfg, "42.21.0/1/0_0.jpg", Buffer.alloc(10));
  cacheTile(cfg, "42.21.0/1/0_1.jpg", Buffer.alloc(10));
  cacheTile(cfg, "42.21.0/1/1_0.jpg", Buffer.alloc(10));
  assert.equal(readCachedTile(cfg, "42.21.0/1/0_0.jpg"), null);
  assert.ok(readCachedTile(cfg, "42.21.0/1/1_0.jpg"));

  assert.equal(checkBuildChange(cfg, { buildId: "1" }), false);
  assert.equal(checkBuildChange(cfg, { buildId: "1" }), false);
  assert.ok(readCachedTile(cfg, "42.21.0/1/1_0.jpg"));
  assert.equal(checkBuildChange(cfg, { buildId: "2" }), true);
  assert.equal(readCachedTile(cfg, "42.21.0/1/1_0.jpg"), null);
});

// A fake tiles host: serves descriptors for 42.21.0 only, one real tile, 404 for the rest.
function fakeTilesHost(hits) {
  return http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/42.21.0/base/layer0.dzi") {
      res.end('<Image TileSize="2048" Overlap="0" Format="jpg"><Size Width="2318656" Height="1019040"/></Image>');
    } else if (req.url === "/42.21.0/base/map_info.json") {
      res.end(JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 }));
    } else if (req.url === "/42.21.0/base/layer0_files/15/3_2.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end("JPEGDATA");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
}

test("resolveMap reads descriptors for the running version; tiles 404 stay empty and are not re-requested", async () => {
  _resetMapState();
  const hits = [];
  const host = fakeTilesHost(hits);
  const hostUrl = await listen(host);
  const { cfg, dataPath } = setup({ TILES_ROOT: hostUrl });
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=42.21.0 abc");
  fs.writeFileSync(path.join(dataPath, "Lua", "zmap_players.txt"), JSON.stringify({ t: 1, players: [{ name: "A", x: 1, y: 2, z: 0 }] }));
  const server = createServer(cfg);
  const base = await listen(server);
  try {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.mapSource, "dynamic");
    assert.equal(meta.map.dir, "42.21.0");
    assert.equal(meta.map.tileSize, 2048);
    assert.equal(meta.map.isoX0, 1040384);
    assert.equal(meta.build.supported, true);

    const players = await (await fetch(`${base}/api/players`)).json();
    assert.equal(players.players[0].name, "A");

    const ok = await fetch(`${base}/tiles/15/3_2.jpg`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "JPEGDATA");
    assert.equal((await fetch(`${base}/tiles/15/3_2.jpg`)).headers.get("x-tile-cache"), "hit");

    const before = hits.length;
    assert.equal((await fetch(`${base}/tiles/15/9_9.jpg`)).status, 404);
    const afterFirst = hits.length;
    assert.ok(afterFirst > before);
    assert.equal((await fetch(`${base}/tiles/15/9_9.jpg`)).status, 404);
    assert.equal(hits.length, afterFirst, "second request for an empty tile must not reach the host");

    assert.equal((await fetch(`${base}/tiles/99/0_0.jpg`)).status, 400);
    assert.equal((await fetch(`${base}/tiles/5/..%2f..%2fx.jpg`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/players`, { method: "POST" })).status, 405);
  } finally {
    server.close();
    host.close();
  }
});

test("resolveMap falls back to the baked 42.20.0 geometry when descriptors are unreachable", async () => {
  _resetMapState();
  const { cfg } = setup({ TILES_ROOT: "http://127.0.0.1:9" });
  const r = await resolveMap(cfg);
  assert.equal(r.source, "fallback");
  assert.equal(r.map.dir, "42.20.0");
  assert.ok(r.reason);
});
