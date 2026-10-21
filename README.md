# Zomboid Live Map

A small read-only web map showing connected players on a Project Zomboid **Build 42** dedicated server. Zero npm dependencies: one Node file, a vanilla JS canvas client and a tiny server-side Lua mod. Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel), see [CHANGES.md](CHANGES.md) and [DISCOVERY.md](DISCOVERY.md).

How it works: the mod writes online players to `<Zomboid data>/Lua/zmap_players.txt` every 2 s (Build 42 only lets mods write `.txt` files, so the JSON lives in a `.txt`); `server.js` serves that file, discovers the matching map build on `tiles.pzmap.org` from the running game version, proxies and caches the tiles, and serves the page.

## Requirements
- Node.js 20 or newer (Ubuntu's apt Node is often older: use NodeSource or nvm).
- `curl` (present on Ubuntu). Used to read the map descriptors, because Cloudflare in front of the tile host can challenge Node's TLS stack.
- Outbound HTTPS to `tiles.pzmap.org` (tiles are cached on disk after the first view).
- Optional: `cloudflared` for public access, see [deploy/cloudflared.md](deploy/cloudflared.md).

## Install (Ubuntu, following the `/srv/<game>-server` layout)
Paths assume the PZ server is in `/srv/zomboid-server` (user `zomboid`, data in `/srv/zomboid-server/Zomboid`, server name `pzserver`). Adjust if yours differ.

1. Service user and code (installed in `/srv/zomboid-map`, like the other game servers):
   ```
   sudo useradd -r -M -s /usr/sbin/nologin -d /srv/zomboid-map zmap
   sudo usermod -aG zomboid zmap          # read access to the PZ data
   sudo usermod -aG zmap administrator    # edit the map files without sudo (re-login to apply)
   sudo git clone https://github.com/ruku1143/zomboid-world-map /srv/zomboid-map
   sudo chown -R zmap:zmap /srv/zomboid-map
   sudo chmod -R g+rwX /srv/zomboid-map
   sudo find /srv/zomboid-map -type d -exec chmod g+s {} +
   ```
2. Install the mod (as `zomboid` with umask 0002, so group permissions stay intact):
   ```
   sudo -u zomboid bash -c 'umask 0002; mkdir -p /srv/zomboid-server/Zomboid/mods && cp -r /srv/zomboid-map/mod/ZMapPositions /srv/zomboid-server/Zomboid/mods/'
   ```
   The mod uses the Build 42 layout (`42/mod.info`, `42/media/...`, an empty `common/`). A Build 41-style folder is reported by PZ as `required mod "ZMapPositions" not found`.

   Back up the config, then add `ZMapPositions` to `Mods=` (semicolon separated) in `/srv/zomboid-server/Zomboid/Server/pzserver.ini`:
   ```
   cp /srv/zomboid-server/Zomboid/Server/pzserver.ini /srv/zomboid-server/Zomboid/Server/pzserver.ini.bak.$(date +%F-%H%M)
   ```
3. Config: `sudo cp /srv/zomboid-map/deploy/zmap.env.example /etc/zmap.env`, edit `SERVER_NAME`, then `sudo chown root:zmap /etc/zmap.env && sudo chmod 640 /etc/zmap.env`. The default paths already match this layout.
4. Run the map service:
   ```
   sudo cp /srv/zomboid-map/deploy/zmap.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now zmap
   ```
5. Restart the PZ server once so it loads the mod. Check nobody is online first: `echo "players" > /srv/zomboid-server/zomboid.control` then `journalctl -u zomboid -n 20`. Then `sudo systemctl restart zomboid` (saves first).
6. Check: `ls -l /srv/zomboid-server/Zomboid/Lua/zmap_players.json` and `curl -s http://127.0.0.1:8780/api/players`.

The `zmap` service sandbox (`ProtectSystem=strict`) can only write to `/var/cache/zmap`, even though its user is in the `zomboid` group, so it cannot modify the game server.

**Fallback if clients complain about the mod:** copy `mod/ZMapPositions/media/lua/server/ZMapPositions.lua` to `/srv/zomboid-server/media/lua/server/`, remove the `Mods=` entry, set `DoLuaChecksum=false` in `pzserver.ini`, and restart. Note this loosens the server's Lua checksum check.

## Troubleshooting
| Page says | Meaning | Check |
|---|---|---|
| "Positions file not found. Is the ZMapPositions mod loaded?" | `Lua/zmap_players.txt` does not exist | `journalctl -u zomboid \| grep -i zmap`: expect `[ZMapPositions] loaded`. `required mod ... not found` means a wrong folder layout (needs `42/` and `common/`), or the mod was copied after the last restart |
| "No update for Ns. The server may be stopped." | The file exists but stopped refreshing | Is `zomboid` running? Look for `[ZMapPositions] write failed:` in the journal |
| "Nobody is online." | All good, the mod is writing an empty list | |
| Yellow/red banner about the map | Descriptors for your game version could not be fetched, so the 42.20.0 layout is used and markers may be slightly off | `curl -sI https://tiles.pzmap.org/<version>/base/layer0.dzi`; set `MAP_DIR` in `/etc/zmap.env` to force a build directory |

Tiles that the host has not rendered (the large black areas around the island) are expected: the map shows nothing there.

## Update
`cd /srv/zomboid-map && sudo git pull && sudo systemctl restart zmap`

## Configuration
All via environment variables in `/etc/zmap.env`, see [deploy/zmap.env.example](deploy/zmap.env.example). Default port 8780 on loopback, so it does not clash with Minecraft or BeamMP.

## Using the map
- Drag to pan, wheel or pinch to zoom, tap a player in the list to centre on them. The bottom corner shows the world coordinate under the cursor.
- Share a view: `/?x=10800&y=10000&zoom=14` (`zoom` is the Deep Zoom level, 8 to 22).
- If the server stops or the mod stops writing for 3 intervals, the map shows nobody online and an offline notice.

## Security
No login in the app. The page shows live player names and locations, so do not expose it directly. Use Cloudflare Access, or an nginx/Caddy basic-auth, and keep `BIND_ADDR=127.0.0.1`. The service runs as an unprivileged user with a read-only filesystem except the tile cache, and cannot affect the game server.

## Tests
`npm test` (Node's built-in runner, no install step).

## Tile source note
Tiles are third-party images served by `tiles.pzmap.org`. This project caches them and sends a descriptive User-Agent, but does not ship them. Respect that host's terms.
