import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  MAP, mapFromDescriptors, loadConfig, readPlayers, cleanDead, readBuildInfo,
  readVersion, cleanSafehouses, readServerName, cleanGameTime, tilePaths, cacheTile, readCachedTile, createServer,
} from "../server.js";
import { prefetch, parseFloors } from "../prefetch.js";
import { TOWNS } from "../public/towns.js";
import { gameToDzi, dziToGame, levelForScale, tileSpan, scaleForZoom, zoomForScale, parseView, exactTileRect, parentCrop, stepCamera, PAN_MS, clampFloor, floorLabel, parseFloor, assignColors, colorForName, safehouseCorners, PLAYER_COLORS, MIN_ZOOM } from "../public/projection.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zmap-"));

function setup(extra = {}) {
  const dataPath = tmp();
  fs.mkdirSync(path.join(dataPath, "Lua"));
  const cfg = loadConfig({ PZ_DATA_PATH: dataPath, TILE_CACHE_DIR: tmp(), REFRESH_SECONDS: "5", ...extra });
  return { cfg, dataPath };
}

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

test("projection round-trips and matches the 42.20.0 origin", () => {
  const m = MAP;
  for (const [x, y] of [[0, 0], [10800, 10000], [12000, 8000]]) {
    const d = gameToDzi(x, y, m);
    const g = dziToGame(d.x, d.y, m);
    assert.ok(Math.abs(g.x - x) < 1e-6 && Math.abs(g.y - y) < 1e-6);
  }
  assert.deepEqual(gameToDzi(0, 0, m), { x: 1040384, y: -139296 });
  assert.deepEqual(gameToDzi(1, 0, m), { x: 1040384 + 64, y: -139296 + 32 });
});

test("readVersion reads package.json and the commit from .git, loose or packed", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
  assert.deepEqual(readVersion(root), { version: "9.8.7", commit: null });

  const sha = "0123456789abcdef0123456789abcdef01234567";
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
  assert.deepEqual(readVersion(root), { version: "9.8.7", commit: "0123456" });

  fs.rmSync(path.join(root, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
  assert.equal(readVersion(root).commit, "0123456");

  fs.writeFileSync(path.join(root, ".git", "HEAD"), `${sha}\n`); // detached
  assert.equal(readVersion(root).commit, "0123456");
  assert.deepEqual(readVersion(tmp()), { version: null, commit: null });
});

test("assignColors: stable per name, distinct among online players, and falls back past the palette", () => {
  const names = ["Ruku", "Alex", "Sam", "Jo", "Mia", "Zed"];
  const all = assignColors(names);
  assert.equal(new Set(all.values()).size, names.length, "no two online players share a colour");
  // A player keeps their colour regardless of who else is online, as long as nobody collides with it.
  assert.equal(assignColors(["Ruku"]).get("Ruku"), assignColors(["Ruku"]).get("Ruku"));
  assert.deepEqual([...assignColors(["b", "a"]).entries()], [...assignColors(["a", "b"]).entries()], "input order does not matter");
  assert.ok(PLAYER_COLORS.includes(assignColors(["Ruku"]).get("Ruku")));
  // Two names forced onto the same preferred slot get different colours.
  const same = assignColors(["a", "b"], ["#111", "#222"]);
  assert.notEqual(same.get("a"), same.get("b"));
  // More players than colours: still one distinct colour each.
  const many = assignColors(["a", "b", "c"], ["#111", "#222"]);
  assert.equal(new Set(many.values()).size, 3);
  assert.equal(assignColors(["Ruku", "Ruku"]).size, 1);
});

test("safehouseCorners is the rectangle as a diamond in dzi pixels", () => {
  const m = MAP;
  const c = safehouseCorners({ x: 100, y: 200, w: 10, h: 20 }, m);
  assert.deepEqual(c[0], gameToDzi(100, 200, m));
  assert.deepEqual(c[2], gameToDzi(110, 220, m));
  // Moving along game x goes right and down, along game y goes left and down.
  assert.ok(c[1].x > c[0].x && c[1].y > c[0].y);
  assert.ok(c[3].x < c[0].x && c[3].y > c[0].y);
  assert.equal(colorForName("Ruku"), colorForName("Ruku"));
  assert.ok(PLAYER_COLORS.includes(colorForName("Ruku")));
});

test("cleanSafehouses keeps well-formed entries and drops junk", () => {
  const good = { owner: "Ruku", title: "Base", x: 1, y: 2, w: 10, h: 12, members: ["Ruku", "Alex", 7] };
  const out = cleanSafehouses([good, null, { x: 1, y: 2, w: 0, h: 5 }, { x: "1", y: 2, w: 3, h: 3 }, { x: 5, y: 5, w: 3, h: 3 }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { owner: "Ruku", title: "Base", x: 1, y: 2, w: 10, h: 12, members: ["Ruku", "Alex"] });
  assert.deepEqual(out[1], { owner: "", title: "", x: 5, y: 5, w: 3, h: 3, members: [] });
  assert.deepEqual(cleanSafehouses(undefined), []);
  assert.equal(cleanSafehouses(Array.from({ length: 600 }, () => good)).length, 500);
  assert.equal(cleanSafehouses([{ ...good, owner: "x".repeat(200) }])[0].owner.length, 64);
});

test("readPlayers returns safehouses, and keeps them when the file goes stale", () => {
  const { cfg, dataPath } = setup();
  const file = path.join(dataPath, "Lua", "zmap_players.txt");
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [{ name: "A", x: 1, y: 2, z: 0 }], safehouses: [{ owner: "A", title: "T", x: 3, y: 4, w: 5, h: 6, members: ["A"] }] }));
  const now = Date.now();
  const live = readPlayers(cfg, now);
  assert.equal(live.safehouses.length, 1);
  assert.equal(live.players.length, 1);
  const stale = readPlayers(cfg, now + 10 * 60 * 1000);
  assert.equal(stale.players.length, 0);
  assert.equal(stale.safehouses.length, 1, "safehouses are persistent, so the last known stay");
  // An older mod that writes no safehouses still works.
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [] }));
  assert.deepEqual(readPlayers(cfg).safehouses, []);
  assert.deepEqual(readPlayers(setup().cfg).safehouses, []);
});

