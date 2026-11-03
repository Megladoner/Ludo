# Cloudflare Workers deployment

## Architecture
The Cloudflare entry point is `src/worker/index.js`. Static PWA files are served from `public/` using Workers Static Assets. The `/ws` endpoint is routed to a Durable Object (RoomHub), which coordinates multiplayer rooms and persists room snapshots in its SQLite-backed Durable Object storage. No Node server, writable filesystem, or external database is required on Cloudflare.

The original Node.js server in `src/server/` remains available for self-hosting. Its local JSON persistence is separate from Cloudflare Durable Object storage.

## Deploy
1. Create or sign in to a Cloudflare account.
2. Install Node.js 22+.
3. Run `npx wrangler login` and authorize the Cloudflare account.
4. From the repository root, run `npx wrangler dev` to test locally.
5. Deploy with `npx wrangler deploy`.
6. Open the workers.dev URL printed by Wrangler. A custom domain can be added from the Cloudflare Workers dashboard.

The Durable Object SQLite namespace is created by the migration in `wrangler.jsonc`. Keep the migration history in future deployments.

## Persistence and limitations
- Room data is persisted in RoomHub Durable Object SQLite storage and survives Worker restarts/hibernation.
- The current implementation uses one globally named RoomHub to preserve the existing room protocol and ordering semantics. This is a deliberate first deployment topology, not per-room sharding.
- The existing Node `data/rooms.json` and encrypted archive are not imported automatically. Cloudflare starts with an empty Durable Object store; old invite links and reconnect tokens will not carry over.
- Cloudflare account limits, usage-based pricing, and plan features apply. Review the Cloudflare dashboard before sharing a public link.
- Run the multiplayer flow using two independent browser profiles: create room, join, ready, start, take turns, chat, disconnect, and reconnect.

## Self-hosting with Node.js
The original Node server remains available. Use Node.js 22+, run `npm run check && npm test`, then `npm start` with a persistent writable `data/` directory and a reverse proxy that supports WebSocket upgrades. The Node and Cloudflare deployments use separate room stores and do not synchronize.
