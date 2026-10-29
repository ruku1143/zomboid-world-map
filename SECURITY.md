# Security policy

## Reporting a vulnerability
Please report security problems privately, not in a public issue:
**https://github.com/ruku1143/zomboid-world-map/security/advisories/new** (GitHub's private vulnerability reporting).

Include what you found, how to reproduce it, and what an attacker could do with it. This is a small personal project, so replies are best effort, usually within a week or two. Please give me a reasonable chance to fix it before disclosing it publicly.

## Supported versions
Only the latest `main` is supported. There are no release branches; update by pulling and restarting (see the README).

## What is in scope
Bugs in this repo's code that let someone do more than the map is meant to allow, for example:
- reading files outside the static `public/` folder or the Zomboid data folder (path traversal);
- making the tile proxy fetch anything other than the configured tile host, or filling the disk beyond the configured cache limit;
- exposing more of the Zomboid data folder than the documented fields (`PublicName` from the server ini, and the player, death-marker, safehouse, pause and clock data the mod writes);
- the Lua mod changing game state (it is meant to be write-only to its own `.txt` file).

## What is out of scope (by design)
- **No login.** The page is read-only and has no authentication. If it is reachable by strangers, it shows player names, positions, health, where players died and safehouses to all of them. Put it behind something like Cloudflare Access (see `deploy/cloudflared.md`) if that matters to you, and use the mod's option flags to share less.
- Vulnerabilities in Project Zomboid itself, the game server, or the third-party tile host (`tiles.pzmap.org`).
- Problems that need an attacker to already control the server or its files.
