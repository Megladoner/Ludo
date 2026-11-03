# PARCHEESI — Architecture

## Shared game engine
- `src/engine/ludo.js`: deterministic game rules, standings, and AI heuristics for three difficulty tiers. The engine is versioned (`version: 4`) and carries `finishOrder`, `lastFinish` and `sixStreak` alongside the classic fields.
- `public/engine.js`: browser-served copy of the shared engine. CI verifies it stays byte-for-byte synchronized with the source.
- `public/`: responsive PWA frontend, manifest, styles, icons, and offline shell.
- `public/boot.js`: restores the saved board theme before first paint. It lives in its own file rather than an inline script so the page stays free of inline code and satisfies a strict `script-src 'self'` policy.

## Rules the engine owns
- **Every choice stays on the table.** `legalMoves` returns every move the roll allows: the tokens on the board that can take it, and — on a six — the tokens still in the starting box. Nothing is filtered behind the player's back.
- **Conditional automatic play.** `autoMoveToken` counts the player's tokens *on the board* (`activeTokens` — the starting box and the home triangle do not count). One token on the board and nothing left in the box moves by itself; two or more tokens on the board always ask; a six that could still deploy a token always asks, because deploying and moving are two different answers; a six with an empty board asks which token should come out. A six never deploys a token by itself. The client applies the move; the server still validates it.
- **The count is recalculated after every action.** Deploying, moving, capturing and reaching the centre all change how many tokens are on the board, so the next decision is always made from the current position — including for an opponent who has just lost a token to a capture.
- **Three sixes roll the table back.** `applyRoll` snapshots the table when the first six of a run is thrown. On the third six the snapshot is restored: a token brought out during the run returns to the box, a token that was moved returns to its exact square, and a capture made during the run never happened. Only that run is undone — the turn simply passes.
- **Bonus roll on a capture.** Landing on an opponent keeps the turn with the capturer, who rolls again.
- **The home lane walks.** Entering the lane grants nothing. The token steps in one square at a time, and it never leaps.
- **The home triangle pays.** A token that lands on the centre square earns the player one more move.
- **Long games.** `checkGameEnd` ends a two-player game at the first finisher and a three- or four-player game only when everyone has finished. `advanceTurn` skips players who have already finished.
- **Standings.** Finishers rank first in the order they finished; the rest rank by tokens home, then distance covered, then captures.

## Client architecture
- `public/app.js`: the whole client — state, dialogs, network, rendering, board motion, confetti and the profile card — organised into clearly separated sections.
- `public/profile.js`: the local profile card. A small, dependency-free module that reads and writes two `localStorage` keys — `parcheesi.profile` (name, statistics, recent matches) and `parcheesi.profile.photo` (a data URL). Photos are drawn to a canvas and re-encoded as a 256×256 JPEG so a picture can never fill the storage quota. Nothing is uploaded.
- Every prompt-shaped interaction uses a real `<dialog>`: the name sheet, the table setup sheet, the table menu, the profile sheet, and a reusable confirmation sheet. All of them resolve a promise, validate before closing, and restore focus to whatever opened them.
- The board is redrawn as SVG on every change. Tokens are grouped so a moved token can be transitioned from its old cell to its new one, and a captured token animates back to its base.
- The board is a `.board-mount` with two siblings: the SVG canvas and the dice overlay. The overlay is positioned by a `data-seat` attribute and slides between the four home squares with a transition, so the die visibly travels to the player on turn. The mount is capped against the viewport height, so the whole board and the dice are always on screen together.
- The story of the game and the table's chat live in two separate panels. `renderGame` owns the story; the chat owns its own list, so a board redraw can never eat a message. Newest lines are scrolled into view.
- The home square of the player on turn is drawn as a two-tone frame — a near-black stroke under a player-coloured one — with a gentle pulse.
- The dice tumble while the authoritative result is in flight and land on the server's number.
- A full-screen canvas above the board throws confetti when a player finishes and a larger burst for the champion. It honours the reduced-motion preference.
- The client reconnects on its own with a backoff, reclaims the seat with the stored token, and shows its state in the connection pill.
- A live table survives the browser. On load the client looks for the last room it was given a token for and rejoins it automatically; a reconnect that lands on a running game returns to the game view instead of the lobby. A reload, an app switch or a screenshot never costs a seat.

## The design system
- `public/styles.css` is one organised stylesheet: foundations, themes, shell, controls, home, lobby, the table, the board, the result, dialogs, layers and responsive rules.
- The page is a dark parlour with one lit board in the middle of it. Warm brass accents on near-black, hairline borders with a single light edge, layered shadows, and a film of grain over the large dark fields.
- Display type is a serif stack that ships with the operating system; the interface is a system grotesque; the labels are a monospace in wide capitals. No web fonts and no third-party requests, so the strict `script-src 'self'` / `style-src 'self'` policy still holds.
- Three board themes — noir, classic and forest — repaint the board and the shell from the same tokens.

## Cloudflare deployment
- `src/worker/index.js`: Cloudflare Worker entry point and Durable Object RoomHub.
- `wrangler.jsonc`: static assets, Worker entry point, Durable Object binding, and SQLite migration.
- Workers Static Assets serves the frontend. SPA fallback supports direct opening of invitation URLs such as `/room/:invite`.
- The Worker handles `/health`, `/api/config`, and WebSocket upgrades at `/ws`.
- RoomHub is the authoritative multiplayer coordinator. It validates room membership, lobby readiness, host actions, turn ownership, and moves; generates dice server-side; persists room snapshots in Durable Object SQLite storage; and broadcasts updates.
- WebSocket attachments associate live connections with their room/player, including across Durable Object hibernation.

## Node self-hosting
- `src/server/`: conventional HTTP routes, WebSocket framing, room lifecycle, and local JSON persistence.
- `data/`: runtime JSON room snapshots for the Node server only.
- `Dockerfile`: container build for a persistent Node host.

## Protocol
- Every server message carries a monotonic `sequence` that advances on each state change. Clients discard older frames so a slow connection cannot resurrect a stale board.
- Invitation codes are eight readable characters; seat tokens remain long random bearer credentials.
- The game snapshot now includes the finishing order and the pending bonus token, so every client ranks the table identically.

## Deployment characteristics
- Cloudflare initially uses one globally named RoomHub Durable Object. It is persistent but not yet sharded per room.
- The encrypted Node backup is not imported by Cloudflare. The Cloudflare room store starts empty.
- Node and Cloudflare deployments have separate room stores and do not synchronize.
- The profile card is browser-local in every deployment. There is no server-side profile storage to migrate or secure.
