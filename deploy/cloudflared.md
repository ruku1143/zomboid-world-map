# Exposing the map with a Cloudflare tunnel

The app binds to `127.0.0.1:8780` and has no login of its own. Put Cloudflare Access in front.

1. Cloudflare Zero Trust > Networks > Tunnels: create a tunnel, add a public hostname (for example `map.example.com`) pointing at `http://127.0.0.1:8780`.
2. Zero Trust > Access > Applications: add a self-hosted application for the same hostname with an allow policy (emails, or a one-time PIN for friends). Without this the map, including live player positions, is public.
3. Verify from outside: `curl -I https://map.example.com` should redirect to the Access login.
