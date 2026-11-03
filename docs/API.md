# HTTP and realtime API

## HTTP
- `GET /health` — liveness response.
- `GET /api/config` — returns the public URL setting (or request origin).
- `GET /` — application shell.
- `GET /room/:invite` — application shell for a shareable invitation route.
- `GET /engine.js` — shared browser rules engine.
- `GET /profile.js` — the browser-local profile module.
- `GET /manifest.webmanifest` and `GET /sw.js` — PWA metadata and service worker.

The current API has no user accounts, no public matchmaking endpoints, and no profile endpoints. The profile card is stored in the browser only; nothing about it reaches the server.

## WebSocket
Connect to `ws(s)://<host>/ws`. Messages are UTF-8 JSON text frames. Client payloads are intents; the server does not accept client-supplied dice results or resulting game states.

### Client messages
| Type | Payload | Authorization |
|---|---|---|
| `room.create` | `{name}` | New socket |
| `room.join` | `{invite, playerToken?, name}` | Valid invite or seat token |
| `lobby.ready` | `{ready}` | Room member, lobby only |
| `lobby.rename` | `{name}` | Room member |
| `lobby.kick` | `{playerId}` | Current host; cannot remove the host |
| `lobby.start` | `{}` | Current host; at least two ready players |
| `game.roll` | `{}` | Current player only |
| `game.move` | `{token}` | Current player; engine-validated |
| `game.rematch` | `{}` | Room member; only once the game has finished |
| `game.state` | `{}` | Room member |
| `room.leave` | `{}` | Room member; releases the seat |
| `room.close` | `{}` | Current host |
| `chat.send` | `{text}` | Room member; 240-character limit |

### Server messages
- `room.created`: `invite`, private `playerToken`, `playerColor`, and room snapshot.
- `room.joined`: the same seat credentials for a joining/reconnecting client.
- `room.snapshot`: authoritative lobby/game snapshot.
- `game.started`: initial authoritative game snapshot.
- `game.update`: authoritative state, room sequence, and event metadata.
- `room.error`: rejected request reason.
- `room.kicked`: the host removed this player from the table.
- `room.closed`: the host closed the table.
- `chat.message`: room chat message and sequence.

Every server message carries a top-level `sequence` that increases with each state change. Clients drop frames older than the last sequence they processed.

The seat token is a bearer credential. Keep it private. Room snapshots deliberately omit seat tokens.

Invitation codes are eight characters drawn from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no look-alike characters, so a code can be dictated over a phone. Entry normalises case and ignores spaces, dashes and slashes. The code is separate from internal UUIDs.

## Profile storage

There is deliberately no profile API. The name, the statistics, the recent-match history and the photo live in the browser's `localStorage` under `parcheesi.profile` and `parcheesi.profile.photo`. Clearing site data removes them. They are never uploaded, never shared between browsers, and never visible to the server.
