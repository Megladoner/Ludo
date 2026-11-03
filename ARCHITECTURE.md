# PARCHEESI — Architecture (environment-constrained baseline)

## Decision
The supplied environment has Node.js 22.16.0 and Chromium/Playwright, but no npm cache, database CLI, or DNS/network access to the npm registry. To keep the deliverable runnable and testable here, the first implementation uses Node.js built-ins only: a static PWA frontend, an HTTP API, a small RFC 6455 WebSocket server, and a shared deterministic game engine. This is an explicit deviation from the preferred Next.js/React/Socket.IO/PostgreSQL stack, not a claim that those services are installed.

## Components
- `src/engine/`: pure deterministic rules, board coordinate model, legal action generation, AI heuristics.
- `src/server/`: HTTP routes, WebSocket framing/protocol, room lifecycle, authoritative action handling, persistence.
- `public/`: responsive app, SVG board renderer, PWA manifest/service worker.
- `tests/`: Node built-in test runner tests for rules and multiplayer protocol.
- `data/`: runtime room snapshots (not committed).

## Authority and protocol
Clients send intents only (`room.join`, `lobby.ready`, `game.roll`, `game.move`, `game.state`). The server authenticates each socket against an unguessable seat token, validates room membership/turn/action, generates dice using `crypto.randomInt`, applies the pure engine, increments a monotonic sequence, persists state, and broadcasts authoritative snapshots/events. Reconnect uses the seat token and a full state snapshot. Invitation tokens are independent of internal room IDs.

## Initial limitations
- Single-process deployment; room snapshots are atomically written to local JSON files. Horizontal scaling requires a shared transactional store and pub/sub adapter.
- No external SQL/Redis service is available. No account system, public matchmaking, QR code, or hosted deployment is claimed in this baseline.
- Standard four-player rules are implemented; alternate player counts and rule profiles are deferred.
- The board uses a canonical 52-cell perimeter route and player-specific six-cell home lanes exported by the shared rules engine; the SVG renderer consumes those same coordinate arrays. The rules engine is independent of SVG rendering.

## Run
`npm` is not required: `node src/server/index.js`, `node --test`, and `node --check src/server/index.js`.
