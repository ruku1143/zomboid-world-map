# Changes from upstream

Forked from `fpsacha/zomboid-control-panel` (MIT). The whole upstream tree is still in git history before the "Strip to map-only" commit.

This repo keeps only the live map: a tile proxy with a disk cache, a vanilla JS canvas client, and a ~150 line write-only Lua mod (replacing the ~11k line PanelBridge mod and its admin command inbox). Everything else was removed on purpose: the Express/React control panel and its services, authentication (use Cloudflare Access in front of the tunnel), Docker and installers, Build 41 support, vehicles, Socket.IO, and all npm dependencies.

Since then the map has gained a floor selector (basement to floor 7), town names, a points-of-interest layer (below), safehouse outlines, remembered death markers, an Online/Offline/Paused status pill, a sonar ping on living players and, in the mod, health, in-game time, an in-vehicle flag, death and pause reporting and the `SHOW_*` options; all of it is new code apart from the data credited here. The only upstream data used is the list of town positions in `public/towns.js`, taken from the POI list in upstream's `client/src/lib/worldMapPoi.json` (MIT, see `LICENSE`).

## Points of interest

Points of interest came back later as a small static layer: `public/pois.js` is the building list from `html/poi.json` of [CalvyPZ/PZmap](https://github.com/CalvyPZ/PZmap) (the same data upstream's POI list was built from), with the 3000-series town and region entries dropped (towns are in `public/towns.js`), exact duplicates merged, a garbled name repaired, and each entry given a category by keywords in its name (medical, police, fire, military, gas, food, shop, civic; anything else is "other"). The only thing the mod adds is the `SHOW_POIS` flag. The source's licence notice, as required:

> MIT License
>
> Copyright (c) 2022 Min Xiang
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
