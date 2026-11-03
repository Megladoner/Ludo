# Realtime protocol

Transport: WebSocket at /ws, JSON text messages. Clients send intents only. The server responds with authoritative room snapshots and errors.

## Client messages
- room.create with a player name
- room.join with invitation, optional player token, and name
- lobby.ready with a boolean
- lobby.start
- game.roll
- game.move with a token index
- game.state
- room.leave
- room.close
- chat.send with message text

## Server messages
- room.created, room.joined, room.snapshot
- game.started, game.update
- room.error, chat.message

Every authoritative game update carries a monotonically increasing room sequence. Reconnect by joining with the original seat token to reclaim the seat and receive the current snapshot. Seat tokens are private bearer credentials; do not share them. Invitation tokens grant entry to the lobby only.
