# HTTP and realtime API

## HTTP
- `GET /health` — liveness response.
- `GET /api/config` — returns the public URL setting (or request origin).
- `GET /` — application shell.
- `GET /room/:invite` — application shell for a shareable invitation route.
- `GET /engine.js` — shared browser rules engine.
- `GET /manifest.webmanifest` and `GET /sw.js` — PWA metadata and service worker.

The current API has no user accounts or public matchmaking endpoints.

## WebSocket
Connect to `ws(s)://<host>/ws`. Messages are UTF-8 JSON text frames. Client payloads are intents; the server does not accept client-supplied dice results or resulting game states.

### Client messages
| Type | Payload | Authorization |
|---|---|---|
| `room.create` | `{name}` | New socket |
| `room.join` | `{invite, playerToken?, name}` | Valid invite or seat token |
| `lobby.ready` | `{ready}` | Room member, lobby only |
| `lobby.start` | `{}` | Current host; at least two ready players |
| `game.roll` | `{}` | Current player only |
| `game.move` | `{token}` | Current player; engine-validated |
| `game.state` | `{}` | Room member |
| `room.leave` | `{}` | Room member |
| `room.close` | `{}` | Current host |
| `chat.send` | `{text}` | Room member; 240-character limit |

### Server messages
- `room.created`: `invite`, private `playerToken`, `playerColor`, and room snapshot.
- `room.joined`: the same seat credentials for a joining/reconnecting client.
- `room.snapshot`: authoritative lobby/game snapshot.
- `game.started`: initial authoritative game snapshot.
- `game.update`: authoritative state, room sequence, and event metadata.
- `room.error`: rejected request reason.
- `chat.message`: room chat message and sequence.

The seat token is a bearer credential. Keep it private. Room snapshots deliberately omit seat tokens. Room invitation tokens are random and separate from internal UUIDs.
