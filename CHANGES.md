# Changes from upstream

Forked from `fpsacha/zomboid-control-panel` (MIT). The whole upstream tree is still in git history before the "Strip to map-only" commit.

## Removed
- `server/` (Express app, Socket.IO, 75 services, routes, ~900 tests): auth, OIDC, RCON, server start/stop, backups, scheduler, Discord bot, file manager and SFTP, mod manager, setup wizard, chunk cleaner.
- `client/` (React/Vite/Tailwind app, all pages including Dashboard, Players, Mods, Backups, Console, Settings, Setup; 10 locales).
- `pz-mod/` (PanelBridge Lua mod, ~11k lines, admin command inbox; Workshop packaging).
- `docker/`, `Dockerfile`, compose files, `service-templates/`, `install-linux-service.sh`, `Start.bat`.
- `build.js`, `release.ps1`, `scripts/`, `browser-extension/`, `eslint-rules/`, lint and test configs.
- `docs/`, `ARCHITECTURE.md`, `DESIGN.md`, `PRODUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `Screenshots/`, `.github/`, `data/`.
- `package.json` and lockfile. There are no npm dependencies now.

## Reimplemented (small, from scratch, informed by upstream)
- Tile proxy and disk cache (from `server/routes/mapProxy.js`, B41 path only).
- Build detection (from `server/services/updateChecker.js`).
- Map client: vanilla JS canvas using upstream's Deep Zoom tile loading, coarse-tile fallback and B41 isometric projection (from `client/src/pages/WorldMap.tsx` and `worldMapTileFallback.ts`).
- Position mod: a ~60 line write-only Lua mod replacing PanelBridge.

## Not carried over on purpose
Authentication (use Cloudflare Access in front of the tunnel), Build 42 support, multi-floor view, points of interest, vehicles, Socket.IO.
