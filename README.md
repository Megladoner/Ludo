# PARCHEESI

A mobile-first Ludo platform with local play, AI opponents, private multiplayer rooms, and real-time synchronization.

## Deploy to Cloudflare Workers (GitHub-connected)

This repository is preconfigured for Cloudflare Workers. It serves the PWA from Workers Static Assets and runs multiplayer rooms on a Durable Object with persistent SQLite storage.

1. In Cloudflare, open **Workers & Pages** → **Create application** → **GitHub**.
2. Connect your GitHub account and select **Megladoner/Ludo**.
3. Set the Worker name to **parcheesi** (it must match `wrangler.jsonc`).
4. Set the production branch to **main**.
5. Leave the root directory as `/`.
6. Build command: leave blank. Deploy command: `npx wrangler deploy`.
7. Select **Save and Deploy**. Cloudflare will create the Durable Object SQLite namespace from the migration and publish the Worker.
8. Open the `workers.dev` URL shown by Cloudflare.

No environment variables, API keys, or manually created databases are required. Future pushes to `main` automatically trigger a new deployment.

## What works on the hosted URL

- Main game page and PWA assets
- Local pass-and-play (2–4 players)
- Solo play against AI
- Private multiplayer rooms (2–4 players)
- Invite links, ready lobby, server-generated dice and server-validated moves
- Reconnection using the seat token stored in that browser
- Live room snapshots and in-room chat
- Room persistence in Durable Object storage

The room database starts empty on the first Cloudflare deployment. Existing Node-hosted room links and reconnect tokens are not imported.

## Run locally with Node.js

Requires Node.js 22+.

```bash
npm install
npm run check
npm test
npm start
```

The Node server uses `src/server/` and persists room data in `data/rooms.json`. It is independent from Cloudflare's Durable Object room store.

## Scope

Not yet implemented: public matchmaking, accounts, QR invites, alternate rulesets, adjustable AI difficulty/deep search, sound effects, token/dice customization, full rematch flow, persistent player profiles, and full game replay.
