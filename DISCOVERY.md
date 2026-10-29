# Design notes

Why the pieces look the way they do. Verified on a Build 42.21.0 dedicated server on Linux.

## Player and safehouse data
- Live coordinates only come from inside the game, so a small server-side Lua mod (`mod/ZMapPositions`) writes `<Zomboid data>/Lua/zmap_players.txt` every 1 s: online players (`getOnlinePlayers()`), the safehouse list (`SafeHouse.getSafehouseList()`), where players died (`dead`, noticed through `isDead()` and `Events.OnPlayerDeath`; not confirmed which of the two fires on a Build 42 server), whether `PauseEmpty` has frozen the world (`paused`, inferred from the world age not advancing), the in-game clock and the `SHOW_POIS` flag. `server.js` reads and serves it. RCON gives names only, logs give no coordinates, and save files are not live.
- Build 42 `getFileWriter` accepts `.txt` but rejects `.json`, and Lua cannot create folders, so the JSON document lives in a `.txt` in `Lua/`.
- With `PauseEmpty=true` the world tick stops when nobody is online, so the mod hooks `Events.OnTickEvenPaused`.
- A local mod needs the Build 42 layout (`42/mod.info`, `42/media/...`, an empty `common/`).
- Install: a mod listed in `Mods=` that is not on the Workshop makes clients fail with `Mod "ZMapPositions" is not installed`. So the Lua file is copied loose into `<install>/media/lua/server/` with `DoLuaChecksum=false`. Publishing to the Workshop (`WorkshopItems=` plus `Mods=`) would remove both workarounds.

## Map tiles
- Tiles are Deep Zoom images from `https://tiles.pzmap.org/<version>/base/layer0_files/<level>/<col>_<row>.jpg`. The newest published build is 42.20.0; the world is the same for the server's 42.21.0. The host blocks `layer0.dzi` and `map_info.json` from servers (Cloudflare), so the layout is a constant in `server.js`.
- Projection: `imageX = (x0 + (gx - gy) * sqr / 2) / 2^skip`, `imageY = (y0 + (gx + gy) * sqr / 4) / 2^skip`. For 42.20.0: 2048 px tiles, 2318656 x 1019040, x0 1040384, y0 -139296, sqr 128, skip 0.
- Tiles on the right and bottom edge of a level are smaller than the tile size, so a bitmap covers only its real share of its cell. Drawing them stretched, or cropping stand-ins by the bitmap size, shifts the terrain away from the player markers.
- The host only has tiles where something is rendered. A 404 means an empty area: nothing is drawn there, and no coarser tile is used (it would give blurry patches).
- Tile URLs carry `?v=<dir>-<tileSize>` because tiles are cached for 24 h by browsers and CDNs; stale tiles from another layout mixed with correct ones.
- The tiles are third-party imagery fetched at runtime, cached on disk and never committed. Respect the host's terms and keep the cache warm (`prefetch.js`) rather than pointing many public clients at it. Generating tiles from the game files is not practical: it needs an offline renderer and the full game data.

## Game version
`version=` near the top of `server-console.txt`. Only the major build is compared with the map's, so 42.21.0 against 42.20.0 tiles is fine.

## Linux
`PZ_DATA_PATH` is the only game path needed (`/srv/zomboid-server/Zomboid` in the examples). The service user is added to the `zomboid` group to read it.
