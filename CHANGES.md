# Changes from upstream

Forked from `fpsacha/zomboid-control-panel` (MIT). The whole upstream tree is still in git history before the "Strip to map-only" commit.

This repo keeps only the live map: a tile proxy with a disk cache, a vanilla JS canvas client, and a ~150 line write-only Lua mod (replacing the ~11k line PanelBridge mod and its admin command inbox). Everything else was removed on purpose: the Express/React control panel and its services, authentication (use Cloudflare Access in front of the tunnel), Docker and installers, Build 41 support, points of interest, vehicles, Socket.IO, and all npm dependencies.

Since then the map has gained a floor selector (basement to floor 7), town names and, in the mod, health, in-game time and an in-vehicle flag; all of it is new code. The only upstream data used is the list of town positions in `public/towns.js`, taken from the POI list in upstream's `client/src/lib/worldMapPoi.json` (MIT, see `LICENSE`).
