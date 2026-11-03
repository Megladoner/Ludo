# PARCHEESI — Architecture

## Shared game engine
- `src/engine/ludo.js`: deterministic game rules, standings, and AI heuristics for three difficulty tiers.
- `public/engine.js`: browser-served copy of the shared engine. CI verifies it stays byte-for-byte synchronized with the source.
- `public/`: responsive PWA frontend, manifest, styles, icons, and offline shell.
- `public/boot.js`: restores the saved board theme before first paint. It lives in its own file rather than an inline script so the page stays free of inline code and satisfies a strict `script-src 'self'` policy.

## Client architecture
- `public/app.js`: the whole client — state, dialogs, network, rendering, and board motion — organised into clearly separated sections.
- Every prompt-shaped interaction uses a real `<dialog>`: the name sheet, the table setup sheet, the table menu, and a reusable confirmation sheet. All of them resolve a promise, validate before closing, and restore focus to whatever opened them.
- The board is redrawn as SVG on every change. Tokens are grouped so a moved token can be transitioned from its old cell to its new one, and a captured token animates back to its base.
- The dice tumbles while the authoritative result is in flight and lands on the server's number.
- The client reconnects on its own with a backoff, reclaims the seat with the stored token, and shows its state in the connection pill.

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

## Protocol
- Every server message carries a monotonic `sequence` that advances on each state change. Clients discard older frames so a slow connection cannot resurrect a stale board.
- Invitation codes are eight readable characters; seat tokens remain long random bearer credentials.

## Deployment characteristics
- Cloudflare initially uses one globally named RoomHub Durable Object. It is persistent but not yet sharded per room.
- The encrypted Node backup is not imported by Cloudflare. The Cloudflare room store starts empty.
- Node and Cloudflare deployments have separate room stores and do not synchronize.
