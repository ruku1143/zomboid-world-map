# CLAUDE.md

Read-only live world map for a Project Zomboid **Build 42** dedicated server. Zero npm dependencies. `README.md` is the install/ops guide, `DISCOVERY.md` records how the game and tile host behave, `CHANGES.md` says what was stripped from the upstream fork. Read those before changing behaviour they describe; this file is the quick orientation.

## How it fits together
```
game server ──(Lua mod, every 1 s)──> <Zomboid data>/Lua/zmap_players.txt
                                             │ read + sanitised
browser <──/api/players, /api/meta, /tiles/*── server.js ──(curl, cached on disk)──> tiles.pzmap.org
```
- `mod/ZMapPositions/42/media/lua/server/ZMapPositions.lua`: write-only server mod. Writes one JSON document (as `.txt`: Build 42 `getFileWriter` rejects `.json`) with `t`, `time` (in-game clock), `paused` (PauseEmpty froze the world; `null` if unknown), `players` (name, x, y, z, `hp`, `car`) and `safehouses`. Invisible/ghost-mode admins are left out. Four option flags at the top (`SHOW_HEALTH`, `SHOW_GAME_TIME`, `SHOW_IN_VEHICLE`, `HIDE_INVISIBLE_ADMINS`). Every game API call is guarded (`guarded` / `pcall` / method-exists checks, each player separately) so one failing call can't stop position writes.
- `server.js`: config from env (`deploy/zmap.env.example`), `readPlayers` (sanitises everything the mod wrote; a stale file means nobody online and no clock), `readServerName` (`PublicName` from `<data>/Server/<SERVER_INI>.ini`, falls back to `SERVER_NAME`; only that one line is read, the ini holds the RCON password), `readBuildInfo`, the tile proxy + disk cache, static files. `MAP` is the tile layout constant, copied by hand because the tile host blocks `layer0.dzi`/`map_info.json` from servers.
- `public/projection.js`: pure functions (projection, zoom/level maths, colours, `stepCamera` easing). Anything that can be pure goes here so it can be unit tested.
- `public/towns.js`: town label positions (data only, credited in `CHANGES.md`; add or fix towns here).
- `public/map.js`: the canvas client (tiles, drawing, input, polling). Needs a DOM, so it is not unit tested; verify it in a browser.
- `prefetch.js`: optional tile pre-warm. `deploy/`: systemd unit, env example, cloudflared notes.

## Commands
- `npm test`: Node's built-in runner, `test/zmap.test.js` (Node 20+; CI runs 20 and 22).
- `node server.js` serves on `PORT` (default 8780). To try it locally without a game server, point `PZ_DATA_PATH` at a temp folder containing `Lua/zmap_players.txt` (and optionally `Server/pzserver.ini`), e.g. `PZ_DATA_PATH=/tmp/x PORT=8791 TILE_CACHE_DIR=/tmp/tc node server.js`. Tiles load from the real host if the network allows it.
- CI (`.github/workflows/ci.yml`): `test (20)`, `test (22)`, `lua` (`luac5.1 -p` on the mod: Project Zomboid's Kahlua is Lua 5.1), `secrets`. All four must be green.
- Checking UI changes: Playwright's Chromium is preinstalled (`/opt/pw-browsers/chromium`; launch it with `executablePath`, never `playwright install`). Screenshot desktop (900x500) and a phone viewport (390x844); mobile layout has bitten before.
- Don't `pkill -f "node server.js"` from a Bash call: the pattern matches the shell running it. Keep the PID and `kill` that.

## Conventions
- Match the surrounding code: terse comments that explain *why*, no new dependencies, vanilla JS, ES modules.
- Anything the mod writes is untrusted on the server side: validate type and range in `server.js` (see `cleanSafehouses`, `cleanGameTime`, the `hp`/`car` handling in `readPlayers`) and add a test for each new field. The page treats `null` as "not shared / unknown" and hides it.
- New mod data needs: Lua write (guarded), server sanitising + test, client display, and usually an option flag + README mention in the Privacy options paragraph.
- Style tokens live in `public/style.css` (`:root` variables). The top bar wraps on phones, so anything pinned under it uses `var(--bar-h)` (set from the bar's real height in `map.js`), not a fixed pixel offset.
- Map dots, list swatches and labels share one look (colour disc, dark border, faint light ring, 14px normal-weight name). Keep them in step.
- Camera: `cam` eases toward `goal` each frame (`stepCamera`); wheel zoom and "centre on player" set the goal, drag and pinch move `cam` directly, releasing a drag flings. Honour `prefers-reduced-motion` (instant).
- Floors: `floor` in `map.js` (-1..7) is part of the tile key and URL (`tiles/f<floor>/<level>/<col>_<row>.jpg`, ground floor keeps the plain path); `server.js` `tilePaths` maps that to the cache path and the upstream `layer<floor>_files` URL. Players on other floors are drawn at 40% alpha. Town labels fade out between zoom 15.8 and 16.8; both the town and safehouse toggles are remembered in `localStorage`.
- Player dots glide between polls (`glidePlayers`), snapping instead for jumps over 500 tiles.

## Deploying (for the owner; details in README)
- Web changes: `sudo -u zmap git -C /srv/zomboid-map pull && sudo systemctl restart zmap`.
- Mod changes also need the script re-copied to `/srv/zomboid-server/media/lua/server/` and a game-server restart (check nobody is online first). It is installed as a loose file on purpose, not via the Workshop, with `DoLuaChecksum=false`. Mod options are edited in the installed copy. Publishing to the Workshop was considered and deliberately not pursued.
- The Lua side can't be tested in CI or from a cloud session: it needs a running Build 42 server. Say so in the PR and ask the owner to check in-game.

## Git workflow
- Work on the branch the session is given and open a **draft** PR; the owner marks it ready and squash-merges. After a merge the same branch name is reused: reset it to the latest `main` (`git fetch origin main && git checkout -B <branch> origin/main`) before new work, never stack on merged history.
- Commit messages: short imperative subject. PR bodies explain what and why, state what was and wasn't tested, and say if a game-server restart is needed.
- Don't force-push. If CI fails, fix the cause; never skip or disable tests.

## Gotchas
- Tiles at the right and bottom edge of a level are smaller than the tile size; draw them at their real size or terrain drifts away from the player dots (`exactTileRect`, `parentCrop`).
- A 404 from the tile host means "nothing rendered here", not an error: draw nothing, and don't substitute coarser tiles.
- The map is the 42.20.0 render while servers may run 42.21.x; only a major-version change shows the red banner.
- Hidden or unreadable mod fields must come through as `null`, not be dropped or defaulted to a real value.
- Browsers cache favicons hard; a hard refresh is needed to see icon changes.
