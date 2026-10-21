# Discovery findings

> **Correction after install:** the server is **Build 42.21.0**, not Build 41 as the original scope said (`server-console.txt`: `version=42.21.0`). The B41-specific choices below were replaced: the mod uses the B42 layout, tiles and projection come from the B42 build directory resolved at runtime, and the position file is a `.txt`. Sections 1 and 2 describe the current design; older B41 details are noted where they applied.

Findings from reading the upstream project (`fpsacha/zomboid-control-panel`, still in this repo's git history) before building. File references point at the upstream tree at the fork point.

## 1. Player positions source

**Chosen: a small server-side Lua mod (`mod/ZMapPositions`) that writes `Lua/zmap_players.txt` (JSON content); the web app reads it.**

What upstream does:
- Live coordinates come only from its PanelBridge Lua mod (`PanelBridge.lua`, handler `getServerInfo`, ~line 3301). The mod uses `getOnlinePlayers()` and reports `math.floor(player:getX/Y/Z())`.
- The panel and mod talk through files under `<Zomboid>/Lua/panelbridge/<server>/`. The panel polls it every 3 s.
- RCON `players` returns names only. Log parsing gives no live coordinates. Save files (`players.db`) only hold the last saved position, and are not live.

Why not reuse PanelBridge: about 11k lines with an admin command inbox (teleport, kick, etc.), B42 oriented (the Workshop item is B42 only). Far more than a read-only map needs, and it is a larger attack surface.

Why a mod rather than less invasive options: nothing else gives live coordinates. The mod is write-only to a single file and has no inbox.

Build 42 specifics: `getFileWriter` accepts `.txt` but rejects `.json` (upstream notes this from buildid 24449161), Lua cannot create folders, and a local mod needs a `42/` version folder plus `common/`. With `PauseEmpty=true` the world tick stops when nobody is online, so the mod hooks `Events.OnTickEvenPaused`.

Install: copy `mod/ZMapPositions` into `<Zomboid>/mods/` and add `ZMapPositions` to `Mods=`. Open item to verify on the real server: whether clients object to a mod that is listed in `Mods=` but not on the Workshop. The fallback is a loose file in `<install>/media/lua/server/` (needs `DoLuaChecksum=false`).

## 2. Map tiles source

**Chosen: proxy and disk-cache the Deep Zoom tiles from `tiles.pzmap.org`, same as upstream.**

- Upstream bundles no map images and does not read `media/maps`. Tiles come from `https://tiles.pzmap.org/<build>/base/layer0_files/<level>/<col>_<row>.jpg`, proxied and cached by `server/routes/mapProxy.js` (1 GiB LRU on disk).
- Build 42 uses a per-version directory (`<version>/base/layer0_files/<level>/<col>_<row>.jpg`). The geometry is read at runtime from `<dir>/base/layer0.dzi` (tile size, width, height) and `<dir>/base/map_info.json` (`x0`, `y0`, `sqr`, `skip`). Projection: `imageX = (x0 + (gx - gy) * sqr / 2) / 2^skip`, `imageY = (y0 + (gx + gy) * sqr / 4) / 2^skip`. Candidate directories: `MAP_DIR`, the running game version, then the 42.20.0 fallback (2048 px tiles, 2318656 x 1019040, x0 1040384, y0 -139296, sqr 128, skip 0).
- The host only has tiles where something is rendered. A 404 means an empty area and the client draws nothing there; it must not fall back to a coarser tile there (that produced blurry patches). Verified for 41.78.16: at level 12 only 1 of 3 tiles exists.
- Not verified from the sandbox: the live 42.21.0 descriptors (Cloudflare challenged the probes). The first run on the server shows `map: <dir> (dynamic|fallback)` in `journalctl -u zmap`.
- Licensing: the repo is MIT, but the tiles are third-party imagery of the game's art, fetched at runtime and not redistributed from this repo. Treat it as terms-of-use of the tile host. We send a descriptive User-Agent, cache aggressively to limit load, and do not commit tiles. Generating our own tiles from `media/maps` would avoid the dependency but is a much larger project.

## 3. Build detection

**Chosen: read the Steam `buildid` from the app manifest, and the game version from `server-console.txt`.**

- `steamapps/appmanifest_380870.acf` holds `buildid` and `BetaKey` (upstream `updateChecker.js:168`).
- `server-console.txt` first line holds `version=42.21.0` (upstream `updateChecker.js:135`).
- On a `buildid` change we clear the tile cache. If the version does not start with `42.` the app reports it in `/api/meta` and the UI shows a warning rather than silently showing the wrong map.

## 4. Linux compatibility

- Upstream has no hard Windows-only blocker in the position path, but it auto-detects only `~/Zomboid`, `/opt/pz-server` and similar, not `/srv/zomboid-server`.
- We take both paths from config: `PZ_INSTALL_PATH=/srv/zomboid-server` and `PZ_DATA_PATH=/srv/zomboid-server/Zomboid`. Nothing is auto-detected, nothing is Windows specific.
- The mod writes via PZ's `getFileWriter`, which targets `<Zomboid>/Lua/`. That is the `zomboid` user's home, readable by group `zomboid`, so the `zmap` service user is added to that group.

## 5. Other findings

- Upstream needs no SQL database for its own data. We need none.
- Upstream polls positions rather than pushing them. We do the same.
