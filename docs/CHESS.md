# Chess

Chess lives beside Ludo and shares its look, audio, profile and voice code. Ludo is untouched: `/ludo/` and `/room/<code>` are the same pages as before (the old `/` is now the landing page).

## Routes

| Path | Page |
| --- | --- |
| `/` | Landing page (Ludo or Chess) |
| `/ludo/`, `/room/<code>` | Ludo (unchanged) |
| `/chess/` | Chess menu |
| `/chess/local`, `/chess/computer` | Pass & play, vs computer (saved on the device, so a refresh resumes) |
| `/chess/room/<CODE>` | Online room. Invalid, expired and full links return to the menu with a message |
| `POST /api/chess/create`, `GET /api/chess/room/<CODE>` | Create a room / read its status |
| `/ws/chess/<CODE>` | Room WebSocket |

## How it works

- **Rules** are chess.js everywhere. `src/chess/core.js` (copied byte-for-byte to `public/chess/core.js`, checked by `npm run check`) is a pure state machine for games, clocks and rooms. The Worker, the tests and the browser all run it.
- **Online rooms** are one Durable Object per room (`ChessRoom`, SQLite-backed, hibernating WebSockets). The object validates every move, owns the clocks and wakes itself with an alarm when a flag falls or a first move is overdue. Clients send intent only; every state they see is a server snapshot with a monotonic `sequence`. Seat tokens live in `localStorage`, so refresh, reconnect and a second tab return to the same seat. Rooms are deleted 24 hours after the last activity.
- **Clocks** start when both players have moved once (first-move window: 60 s, then the game can be aborted by either side). 10+0, 5+0, 3+0, 2+1, 1+0 and Unlimited (no countdown shown).
- **Abort / resign**: abort before both sides have moved, resign after. Also checkmate, stalemate, agreement, threefold, fifty-move, insufficient material, timeout and abandonment (claimable after 60 s of the opponent being gone).
- **Computer**: Stockfish 19 (lite, single-threaded WASM) in a Web Worker. Levels 1–2 use Skill Level with a depth cap, levels 3–6 use `UCI_LimitStrength` with Elo 1400/1800/2300/2800, level 7 is full strength. Level 7 beat level 1 in both colours in a self-play check.
- **Analysis**: the same engine searches every position after the game; win-percentage loss thresholds of 5/10/15 points mark inaccuracies, mistakes and blunders. Works for both online players, locally.
- **Themes**: Noir, Classic and Forest are token sets on `:root[data-chess-theme]` that re-skin the shared Ludo components too. Stored in `localStorage` and applied before first paint by `chess/boot.js`.

## Protocol (WebSocket JSON)

Client → server: `room.join`, `lobby.settings`, `lobby.rename`, `lobby.start`, `lobby.back`, `game.state`, `game.move {from,to,promotion,ply}`, `game.resign`, `game.abort`, `game.draw.offer|accept|decline|cancel`, `game.claim`, `game.rematch`, `chat.send`, `voice.*`, `room.leave`, `room.close`.
Server → client: `room.joined`, `room.snapshot {sequence, room, serverNow, event}`, `chat.message`, `room.error`, `room.closed`, plus relayed `voice.*`.

## Not available on the Node dev server

`npm run dev` serves every chess page and the engine, so pass & play and vs-computer work. Online rooms need the Cloudflare Worker (`npm run dev:worker`), because rooms are Durable Objects.

## Deploy notes

`wrangler.jsonc` gains the `CHESS_ROOM` binding, migration `v2` (`ChessRoom`, SQLite) and extra `run_worker_first` routes. The existing Git-connected deploy applies them automatically.

## Licences

- Stockfish 19 (`public/chess/engine/`) is GPL-3.0; the licence text ships beside it and the source is at https://github.com/official-stockfish/Stockfish. Distributing the site also distributes the engine under that licence.
- chess.js is BSD-2-Clause.
- Piece artwork: "Cburnett" set by Colin M.L. Burnett, CC BY-SA 3.0, via cm-chessboard (MIT).

## Tests

`node --test` (core rules, clocks, rooms) and, with `wrangler dev` running, `npm run test:browser:chess` (landing, local, drag, promotion, mate, analysis, themes, computer, two-browser online with refresh, chat, draw, resign, abort, mobile).