test("edge tiles cover only their real share of the cell", () => {
  const m = MAP;
  // 42.20.0 level 12 tile 0_0 is 2048x996: a cell shown at 512px is 512 wide and ~249 tall, not 512 square.
  const d = exactTileRect(2048, 996, 512, m);
  assert.equal(d.w, 512);
  assert.equal(d.h, 996 / 4);
});

test("stand-in crops use the nominal tile size, not the ancestor's bitmap size", () => {
  const m = MAP;
  // Level 16 cell (6, 3) inside level 13 tile (0, 0), which is 2048x1991: 3 levels up, 8 cells per side.
  const k = parentCrop(6, 3, 3, 2048, 1991, m);
  assert.deepEqual([k.sx, k.sy, k.sw, k.sh, k.fw, k.fh], [6 * 256, 3 * 256, 256, 256, 1, 1]);
  // Level 12 tile 0_0 is only 996 tall: cell row 7, 4 levels down, starts at y=896 and has 100px of image.
  const e = parentCrop(6, 7, 4, 2048, 996, m);
  assert.deepEqual([e.sy, e.sh, e.fh], [896, 100, 100 / 128]);
  // Past the ancestor's real extent there is nothing to draw.
  assert.equal(parentCrop(6, 8, 4, 2048, 996, m), null);
});

test("scale divides the projection (skip > 0)", () => {
  const m = mapFromDescriptors("x", { tileSize: 1024, width: 1157312, height: 509520 }, { x0: 1036288, y0: -139296, sqr: 128, scale: 2 });
  assert.deepEqual(gameToDzi(0, 0, m), { x: 518144, y: -69648 });
  assert.equal(m.isoHalfSqr, 32);
  assert.equal(m.maxLevel, 21);
});

test("level and zoom helpers", () => {
  const m = MAP;
  assert.equal(m.maxLevel, 22);
  assert.equal(scaleForZoom(m.maxLevel, m), 1);
  assert.equal(zoomForScale(scaleForZoom(14, m), m), 14);
  assert.equal(levelForScale(1, m), m.maxLevel);
  assert.equal(levelForScale(1e-9, m), 0);
  assert.equal(tileSpan(m.maxLevel, m), m.tileSize);
});

