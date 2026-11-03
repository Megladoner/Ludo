# PARCHEESI

A mobile-first Ludo platform with a deterministic rules engine, local play, AI opponents, private rooms, and real-time room synchronization.

## Cloudflare Workers (hosted deployment)
This repository includes a Cloudflare Workers adapter:
- Static PWA assets: Workers Static Assets from `public/`
- Multiplayer API and WebSockets: Durable Object `RoomHub`
- Room persistence: Durable Object SQLite storage

Requirements: Node.js 22+ and a Cloudflare account.

```bash
npx wrangler login
npx wrangler dev
# Deploy when ready:
npx wrangler deploy
```

See [Cloudflare deployment](docs/DEPLOYMENT.md) for setup, persistence details, and limitations.

## Self-host with Node.js
No npm runtime dependencies are required.

```bash
node src/server/index.js
```

Open `http://localhost:3000`. Pass-and-play supports 2–4 local players; private online rooms support 2–4 seats. For online testing, open the same invitation URL in two independent browser profiles/devices.

## Verify
```bash
npm run check
npm test
```

## Node environment
For the Node server, copy `.env.example` to `.env` and configure `HOST`, `PORT`, `PUBLIC_URL`, `ROOM_TTL_HOURS`, `RECONNECT_GRACE_SECONDS`, and `TRUST_PROXY`. The Node server does not load `.env` automatically; export variables in the shell or use your process manager.

## Scope
Implemented: four-player standard rules engine, responsive board UI, 2–4-player local pass-and-play, heuristic AI opponents, private room creation/joining, shareable invitation URLs, ready lobby, server-generated dice, server-validated moves, reconnect-by-seat-token, room snapshots, basic chat, PWA shell, offline asset caching, and tests.

Not yet implemented: public matchmaking, accounts, QR invites, alternate rulesets, adjustable AI difficulty/deep search, sound effects, token/dice customization, full rematch flow, persistent player profiles, and full game replay.
