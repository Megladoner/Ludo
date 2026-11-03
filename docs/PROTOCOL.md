# Realtime protocol

Transport: WebSocket at `/ws`, JSON text messages. Clients send intents only. The server responds with authoritative room snapshots and errors.

Every server message carries a top-level `sequence`. It increases on every state change (join, leave, ready, rename, kick, start, roll, move, rematch, chat, disconnect). Clients should ignore any frame whose `sequence` is **lower** than the last one they processed — that discards updates that arrive out of order on a slow connection.

## Client messages

| Message | Payload | Notes |
| --- | --- | --- |
| `room.create` | `name` | Creates a room and returns a seat token. |
| `room.join` | `invite`, `playerToken?`, `name` | `invite` is case- and punctuation-insensitive. Send the stored `playerToken` to reclaim a seat. |
| `lobby.ready` | `ready` | Boolean. |
| `lobby.rename` | `name` | Changes the sender's display name. |
| `lobby.kick` | `playerId` | Host only. Removes another player from the table. |
| `lobby.start` | — | Host only. Requires at least two players, everyone ready. |
| `game.roll` | — | Only valid on the player's turn. The server rolls the dice. |
| `game.move` | `token` | Token index 0–3. Server-validated. |
| `game.rematch` | — | Only valid once the game has finished. Returns the table to the lobby with everyone unready. |
| `game.state` | — | Requests a fresh snapshot. |
| `room.leave` | — | Releases the seat. The socket may be closed straight after. |
| `room.close` | — | Host only. Closes the room for everybody. |
| `chat.send` | `text` | Up to 240 characters. |

## Server messages

| Message | Payload | Notes |
| --- | --- | --- |
| `room.created` | `invite`, `playerToken`, `playerColor`, `room` | Sent to the creator only. |
| `room.joined` | `invite`, `playerToken`, `playerColor`, `room` | Sent to the joiner; a snapshot follows for everyone. |
| `room.snapshot` | `room` | The full room, sent after every lobby change. |
| `game.started` | `room` | The game is live. |
| `game.update` | `room`, `event` | `event` is `{type:'roll',player,roll}` or `{type:'move',player,token}`. |
| `chat.message` | `player`, `color`, `text` | |
| `room.error` | `error` | Human-readable reason for a rejected action. |
| `room.kicked` | — | The host removed you from the table. |
| `room.closed` | — | The host closed the table. |

## Seats and tokens

* **Invitation codes** are eight characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `I`, `L`, `O`, `0` or `1`, so a code can be read aloud without confusion. Entry is normalised: case, spaces, dashes and slashes are ignored.
* **Seat tokens** are long random bearer credentials stored per browser under `parcheesi:<invite>`. They reclaim a seat after a reload or a dropped connection. Never share them.
* A dropped socket keeps the seat for the grace period and marks the player as reconnecting. An explicit `room.leave` releases the seat immediately and forfeits any tokens that player still had on the board.