test("stepCamera eases toward the goal, keeps the zoom anchor fixed and settles exactly", () => {
  const vw = 800, vh = 600;
  const screenToDzi = (c, sx, sy) => ({ x: (sx - vw / 2) / c.scale + c.x, y: (sy - vh / 2) / c.scale + c.y });
  const cam = { x: 1000, y: 2000, scale: 0.01 };
  const goal = { x: 1000, y: 2000, scale: 0.04, ax: 600, ay: 150 };
  const pinned = screenToDzi(cam, 600, 150);
  const s1 = stepCamera(cam, goal, 16, vw, vh);
  assert.ok(s1, "still moving after one frame");
  assert.ok(cam.scale > 0.01 && cam.scale < 0.04, "partway there");
  let p = screenToDzi(cam, 600, 150);
  assert.ok(Math.abs(p.x - pinned.x) < 1e-6 && Math.abs(p.y - pinned.y) < 1e-6, "the point under the cursor does not move");
  let frames = 0;
  while (stepCamera(cam, goal, 16, vw, vh) && frames++ < 1000);
  assert.ok(frames < 1000, "settles");
  assert.equal(cam.scale, 0.04);
  assert.equal(cam.x, goal.x);
  assert.equal(cam.y, goal.y);
  p = screenToDzi(cam, 600, 150);
  assert.ok(Math.abs(p.x - pinned.x) < 1e-6 && Math.abs(p.y - pinned.y) < 1e-6, "still anchored at the end");
  // Pure pan: exponential approach, about 63% after PAN_MS.
  const c2 = { x: 0, y: 0, scale: 1 }, g2 = { x: 1000, y: 0, scale: 1, ax: null, ay: null };
  stepCamera(c2, g2, PAN_MS, vw, vh);
  assert.ok(Math.abs(c2.x - 1000 * (1 - Math.exp(-1))) < 1e-6);
  // dt = Infinity (reduced motion) jumps straight there.
  const c3 = { x: 0, y: 0, scale: 0.01 }, g3 = { x: 50, y: 60, scale: 0.5, ax: null, ay: null };
  assert.equal(stepCamera(c3, g3, Infinity, vw, vh), false);
  assert.deepEqual([c3.x, c3.y, c3.scale], [g3.x, g3.y, g3.scale]);
});

test("tilePaths: ground floor keeps its cache layout, other floors get their own layer", () => {
  const { cfg } = setup({ TILES_ROOT: "https://host" });
  assert.deepEqual(tilePaths(cfg, 0, 15, "3_2.jpg"), { rel: "42.20.0/15/3_2.jpg", upstream: "https://host/42.20.0/base/layer0_files/15/3_2.jpg" });
  assert.deepEqual(tilePaths(cfg, 2, 15, "3_2.jpg"), { rel: "42.20.0/f2/15/3_2.jpg", upstream: "https://host/42.20.0/base/layer2_files/15/3_2.jpg" });
  assert.equal(tilePaths(cfg, -1, 15, "3_2.jpg").upstream, "https://host/42.20.0/base/layer-1_files/15/3_2.jpg");
});

test("floor helpers clamp to -1..7, label floors and read the URL", () => {
  assert.deepEqual([clampFloor(-5), clampFloor(0), clampFloor(3.4), clampFloor(99), clampFloor("x"), clampFloor(undefined)], [-1, 0, 3, 7, 0, 0]);
  assert.deepEqual([floorLabel(0), floorLabel(3), floorLabel(-1)], ["G", "F3", "B1"]);
  assert.equal(parseFloor("?x=1&floor=2"), 2);
  assert.equal(parseFloor("?floor=40"), 7);
  assert.equal(parseFloor("?floor=abc"), 0);
  assert.equal(parseFloor("?x=1"), 0);
});

test("town labels: unique names with positions that land on the rendered map", () => {
  assert.ok(TOWNS.length >= 10);
  assert.equal(new Set(TOWNS.map((t) => t.name)).size, TOWNS.length);
  for (const t of TOWNS) {
    assert.ok(t.name && Number.isFinite(t.x) && Number.isFinite(t.y), t.name);
    const d = gameToDzi(t.x, t.y, MAP);
    assert.ok(d.x > 0 && d.x < MAP.fullWidth && d.y > 0 && d.y < MAP.fullHeight, `${t.name} is inside the map image`);
  }
});

