# Zomboid Live Map

A small read-only web map showing connected players on a Project Zomboid **Build 42** dedicated server. Zero npm dependencies: one Node file, a vanilla JS canvas client and a tiny server-side Lua mod. Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel), see [CHANGES.md](CHANGES.md) and [DISCOVERY.md](DISCOVERY.md).

How it works: the mod writes online players to `<Zomboid data>/Lua/zmap_players.txt` every 2 s (Build 42 only lets mods write `.txt` files, so the JSON lives in a `.txt`); `server.js` serves that file, discovers the matching map build on `tiles.pzmap.org` from the running game version, proxies and caches the tiles, and serves the page.

## Requirements
- Node.js 20 or newer (Ubuntu's apt Node is often older: use NodeSource or nvm).
- `curl` (present on Ubuntu). Used to read the map descriptors, because Cloudflare in front of the tile host can challenge Node's TLS stack.
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
| Yellow/red banner about the map | Descriptors for your game version could not be fetched, so the 42.20.0 layout is used and markers may be slightly off | `curl -sI https://tiles.pzmap.org/<version>/base/layer0.dzi`; set `MAP_DIR` in `/etc/zmap.env` to force a build directory |

The banner about the map layout is informational: the host publishes tiles up to 42.20.0 and blocks the descriptor files for newer versions, so the built-in 42.20.0 layout is used. Close it once and it stays closed in that browser.

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
```
It skips tiles that are already cached, so it is safe to re-run (for example after a game update clears the cache). Level 17 and below covers the whole-world and town views (URL `zoom` 17 and below); deeper levels are still fetched on demand. While a tile loads, a blurrier stand-in from a coarser level is shown, so a warm cache also removes that.

Generating tiles from the game files instead is not practical: the map art on the tile host comes from rendering the game's lot files and texture packs with an offline tool, which needs the full game data and takes hours. The game's own world map (`worldmap.xml.bin`) is a vector map with a different look and would need its own renderer, so it is not supported here.

## Update
`sudo -u zmap git -C /srv/zomboid-map pull && sudo systemctl restart zmap`

The map service reads whatever the mod writes, but the mod itself is a copy on the game server. When a release changes the mod (the safehouse outlines need the 1.2 mod), re-copy it and restart the game server once (check nobody is online first), as in the install step:
```
sudo -u zomboid bash -c 'umask 0002; cp /srv/zomboid-map/mod/ZMapPositions/42/media/lua/server/ZMapPositions.lua /srv/zomboid-server/media/lua/server/'
sudo systemctl restart zomboid
```
Without it the map keeps working, just without safehouses.

Run git as the `zmap` user, who owns the checkout. Plain `sudo git pull` runs as root and git refuses with `detected dubious ownership`. (If you cloned as another user, `sudo git config --global --add safe.directory /srv/zomboid-map` also works.)

## Configuration
All via environment variables in `/etc/zmap.env`, see [deploy/zmap.env.example](deploy/zmap.env.example). Default port 8780 on loopback; change `PORT` if something else on the host uses it.

## Using the map
- Drag to pan, wheel or pinch to zoom, tap a player in the list to centre on them. The bottom corner shows the world coordinate under the cursor.
- Each online player gets their own marker colour (shown in the player list too). The colour comes from the name, so a player keeps theirs between sessions; if two players online would clash, the later name alphabetically takes the next free colour.
- Safehouses: each claimed safehouse is outlined in its owner's colour, labelled with the owner when zoomed in, and listed in the panel with its members (click to centre). Use the checkbox in the panel to hide the outlines; the choice is remembered in the browser. Their locations are visible to anyone who can open the map.
- Update interval: the mod writes positions every 2 s and the page polls every `REFRESH_SECONDS` (default 5 s), so a marker is at most about 7 s behind the game.
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
