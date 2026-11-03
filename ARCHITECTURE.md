# PARCHEESI — Architecture

## Shared game engine
- `src/engine/ludo.js`: deterministic game rules and AI heuristics.
- `public/engine.js`: browser-served copy of the shared engine. CI verifies it stays byte-for-byte synchronized with the source.
- `public/`: responsive PWA frontend, manifest, styles, icons, and offline shell.

## Cloudflare deployment
- `src/worker/index.js`: Cloudflare Worker entry point and Durable Object RoomHub.
- `wrangler.jsonc`: static assets, Worker entry point, Durable Object binding, and SQLite migration.
- Workers Static Assets serves the frontend. SPA fallback supports direct opening of invitation URLs such as `/room/:invite`.
- The Worker handles `/health`, `/api/config`, and WebSocket upgrades at `/ws`.
- RoomHub is the authoritative multiplayer coordinator. It validates room membership, lobby readiness, host actions, turn ownership, and moves; generates dice server-side; persists room snapshots in Durable Object SQLite storage; and broadcasts updates.
- WebSocket attachments associate live connections with their room/player, including across Durable Object hibernation.

## Node self-hosting
- `src/server/`: conventional HTTP routes, WebSocket framing, room lifecycle, and local JSON persistence.
- `data/`: runtime JSON room snapshots for the Node server only.
- `Dockerfile`: container build for a persistent Node host.

## Deployment characteristics
- Cloudflare initially uses one globally named RoomHub Durable Object. It is persistent but not yet sharded per room.
- The encrypted Node backup is not imported by Cloudflare. The Cloudflare room store starts empty.
- Node and Cloudflare deployments have separate room stores and do not synchronize.
