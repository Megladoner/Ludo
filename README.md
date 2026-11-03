# PARCHEESI

A premium, mobile-first Ludo platform with a deterministic rules engine, local play, AI opponents, private rooms, and real-time room synchronization.

## Requirements
- Node.js 22+
- No npm dependencies are required.

## Start locally
```bash
node src/server/index.js
```
Open `http://localhost:3000`. Pass-and-play supports 2–4 local players; private online rooms support 2–4 seats. To test online play, open the same invitation URL in two independent browser profiles/devices.

## Verify
```bash
node --check src/server/index.js
node --check src/server/rooms.js
node --check src/server/websocket.js
node --check src/engine/ludo.js
npm run check
npm test
```

## Environment
Copy `.env.example` to `.env` and configure `HOST`, `PORT`, `PUBLIC_URL`, `ROOM_TTL_HOURS`, `RECONNECT_GRACE_SECONDS`, and `TRUST_PROXY` (only behind a trusted proxy that overwrites `X-Forwarded-For`). The current built-in server does not load `.env` automatically; export variables in the shell or use your process manager.

## Architecture and deployment
See [ARCHITECTURE.md](ARCHITECTURE.md), [deployment](docs/DEPLOYMENT.md), [protocol/API](docs/API.md), [security notes](docs/SECURITY.md), and [quality report](docs/QUALITY_REPORT.md). This baseline is a single-process Node service with local JSON persistence and a built-in WebSocket implementation. Put it behind HTTPS with WebSocket upgrade support for production. Do not horizontally scale without replacing local room persistence with a shared transactional store and adding pub/sub coordination.

## Current scope
Implemented in this baseline: four-player standard rules engine, responsive board UI, 2–4-player local pass-and-play, heuristic AI opponents, private room creation/joining, shareable invitation URLs, ready lobby, server-generated dice, server-validated moves, reconnect-by-seat-token, room snapshots, basic chat, PWA shell, offline asset caching, and tests.

Not yet implemented: public matchmaking, accounts, PostgreSQL/Redis, QR invites, alternate rulesets, adjustable AI difficulty/deep search, sound effects, token/dice customization, full rematch flow, persistent player profiles, full game replay, deployment automation, and multi-instance scaling. Browser autoplay restrictions apply to any future sound feature.
