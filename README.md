# Zomboid Live Map

A small read-only web map showing connected players on a Project Zomboid **Build 42** dedicated server. Zero npm dependencies: one Node file, a vanilla JS canvas client and a tiny server-side Lua mod. Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel), see [CHANGES.md](CHANGES.md) and [DISCOVERY.md](DISCOVERY.md).

How it works: the mod writes online players to `<Zomboid data>/Lua/zmap_players.txt` every 1 s (Build 42 only lets mods write `.txt` files, so the JSON lives in a `.txt`); `server.js` serves that file, proxies and caches the map tiles from `tiles.pzmap.org` (the 42.20.0 render, the newest published), and serves the page.

## Requirements
- Node.js 20 or newer (Ubuntu's apt Node is often older: use NodeSource or nvm).
- `curl` (present on Ubuntu). Used as a fallback when fetching tiles, because Cloudflare in front of the tile host can challenge Node's TLS stack.
- Outbound HTTPS to `tiles.pzmap.org` (tiles are cached on disk after the first view).
- Optional: `cloudflared` for public access, see [deploy/cloudflared.md](deploy/cloudflared.md).

## Install (Ubuntu example)
The commands below assume the PZ server is installed in `/srv/zomboid-server`, runs as user `zomboid` under systemd as `zomboid.service` (data in `/srv/zomboid-server/Zomboid`, server name `pzserver`), and that the map lives in `/srv/zomboid-map`. Adjust the paths, user and service names to match your setup.

1. Service user and code:
   ```
   sudo useradd -r -M -s /usr/sbin/nologin -d /srv/zomboid-map zmap
   sudo usermod -aG zomboid zmap          # read access to the PZ data
   sudo usermod -aG zmap "$USER"          # optional: edit the map files without sudo (re-login to apply)
   sudo git clone https://github.com/ruku1143/zomboid-world-map /srv/zomboid-map
   sudo chown -R zmap:zmap /srv/zomboid-map
   sudo chmod -R g+rwX /srv/zomboid-map
   sudo find /srv/zomboid-map -type d -exec chmod g+s {} +
   ```
2. Install the script. It is not on the Steam Workshop, so do **not** list it in `Mods=`: the server would then require every client to have the mod and they get `Mod "ZMapPositions" is not installed`. Load it as a loose server file instead (as `zomboid`, with umask 0002):
   ```
   sudo -u zomboid bash -c 'umask 0002; mkdir -p /srv/zomboid-server/media/lua/server && cp /srv/zomboid-map/mod/ZMapPositions/42/media/lua/server/ZMapPositions.lua /srv/zomboid-server/media/lua/server/'
   ```
   Back up the config, then in `/srv/zomboid-server/Zomboid/Server/pzserver.ini` make sure `ZMapPositions` is **not** in `Mods=` and set `DoLuaChecksum=false` (the server's Lua checksum check would otherwise reject the extra file; this loosens that check slightly):
   ```
   cp /srv/zomboid-server/Zomboid/Server/pzserver.ini /srv/zomboid-server/Zomboid/Server/pzserver.ini.bak.$(date +%F-%H%M)
   ```
   A game update can overwrite `media/lua/server/`: re-copy the file if the map goes quiet after one.

   Privacy options are at the top of `ZMapPositions.lua` (`SHOW_HEALTH`, `SHOW_GAME_TIME`, `SHOW_IN_VEHICLE`, `HIDE_INVISIBLE_ADMINS`, `SHOW_DEATHS`, `SHOW_POIS`, all `true` by default). Set one to `false` in the installed copy and restart the game server to stop sharing it. `SHOW_POIS` is different: it shares nothing about players, it just switches the points-of-interest layer on or off for everyone who opens the map. `SHOW_DEATHS` keeps a greyed-out marker where a player died until the same username is alive again; the web server remembers it in `dead-players.json` (`STATE_FILE`), and `DEAD_KEEP_HOURS` (default `0`, never) removes old markers.

3. Config: `sudo cp /srv/zomboid-map/deploy/zmap.env.example /etc/zmap.env`, edit `SERVER_NAME`, then `sudo chown root:zmap /etc/zmap.env && sudo chmod 640 /etc/zmap.env`. The default paths already match this layout.
4. Run the map service:
   ```
   sudo cp /srv/zomboid-map/deploy/zmap.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now zmap
   ```
5. Restart the PZ server once so it loads the mod. Check nobody is online first: `echo "players" > /srv/zomboid-server/zomboid.control` then `journalctl -u zomboid -n 20`. Then `sudo systemctl restart zomboid` (saves first).
6. Check: `ls -l /srv/zomboid-server/Zomboid/Lua/zmap_players.txt` and `curl -s http://127.0.0.1:8780/api/players`.

The `zmap` service sandbox (`ProtectSystem=strict`) can only write to `/var/cache/zmap`, even though its user is in the `zomboid` group, so it cannot modify the game server.

**Publishing to the Workshop instead:** `mod/ZMapPositions` is already in the Build 42 mod layout. Once uploaded, add its Workshop ID to `WorkshopItems=` and `ZMapPositions` to `Mods=`; clients then download it automatically on connect, and `DoLuaChecksum` can stay `true`.

## Troubleshooting
| Page says | Meaning | Check |
|---|---|---|
| "Positions file not found. Is the ZMapPositions mod loaded?" | `Lua/zmap_players.txt` does not exist | `journalctl -u zomboid \| grep -i zmap`: expect `[ZMapPositions] loaded`. check that the script is in `<install>/media/lua/server/` and the server was restarted after copying it |
| "No update for Ns. The server may be stopped." | The file exists but stopped refreshing | Is `zomboid` running? Look for `[ZMapPositions] write failed:` in the journal |
| "Nobody is online." | All good, the mod is writing an empty list | |
| Red banner "Game version X is a different build than the map" | The server runs a different major build (for example 43) than the map's (42) | See "When a new game build is published" below |

The map is the 42.20.0 render while the server may run a newer 42.x (for example 42.21.0). Only a change of the major number triggers the banner above.

Tiles that the host has not rendered (the large black areas around the island) are expected: the map shows nothing there.

## Uninstall
Same example paths as the install. Adjust to your setup.

1. Remove the map service:
   ```
   sudo systemctl disable --now zmap
   sudo rm /etc/systemd/system/zmap.service /etc/zmap.env
   sudo systemctl daemon-reload
   sudo rm -rf /srv/zomboid-map /var/cache/zmap
   sudo userdel zmap
   ```
   If you exposed it with `cloudflared` or a reverse proxy, remove that tunnel/route and any Cloudflare Access policy too (see [deploy/cloudflared.md](deploy/cloudflared.md)).
2. Clean up the game server (check nobody is online first):
   ```
   sudo systemctl stop zomboid
   sudo rm -f /srv/zomboid-server/media/lua/server/ZMapPositions.lua
   sudo rm -rf /srv/zomboid-server/Zomboid/mods/ZMapPositions
   sudo rm -f /srv/zomboid-server/Zomboid/Lua/zmap_players.txt
   ```
   In `/srv/zomboid-server/Zomboid/Server/pzserver.ini`: remove `ZMapPositions` from `Mods=` if it is there, and set `DoLuaChecksum=true` again (the default) unless you disabled it for another reason. Then `sudo systemctl start zomboid`.
3. Optional: delete the `pzserver.ini.bak.*` backups.
4. Check: `journalctl -u zomboid | grep -i zmap` shows nothing new after the restart, and clients connect with no mod prompts.

## Tiles and local cache
Tiles are fetched from `tiles.pzmap.org` the first time they are viewed and then served from the disk cache (`TILE_CACHE_DIR`, 1 GB by default). To take the tile host out of the picture for normal use, warm the cache once:
```
sudo -u zmap bash -c 'set -a; . /etc/zmap.env; node /srv/zomboid-map/prefetch.js'      # levels 0-17, about 150 MB
sudo -u zmap bash -c 'set -a; . /etc/zmap.env; node /srv/zomboid-map/prefetch.js 18'   # about 0.5 GB total, also raise TILE_CACHE_MAX_MB
sudo -u zmap bash -c 'set -a; . /etc/zmap.env; node /srv/zomboid-map/prefetch.js 17 --floors=all'   # every floor, basement to floor 7
```
By default only the ground floor is cached. `--floors=all` also caches the basement and floors 1 to 7, or give a list such as `--floors=0,1,2`. Each extra floor adds up to about the ground floor's size at the same level, so raise `TILE_CACHE_MAX_MB` to match (the cache evicts the least recently used tiles once it is full). Floors you don't prefetch are still cached the first time someone views them.
It skips tiles that are already cached, so it is safe to re-run (for example after a game update clears the cache). Level 17 and below covers the whole-world and town views (URL `zoom` 17 and below); deeper levels are still fetched on demand. While a tile loads, a blurrier stand-in from a coarser level is shown, so a warm cache also removes that.

Generating tiles from the game files instead is not practical: the map art on the tile host comes from rendering the game's lot files and texture packs with an offline tool, which needs the full game data and takes hours. The game's own world map (`worldmap.xml.bin`) is a vector map with a different look and would need its own renderer, so it is not supported here.

## When a new game build is published
The map layout (tile size, image size and projection origin) is one constant, `MAP` in `server.js`. The tile host blocks the files that describe it from servers, so it is copied by hand. When a new build such as 43.0.0 gets tiles on `tiles.pzmap.org`:
1. Check the host has tiles: open `https://tiles.pzmap.org/<version>/base/layer0_files/12/0_0.jpg` in a browser.
2. Open `https://tiles.pzmap.org/<version>/base/layer0.dzi` and `.../map_info.json` in a browser. Copy `TileSize`, `Width`, `Height` from the first and `x0`, `y0`, `sqr`, `skip` from the second into the `mapFromDescriptors(...)` call for `MAP` (the directory name is the first argument; `scale` is `2 ** skip`).
3. Pull, restart `zmap`, run `prefetch.js`, and check a player's dot lines up with the terrain.

## Update
`sudo -u zmap git -C /srv/zomboid-map pull && sudo systemctl restart zmap`

The map service reads whatever the mod writes, but the mod itself is a copy on the game server. When a release changes the mod (safehouse outlines, death markers, the Paused state and the `SHOW_POIS` switch all come from the mod), re-copy it and restart the game server once (check nobody is online first), as in the install step:
```
sudo -u zomboid bash -c 'umask 0002; cp /srv/zomboid-map/mod/ZMapPositions/42/media/lua/server/ZMapPositions.lua /srv/zomboid-server/media/lua/server/'
sudo systemctl restart zomboid
```
Without it the map keeps working, just without whatever the old mod doesn't write (safehouses, death markers, Paused, the POI switch).

Run git as the `zmap` user, who owns the checkout. Plain `sudo git pull` runs as root and git refuses with `detected dubious ownership`. (If you cloned as another user, `sudo git config --global --add safe.directory /srv/zomboid-map` also works.)

## Configuration
All via environment variables in `/etc/zmap.env`, see [deploy/zmap.env.example](deploy/zmap.env.example). Default port 8780 on loopback; change `PORT` if something else on the host uses it.

## Using the map
- Drag to pan, wheel or pinch to zoom, tap a player in the list to centre on them. The bottom corner shows the world coordinate under the cursor.
- Each online player gets their own marker colour (shown in the player list too). The colour comes from the name, so a player keeps theirs between sessions; if two players online would clash, the later name alphabetically takes the next free colour.
- Safehouses: each claimed safehouse is outlined in its owner's colour, labelled with the owner when zoomed in, and listed in the panel with its members (click to centre). Use the checkbox in the panel to hide the outlines; the choice is remembered in the browser. Their locations are visible to anyone who can open the map.
- Floors: the buttons at the top left switch between the basement (`B1`), the ground floor (`G`) and floors 1 to 7 (`F1` to `F7`), which load that floor's tiles from the tile host. Click the middle button to jump back to ground. Players on another floor are drawn faded and tagged in the list (`F2`, `B1`); clicking one switches to their floor. The floor is part of the shared URL (`&floor=2`). Upper floors only have tiles where the host rendered something.
- Points of interest: about 800 named buildings (shops, gas stations, medical, police, fire, military, civic and more) as coloured dots that fade in as the town names fade out, with names when zoomed in close. The panel has a "Show on map" checkbox and one chip per category ("Other" starts off); both are remembered in the browser. The list is the static `public/pois.js` (credits in `CHANGES.md`). Set `SHOW_POIS = false` in the installed mod to hide the layer and its panel section for everyone (needs a game-server restart); an older mod without the flag still shows it.
- Town names: shown when zoomed out and fading away as you zoom in. Untick "Town names" in the panel to hide them (remembered in the browser). The list is in `public/towns.js`.
- Paused: with `PauseEmpty` on, the mod keeps writing while the world is frozen and reports `paused`; the page shows a blue **Paused** pill. An older mod without the field falls back to "nobody online and the in-game clock stuck for 30 s", which needs `SHOW_GAME_TIME`.
- Update interval: the mod writes positions every 1 s and the page polls every `REFRESH_SECONDS` (default 5 s; the example env file sets 1), so a marker is at most about 2 s behind the game with `REFRESH_SECONDS=1`, about 6 s with the default.
- Share a view: `/?x=10800&y=10000&zoom=14` (`zoom` is the Deep Zoom level, 12.1 to 22; zooming out further is blocked).
- If the server stops or the mod stops writing for 3 intervals, the map shows nobody online and an offline notice.

## Security
No login in the app. The page shows live player names and locations, so do not expose it directly. Use Cloudflare Access, or an nginx/Caddy basic-auth, and keep `BIND_ADDR=127.0.0.1`. The service runs as an unprivileged user with a read-only filesystem except the tile cache, and cannot affect the game server.

## Tests
`npm test` (Node's built-in runner, no install step).

## Tile source note
Map tiles are third-party images served by `tiles.pzmap.org`. This project fetches them on demand, caches them on disk and sends a descriptive User-Agent, but does not ship them. It is not affiliated with that site or with The Indie Stone, and Project Zomboid is a trademark of its owners. Respect the tile host's terms, and do not point many public clients at it without caching.

## License
MIT, see [LICENSE](LICENSE). Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel); the upstream history is kept.
