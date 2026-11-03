# PARCHEESI — Architecture

## Shared game engine
- `src/engine/ludo.js`: deterministic rules, legal action generation, board coordinates, and AI heuristics.
- `public/`: responsive PWA frontend, SVG board renderer, manifest, and offline shell.

## Cloudflare deployment
- `src/worker/index.js`: Workers entry point and Durable Object RoomHub.
- `wrangler.jsonc`: static asset binding, Worker entry point, Durable Object binding, and SQLite class migration.
- Workers Static Assets serves the frontend. `/health` and `/api/config` are handled by the Worker. `/ws` is upgraded inside RoomHub.
- RoomHub is the authoritative multiplayer coordinator. It validates room membership, readiness, host actions, turn ownership, and legal moves; generates dice server-side; persists room snapshots in Durable Object SQLite storage; and broadcasts authoritative snapshots.
- WebSocket attachments associate each live connection with its room/player. Durable Object storage preserves room data across restarts and hibernation.

## Node self-hosting
- `src/server/`: conventional HTTP routes, WebSocket framing, room lifecycle, and local JSON persistence.
- `data/`: runtime JSON room snapshots for the Node server only.
- `Dockerfile`: container build for a persistent Node host.

## Important deployment characteristics
- Cloudflare currently uses one globally named RoomHub Durable Object to preserve room ordering and the existing protocol. It is durable but is a single coordination object, not yet sharded per room.
- The existing encrypted `data/rooms.json.enc` backup is not imported by the Worker. Cloudflare starts with an empty Durable Object store.
- Node and Cloudflare deployments are separate runtime targets; their room stores are not synchronized.
