# Zomboid Live Map

A small read-only web map showing connected players on a Project Zomboid **Build 41** dedicated server. Zero npm dependencies: one Node file, a vanilla JS canvas client and a tiny server-side Lua mod. Forked from [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel), see [CHANGES.md](CHANGES.md) and [DISCOVERY.md](DISCOVERY.md).

How it works: the mod writes online players to `<Zomboid>/Lua/zmap_players.json` every 2 s; `server.js` serves that file, proxies and caches map tiles from `tiles.pzmap.org`, and serves the page.

## Requirements
- Node.js 20 or newer (Ubuntu's apt Node is often older: use NodeSource or nvm).
- Outbound HTTPS to `tiles.pzmap.org` (tiles are cached on disk after the first view).
- Optional: `cloudflared` for public access, see [deploy/cloudflared.md](deploy/cloudflared.md).

## Install (Ubuntu, example paths)
1. Install the mod, then restart the PZ server once:
   ```
   sudo cp -r mod/ZMapPositions /home/zomboid/Zomboid/mods/
   sudo chown -R zomboid:zomboid /home/zomboid/Zomboid/mods/ZMapPositions
   ```
   Add `ZMapPositions` to `Mods=` in `servertest.ini` (the server name may differ). If players are blocked from joining by the new mod entry, use the fallback below.
2. Service user and code:
   ```
   sudo useradd -r -s /usr/sbin/nologin zmap
   sudo usermod -aG zomboid zmap
   sudo git clone https://github.com/ruku1143/zomboid-world-map /opt/zmap
   ```
3. Config: `sudo cp /opt/zmap/deploy/zmap.env.example /etc/zmap.env`, edit `PZ_DATA_PATH`, `PZ_INSTALL_PATH`, `SERVER_NAME`; then `sudo chown root:zmap /etc/zmap.env && sudo chmod 640 /etc/zmap.env`.
4. Run:
   ```
   sudo cp /opt/zmap/deploy/zmap.service /etc/systemd/system/
   sudo systemctl enable --now zmap
   ```
5. Open `http://127.0.0.1:8780` on the box (or tunnel to it). The `zomboid` group needs read+execute on `/home/zomboid` and `/home/zomboid/Zomboid` (`chmod g+rx`) so the `zmap` user can read the positions file.

**Fallback if clients complain about the mod:** instead of a mod folder, copy `mod/ZMapPositions/media/lua/server/ZMapPositions.lua` to `/srv/zomboid-server/media/lua/server/` and set `DoLuaChecksum=false` in the server ini.

## Update
`cd /opt/zmap && sudo git pull && sudo systemctl restart zmap`

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
