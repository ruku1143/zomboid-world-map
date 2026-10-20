# Zomboid Live Map

A small read-only web map showing connected players on a Project Zomboid **Build 41** dedicated server. Zero npm dependencies: one Node file, a vanilla JS canvas client and a tiny server-side Lua mod. Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel), see [CHANGES.md](CHANGES.md) and [DISCOVERY.md](DISCOVERY.md).

How it works: the mod writes online players to `<Zomboid data>/Lua/zmap_players.json` every 2 s; `server.js` serves that file, proxies and caches map tiles from `tiles.pzmap.org`, and serves the page.

## Requirements
- Node.js 20 or newer (Ubuntu's apt Node is often older: use NodeSource or nvm).
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
