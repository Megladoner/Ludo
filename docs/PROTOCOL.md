# Realtime protocol

Transport: WebSocket at `/ws`, JSON text messages. Clients send intents only. The server responds with authoritative room snapshots and errors.

Every server message carries a top-level `sequence`. It increases on every state change (join, leave, ready, rename, kick, start, roll, move, rematch, chat, disconnect). Clients should ignore any frame whose `sequence` is **lower** than the last one they processed — that discards updates that arrive out of order on a slow connection.

## Client messages

| Message | Payload | Notes |
| --- | --- | --- |
| `room.create` | `name`, `voiceEnabled?` | Creates a room and returns a seat token. `voiceEnabled` defaults to true; a table that turns voice off refuses every `voice.signal`. |
| `room.join` | `invite`, `playerToken?`, `name` | `invite` is case- and punctuation-insensitive. Send the stored `playerToken` to reclaim a seat. |
| `lobby.ready` | `ready` | Boolean. |
| `lobby.rename` | `name` | Changes the sender's display name. |
| `lobby.kick` | `playerId` | Host only. Removes another player from the table. |
| `lobby.start` | — | Host only. Requires at least two players, everyone ready. |
| `game.roll` | — | Only valid on the player's turn. The server rolls the dice. |
| `game.move` | `token` | Token index 0–3. Server-validated. Any token the roll legally allows is accepted, including bringing a token out of the box on a six. |
| `voice.signal` | `kind`, `to`, `data` | The voice handshake. `kind` is `hello`, `here`, `offer`, `answer`, `ice`, `state` or `bye`. The server validates the kind, the seat and the size, then relays it — to one seat for the targeted kinds, or to the whole table for `hello` and `bye`. No audio ever passes through it. |
| `game.rematch` | — | Only valid once the game has finished. Returns the table to the lobby with everyone unready and clears the finishing order. |
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

## Game state

The snapshot's `state` is the shared engine's state, version 4. Alongside the classic fields it carries:

| Field | Notes |
| --- | --- |
| `finishOrder` | Players who have brought all four tokens home, in the order they did it. Empty until somebody finishes. |
| `lastFinish` | The player who finished most recently. |
| `version` | The engine version (`4`). Clients ignore unknown fields, so old clients still parse new snapshots. |

Version 3 replaced the version 2 `bonusToken` field. The home lane no longer grants a move, so there is nothing left to point at. A client that still sends it is simply ignored.

### Voice in a room
The room creator may switch voice off while creating the table. The flag is stored with the room, included in every room snapshot as `voiceEnabled`, and never changes for the life of that room. A table with voice off refuses every `voice.signal` and shows no microphone.

### Voice handshake
`voice.signal` carries a `kind` and, for the targeted kinds, the seat colour in `to`:

| Kind | Direction | Carries |
|---|---|---|
| `hello` | broadcast | The session stamp of the seat that just opened its microphone |
| `here` | targeted | The session stamp of a seat that is already talking |
| `offer` | targeted | A WebRTC offer and the session stamp |
| `answer` | targeted | The reply to that offer and the session stamp |
| `ice` | targeted | One network candidate and the session stamp |
| `state` | targeted | Whether the far end has muted its microphone |
| `bye` | broadcast | The seat has left the voice |

The server refuses an unknown kind, a seat that is not at the table, a payload over 8 KB, and any handshake from a table that turned voice off. The voice handshake has its own rate allowance, because a burst of network candidates would otherwise count against the table's ordinary limit.

### The ICE configuration
`GET /api/voice/ice` answers with the ice servers the browser should use. It always includes Cloudflare's free STUN server. When a TURN key is configured as a server secret it also returns a short-lived Cloudflare TURN credential (valid up to 48 hours; the server asks for 12). The long-term key stays on the server and is never sent to a browser.

Version 4 changes how a roll is applied, not how it is transmitted. It replaced the "committed roll" with a conditional one: a token on the board plays itself only when it is the only token on the board and nothing is left in the box. A six always offers the box alongside the board, so the player decides between deploying a token and moving one. Version 4 also added `sixStreak` — the snapshot of the table taken when a run of sixes starts, so the third six can put every token back where it was. The field is `null` whenever no run of sixes is in progress.

A three- or four-player game is not over when the first player finishes: `status` stays `playing` until every player has finished, and the finishing order is what ranks the table. A two-player game ends at the first finisher as before.

## Seats and tokens

* **Invitation codes** are eight characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `I`, `L`, `O`, `0` or `1`, so a code can be read aloud without confusion. Entry is normalised: case, spaces, dashes and slashes are ignored.
* **Seat tokens** are long random bearer credentials stored per browser under `parcheesi:<invite>`. They reclaim a seat after a reload or a dropped connection. Never share them.
* A dropped socket keeps the seat for the grace period and marks the player as reconnecting. An explicit `room.leave` releases the seat immediately and forfeits any tokens that player still had on the board.

## Rejoining
A client that reloads the page, loses signal or is interrupted rejoins with `room.join` and its stored seat token. The server hands the seat back and the client is put straight back into the running game. The room itself is never torn down by a dropped connection: the seat is held for a grace period.

## Local profile card

The profile card never touches the network. It is written to `localStorage` in the browser under `parcheesi.profile` and `parcheesi.profile.photo`, and it is not represented in any protocol message. No server endpoint accepts or returns profile data.
