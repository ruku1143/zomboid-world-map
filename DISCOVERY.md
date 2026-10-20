# Discovery findings

Findings from reading the upstream project (`fpsacha/zomboid-control-panel`, still in this repo's git history) before building. File references point at the upstream tree at the fork point.

## 1. Player positions source

**Chosen: a small server-side Lua mod (`mod/ZMapPositions`) that writes a JSON file; the web app reads it.**

What upstream does:
- Live coordinates come only from its PanelBridge Lua mod (`PanelBridge.lua`, handler `getServerInfo`, ~line 3301). The mod uses `getOnlinePlayers()` and reports `math.floor(player:getX/Y/Z())`.
- The panel and mod talk through files under `<Zomboid>/Lua/panelbridge/<server>/`. The panel polls it every 3 s.
- RCON `players` returns names only. Log parsing gives no live coordinates. Save files (`players.db`) only hold the last saved position, and are not live.

Why not reuse PanelBridge: about 11k lines with an admin command inbox (teleport, kick, etc.), B42 oriented (the Workshop item is B42 only). Far more than a read-only map needs, and it is a larger attack surface.

Why a mod rather than less invasive options: nothing else gives live coordinates. The mod is write-only to a single file and has no inbox.

Install: copy `mod/ZMapPositions` into `~zomboid/Zomboid/mods/` and add `ZMapPositions` to `Mods=`. Open item to verify on the real server: whether clients object to a mod that is listed in `Mods=` but not on the Workshop. The fallback is a loose file in `<install>/media/lua/server/` (needs `DoLuaChecksum=false`).

## 2. Map tiles source

**Chosen: proxy and disk-cache the Deep Zoom tiles from `tiles.pzmap.org`, same as upstream.**

- Upstream bundles no map images and does not read `media/maps`. Tiles come from `https://tiles.pzmap.org/<build>/base/layer0_files/<level>/<col>_<row>.jpg`, proxied and cached by `server/routes/mapProxy.js` (1 GiB LRU on disk).
- Build 41 uses the fixed directory `41.78.16`. Build 42 uses a discovered directory and several geometry variants. We only support B41.
- Projection (isometric, from `WorldMap.tsx`): `dziX = 1017856 + (gx - gy) * 64`, `dziY = -152000 + (gx + gy) * 32`; image 2285184 x 990400, 1024 px tiles, max level 22.
- Licensing: the repo is MIT, but the tiles are third-party imagery of the game's art, fetched at runtime and not redistributed from this repo. Treat it as terms-of-use of the tile host. We send a descriptive User-Agent, cache aggressively to limit load, and do not commit tiles. Generating our own tiles from `media/maps` would avoid the dependency but is a much larger project.

## 3. Build detection

**Chosen: read the Steam `buildid` from the app manifest, and the game version from `server-console.txt`.**

- `steamapps/appmanifest_380870.acf` holds `buildid` and `BetaKey` (upstream `updateChecker.js:168`).
- `server-console.txt` first line holds `version=41.78.16` (upstream `updateChecker.js:135`).
- On a `buildid` change we clear the tile cache. If the version no longer starts with `41.` the app reports it in `/api/meta` and the UI shows a warning rather than silently showing the wrong map.

## 4. Linux compatibility

- Upstream has no hard Windows-only blocker in the position path, but it auto-detects only `~/Zomboid`, `/opt/pz-server` and similar, not `/srv/zomboid-server`.
- We take both paths from config: `PZ_INSTALL_PATH=/srv/zomboid-server` and `PZ_DATA_PATH=/home/zomboid/Zomboid`. Nothing is auto-detected, nothing is Windows specific.
- The mod writes via PZ's `getFileWriter`, which targets `<Zomboid>/Lua/`. That is the `zomboid` user's home, readable by group `zomboid`, so the `zmap` service user is added to that group.

## 5. Other findings

- Upstream needs no SQL database for its own data. We need none.
- Upstream polls positions rather than pushing them. We do the same.