test("parseView reads shareable URL params", () => {
  const m = MAP;
  assert.deepEqual(parseView("?x=10000&y=9000&zoom=13", m), { x: 10000, y: 9000, zoom: 13 });
  assert.equal(parseView("?zoom=3", m), null);
  assert.equal(MIN_ZOOM, 12.1);
  assert.equal(parseView("?x=1&y=2&zoom=3", m).zoom, MIN_ZOOM, "zooming out past 12.1 is clamped");
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
  assert.deepEqual(fresh.players, [{ name: "Bob", x: 10, y: 20, z: 0, hp: null, car: null }]);
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [{ name: "A", x: 1, y: 2, car: true }, { name: "B", x: 1, y: 2, car: false }, { name: "C", x: 1, y: 2, car: "yes" }] }));
  assert.deepEqual(readPlayers(cfg).players.map((p) => p.car), [true, false, null], "only booleans pass for the vehicle flag");
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [{ name: "A", x: 1, y: 2, hp: 87 }, { name: "B", x: 1, y: 2, hp: 250 }, { name: "C", x: 1, y: 2, hp: "x" }] }));
  assert.deepEqual(readPlayers(cfg).players.map((p) => p.hp), [87, 100, null], "health is clamped to 0-100, junk becomes null");
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

test("the page links its icons and the server serves them as PNGs", async () => {
  const { cfg } = setup();
  const server = createServer(cfg);
  const base = await listen(server);
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<link rel="icon"[^>]*href="favicon\.png"/);
    assert.match(html, /<link rel="apple-touch-icon"[^>]*href="apple-touch-icon\.png"/);
    for (const f of ["favicon.png", "apple-touch-icon.png"]) {
      const res = await fetch(`${base}/${f}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47], "a real PNG");
    }
  } finally {
    server.close();
  }
});

test("readServerName prefers PublicName from the ini and falls back to SERVER_NAME", () => {
  const { cfg, dataPath } = setup();
  const fallback = readServerName(cfg);
  assert.equal(fallback, cfg.serverName, "no ini: the configured name");
  fs.mkdirSync(path.join(dataPath, "Server"), { recursive: true });
  const ini = path.join(dataPath, "Server", `${cfg.serverIni}.ini`);
  fs.writeFileSync(ini, "RCONPassword=secret\r\nPublicName=My Cool Server \r\nPublicDescription=x\r\n");
  assert.equal(readServerName(cfg), "My Cool Server");
  fs.writeFileSync(ini, "PublicName=\n");
  assert.equal(readServerName(cfg), cfg.serverName, "empty name: the configured name");
});

test("readPlayers returns a sanitised game time, hidden when the file is stale", () => {
  const { cfg, dataPath } = setup();
  const file = path.join(dataPath, "Lua", "zmap_players.txt");
  fs.writeFileSync(file, JSON.stringify({ t: 1, time: { y: 1993, mo: 7, d: 9, h: 14, mi: 5 }, players: [] }));
  assert.deepEqual(readPlayers(cfg).gameTime, { y: 1993, mo: 7, d: 9, h: 14, mi: 5 });
  assert.equal(readPlayers(cfg, Date.now() + 60_000).gameTime, null);
  assert.equal(cleanGameTime({ y: 1993, mo: 13, d: 9, h: 14, mi: 5 }), null);
  assert.equal(cleanGameTime({ y: "1993", mo: 7, d: 9, h: 14, mi: 5 }), null);
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [] }));
  assert.equal(readPlayers(cfg).gameTime, null, "an older mod writes no time");
});

test("readBuildInfo reads the console version and compares only the major build with the map", () => {
  const { cfg, dataPath } = setup();
  assert.deepEqual(readBuildInfo(cfg), { version: null, supported: null });
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=42.21.0 4a0e9546ec demo=false\nmore");
  assert.deepEqual(readBuildInfo(cfg), { version: "42.21.0", supported: true }, "42.21.0 against the 42.20.0 map is fine");
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=43.0.1");
  assert.equal(readBuildInfo(cfg).supported, false);
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "version=41.78.16");
  assert.equal(readBuildInfo(cfg).supported, false);
  fs.writeFileSync(path.join(dataPath, "server-console.txt"), "-----\nlog started\nversion=42.21.0 4a0e9546ec demo=false\n");
  assert.equal(readBuildInfo(cfg).version, "42.21.0", "version need not be on the first line");
});

test("tile cache evicts the oldest tiles when it is over its limit", () => {
  const { cfg } = setup();
  cfg.tileCacheMaxBytes = 25;
  cacheTile(cfg, "42.20.0/1/0_0.jpg", Buffer.alloc(10));
  cacheTile(cfg, "42.20.0/1/0_1.jpg", Buffer.alloc(10));
  cacheTile(cfg, "42.20.0/1/1_0.jpg", Buffer.alloc(10));
  assert.equal(readCachedTile(cfg, "42.20.0/1/0_0.jpg"), null);
  assert.ok(readCachedTile(cfg, "42.20.0/1/1_0.jpg"));
});

// A fake tiles host: one real 42.20.0 tile, 404 for the rest.
function fakeTilesHost(hits) {
  return http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/42.20.0/base/layer0_files/15/3_2.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end("JPEGDATA");
    } else if (req.url === "/42.20.0/base/layer2_files/15/3_2.jpg" || req.url === "/42.20.0/base/layer-1_files/15/3_2.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end(req.url.includes("layer2") ? "FLOOR2" : "BASEMENT");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
}

test("prefetch downloads every rendered cell once and skips cached ones", async () => {
  const hits = [];
  const host = http.createServer((req, res) => {
    hits.push(req.url);
    if (/^\/42\.20\.0\/base\/layer0_files\/1[0-2]\/0_0\.jpg$/.test(req.url)) res.end("JPEG");
    else { res.statusCode = 404; res.end("nope"); }
  });
  const hostUrl = await listen(host);
  const { cfg } = setup({ TILES_ROOT: hostUrl });
  try {
    const totals = await prefetch(cfg, 12, () => {});
    assert.equal(totals.fetched, 3);
    assert.equal(totals.failed, 0);
    assert.ok(totals.empty >= 1);
    assert.equal(readCachedTile(cfg, "42.20.0/12/0_0.jpg").toString(), "JPEG");
    const before = hits.length;
    const again = await prefetch(cfg, 12, () => {});
    assert.equal(again.fetched, 0);
    assert.equal(again.cached, 3);
    assert.ok(hits.slice(before).every((u) => !/layer0_files\/1[0-2]\/0_0\.jpg$/.test(u)), "cached tiles are not requested again");
  } finally {
    host.close();
  }
});

test("prefetch: floors come from their own upstream layer and cache entries", async () => {
  const hits = [];
  const host = http.createServer((req, res) => {
    hits.push(req.url);
    if (/^\/42\.20\.0\/base\/layer(0|2|-1)_files\/12\/0_0\.jpg$/.test(req.url)) res.end(`T${req.url.match(/layer(-?\d)/)[1]}`);
    else { res.statusCode = 404; res.end("nope"); }
  });
  const hostUrl = await listen(host);
  const { cfg } = setup({ TILES_ROOT: hostUrl });
  try {
    const totals = await prefetch(cfg, 12, () => {}, [0, 2, -1, 5]);
    assert.equal(totals.fetched, 3);
    assert.equal(totals.failed, 0);
    assert.equal(readCachedTile(cfg, "42.20.0/12/0_0.jpg").toString(), "T0");
    assert.equal(readCachedTile(cfg, "42.20.0/f2/12/0_0.jpg").toString(), "T2");
    assert.equal(readCachedTile(cfg, "42.20.0/f-1/12/0_0.jpg").toString(), "T-1");
    assert.equal(readCachedTile(cfg, "42.20.0/f5/12/0_0.jpg"), null, "nothing rendered on floor 5");
  } finally {
    host.close();
  }
});

test("parseFloors: default is ground only, all is every floor, junk is rejected", () => {
  assert.deepEqual(parseFloors(undefined), [0]);
  assert.deepEqual(parseFloors("all"), [0, -1, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseFloors("2, 0,2,-1"), [2, 0, -1]);
  for (const bad of ["8", "-2", "x", "1.5", ""]) assert.throws(() => parseFloors(bad), /floors must be/, bad);
});

test("server: meta, players and tiles; 404 tiles stay empty and are not re-requested", async () => {
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
    assert.equal(meta.map.dir, "42.20.0");
    assert.equal(meta.mapSource, undefined, "no discovery fields any more");
    assert.equal(meta.app.version, readVersion().version);
    assert.equal(meta.map.tileSize, 2048);
    assert.equal(meta.map.isoX0, 1040384);
    assert.equal(meta.build.supported, true);

    const players = await (await fetch(`${base}/api/players`)).json();
    assert.equal(players.players[0].name, "A");

    const ok = await fetch(`${base}/tiles/15/3_2.jpg`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "JPEGDATA");
    assert.equal((await fetch(`${base}/tiles/15/3_2.jpg`)).headers.get("x-tile-cache"), "hit");
    assert.equal((await fetch(`${base}/tiles/15/3_2.jpg?v=42.20.0-2048`)).status, 200, "the cache-busting query is ignored");

    const before = hits.length;
    assert.equal((await fetch(`${base}/tiles/15/9_9.jpg`)).status, 404);
    const afterFirst = hits.length;
    assert.ok(afterFirst > before);
    assert.equal((await fetch(`${base}/tiles/15/9_9.jpg`)).status, 404);
    assert.equal(hits.length, afterFirst, "second request for an empty tile must not reach the host");

    // Other floors: separate upstream layer and separate cache entry; floor 0 is unchanged.
    const f2 = await fetch(`${base}/tiles/f2/15/3_2.jpg`);
    assert.equal(await f2.text(), "FLOOR2");
    assert.equal((await fetch(`${base}/tiles/f2/15/3_2.jpg`)).headers.get("x-tile-cache"), "hit");
    assert.equal(await (await fetch(`${base}/tiles/f-1/15/3_2.jpg`)).text(), "BASEMENT");
    assert.equal(await (await fetch(`${base}/tiles/15/3_2.jpg`)).text(), "JPEGDATA", "the ground floor is not mixed up with the others");
    assert.equal((await fetch(`${base}/tiles/f3/15/3_2.jpg`)).status, 404, "a floor with nothing rendered is empty");
    assert.equal((await fetch(`${base}/tiles/f9/15/3_2.jpg`)).status, 400, "floors above 7 are rejected");
    assert.equal((await fetch(`${base}/tiles/f-2/15/3_2.jpg`)).status, 400, "and below -1");

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


test("readPlayers: deaths are remembered until the same name is alive again", () => {
  const { cfg, dataPath } = setup();
  cfg.stateFile = path.join(dataPath, "dead.json");
  const file = path.join(dataPath, "Lua", "zmap_players.txt");
  const write = (o) => fs.writeFileSync(file, JSON.stringify({ t: 1, ...o }));
  write({ players: [], dead: [{ name: "Bob", x: 10, y: 20, z: 1 }, { name: 5 }, { name: "Eve", x: "no", y: 1 }] });
  let r = readPlayers(cfg);
  assert.deepEqual(r.dead.map((d) => [d.name, d.x, d.y, d.z]), [["Bob", 10, 20, 1]], "junk entries are dropped");
  write({ players: [], dead: [] });
  assert.equal(readPlayers(cfg).dead.length, 1, "the mod forgetting a death doesn't clear it");
  assert.equal(readPlayers(cfg, Date.now() + 60_000).dead.length, 1, "kept while the file is stale");
  assert.equal(JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"))[0].name, "Bob", "saved to disk");
  write({ players: [{ name: "Bob", x: 1, y: 1, z: 0 }], dead: [] });
  assert.deepEqual(readPlayers(cfg).dead, [], "alive again clears the marker");
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")), []);
});

test("readPlayers: dead markers expire after DEAD_KEEP_HOURS and survive a restart", () => {
  const { cfg, dataPath } = setup();
  cfg.stateFile = path.join(dataPath, "dead.json");
  cfg.deadKeepHours = 1;
  const file = path.join(dataPath, "Lua", "zmap_players.txt");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ t: 1, players: [], dead: [{ name: "Bob", x: 1, y: 2, z: 0 }] }));
  assert.equal(readPlayers(cfg, now).dead.length, 1);
  assert.equal(readPlayers({ ...cfg, stateFile: cfg.stateFile }, now + 30 * 60_000).dead.length, 1);
  fs.utimesSync(file, new Date(now + 2 * 3600_000), new Date(now + 2 * 3600_000));
  assert.deepEqual(readPlayers(cfg, now + 2 * 3600_000).dead, [], "expired");
  assert.deepEqual(cleanDead("x"), []);
});
