import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAP_B41, loadConfig, readPlayers, readBuildInfo, checkBuildChange, cacheTile, readCachedTile, createServer } from "../server.js";
import { gameToDzi, dziToGame, levelForScale, tileSpan, scaleForZoom, zoomForScale, parseView } from "../public/projection.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zmap-"));
}

function setup() {
  const dataPath = tmp();
  const installPath = tmp();
  fs.mkdirSync(path.join(dataPath, "Lua"));
  fs.mkdirSync(path.join(installPath, "steamapps"));
  const cfg = loadConfig({ PZ_DATA_PATH: dataPath, PZ_INSTALL_PATH: installPath, TILE_CACHE_DIR: tmp(), REFRESH_SECONDS: "5" });
  return { cfg, dataPath, installPath };
}

test("projection round-trips and matches known B41 origin", () => {
  for (const [x, y] of [[0, 0], [10800, 10000], [12000, 8000]]) {
    const d = gameToDzi(x, y, MAP_B41);
    const g = dziToGame(d.x, d.y, MAP_B41);
    assert.ok(Math.abs(g.x - x) < 1e-6 && Math.abs(g.y - y) < 1e-6);
  }
  assert.deepEqual(gameToDzi(0, 0, MAP_B41), { x: 1017856, y: -152000 });
});

test("level and zoom helpers", () => {
  assert.equal(scaleForZoom(MAP_B41.maxLevel, MAP_B41), 1);
  assert.equal(zoomForScale(scaleForZoom(14, MAP_B41), MAP_B41), 14);
  assert.equal(levelForScale(1, MAP_B41), MAP_B41.renderedMaxLevel);
  assert.equal(levelForScale(1e-9, MAP_B41), 0);
  assert.equal(tileSpan(MAP_B41.maxLevel, MAP_B41), 1024);
});

test("parseView reads shareable URL params", () => {
  assert.deepEqual(parseView("?x=10000&y=9000&zoom=12", MAP_B41), { x: 10000, y: 9000, zoom: 12 });
  assert.equal(parseView("?zoom=3", MAP_B41), null);
  assert.equal(parseView("?x=1&y=2&zoom=99", MAP_B41).zoom, MAP_B41.maxLevel);
});

test("readPlayers: fresh, stale, missing and half-written files", () => {
  const { cfg, dataPath } = setup();
  assert.equal(readPlayers(cfg).available, false);
  const file = path.join(dataPath, "Lua", "zmap_players.json");
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [{ name: "Bob", x: 10, y: 20, z: 0 }, { name: 5 }] }));
  const fresh = readPlayers(cfg);
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.players, [{ name: "Bob", x: 10, y: 20, z: 0 }]);
  const later = readPlayers(cfg, Date.now() + 60_000);
  assert.equal(later.stale, true);
  assert.deepEqual(later.players, []);
  fs.writeFileSync(file, '{"t":1,"play');
  assert.equal(readPlayers(cfg).error, "unreadable");
});

test("readBuildInfo parses manifest and console version", () => {
  const { cfg, dataPath, installPath } = setup();
  fs.writeFileSync(path.join(installPath, "steamapps", "appmanifest_380870.acf"), '"AppState"\n{\n\t"buildid"\t\t"12345"\n\t"UserConfig"\n\t{\n\t\t"BetaKey"\t\t"b41"\n\t}\n}');
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=41.78.16 demo\nmore");
  assert.deepEqual(readBuildInfo(cfg), { buildId: "12345", branch: "b41", version: "41.78.16", supported: true });
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=42.13.0");
  assert.equal(readBuildInfo(cfg).supported, false);
});

test("tile cache evicts oldest and purges on build change", () => {
  const { cfg } = setup();
  cfg.tileCacheMaxBytes = 25;
  cacheTile(cfg, "1/0_0.jpg", Buffer.alloc(10));
  cacheTile(cfg, "1/0_1.jpg", Buffer.alloc(10));
  cacheTile(cfg, "1/1_0.jpg", Buffer.alloc(10));
  assert.equal(readCachedTile(cfg, "1/0_0.jpg"), null);
  assert.ok(readCachedTile(cfg, "1/1_0.jpg"));

  assert.equal(checkBuildChange(cfg, { buildId: "1" }), false);
  assert.equal(checkBuildChange(cfg, { buildId: "1" }), false);
  assert.ok(readCachedTile(cfg, "1/1_0.jpg"));
  assert.equal(checkBuildChange(cfg, { buildId: "2" }), true);
  assert.equal(readCachedTile(cfg, "1/1_0.jpg"), null);
});

test("http api: players, meta, tile validation, traversal", async () => {
  const { cfg, dataPath } = setup();
  fs.writeFileSync(path.join(dataPath, "Lua", "zmap_players.json"), JSON.stringify({ t: 1, players: [{ name: "A", x: 1, y: 2, z: 0 }] }));
  cacheTile(cfg, "5/0_0.jpg", Buffer.from("jpg"));
  const server = createServer(cfg);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const players = await (await fetch(`${base}/api/players`)).json();
    assert.equal(players.players[0].name, "A");
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.map.tileSize, 1024);
    assert.equal(meta.refreshSeconds, 5);
    const tile = await fetch(`${base}/tiles/5/0_0.jpg`);
    assert.equal(tile.status, 200);
    assert.equal(tile.headers.get("x-tile-cache"), "hit");
    assert.equal((await fetch(`${base}/tiles/99/0_0.jpg`)).status, 400);
    assert.equal((await fetch(`${base}/tiles/5/..%2f..%2fx.jpg`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/players`, { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});
