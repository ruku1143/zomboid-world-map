# Changes from upstream

Forked from `fpsacha/zomboid-control-panel` (MIT). The whole upstream tree is still in git history before the "Strip to map-only" commit.

This repo keeps only the live map: a tile proxy with a disk cache, a vanilla JS canvas client, and a ~100 line write-only Lua mod (replacing the ~11k line PanelBridge mod and its admin command inbox). Everything else was removed on purpose: the Express/React control panel and its services, authentication (use Cloudflare Access in front of the tunnel), Docker and installers, Build 41 support, multi-floor view, points of interest, vehicles, Socket.IO, and all npm dependencies.
