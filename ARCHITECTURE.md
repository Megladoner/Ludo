# PARCHEESI — Architecture

## Shared game engine
- `src/engine/ludo.js`: deterministic game rules, standings, and AI heuristics for three difficulty tiers. The engine is versioned (`version: 2`) and carries `finishOrder`, `lastFinish`, and `bonusToken` alongside the classic fields.
- `public/engine.js`: browser-served copy of the shared engine. CI verifies it stays byte-for-byte synchronized with the source.
- `public/`: responsive PWA frontend, manifest, styles, icons, and offline shell.
- `public/boot.js`: restores the saved board theme before first paint. It lives in its own file rather than an inline script so the page stays free of inline code and satisfies a strict `script-src 'self'` policy.

## Rules the engine owns
- **Bonus roll on a capture.** Landing on an opponent keeps the turn with the capturer, who rolls again.
- **Bonus move in the home lane.** Entering the home lane sets `bonusToken` and leaves `awaitingMove` true with the same die. `legalMoves` then restricts the move to that one token. The bonus cannot chain: only the first home-lane entry grants it.
- **Automatic play.** `autoMoveToken` returns a token when the player has exactly one deployed token and exactly one legal move, and always prefers the bonus token. The client applies it; the server still validates the move.
- **Long games.** `checkGameEnd` ends a two-player game at the first finisher and a three- or four-player game only when everyone has finished. `advanceTurn` skips players who have already finished.
- **Standings.** Finishers rank first in the order they finished; the rest rank by tokens home, then distance covered, then captures.

## Client architecture
- `public/app.js`: the whole client — state, dialogs, network, rendering, board motion, confetti and the profile card — organised into clearly separated sections.
- `public/profile.js`: the local profile card. A small, dependency-free module that reads and writes two `localStorage` keys — `parcheesi.profile` (name, statistics, recent matches) and `parcheesi.profile.photo` (a data URL). Photos are drawn to a canvas and re-encoded as a 256×256 JPEG so a picture can never fill the storage quota. Nothing is uploaded.
- Every prompt-shaped interaction uses a real `<dialog>`: the name sheet, the table setup sheet, the table menu, the profile sheet, and a reusable confirmation sheet. All of them resolve a promise, validate before closing, and restore focus to whatever opened them.
- The board is redrawn as SVG on every change. Tokens are grouped so a moved token can be transitioned from its old cell to its new one, and a captured token animates back to its base.
- The board is a `.board-mount` with two siblings: the SVG canvas and the dice overlay. The overlay is positioned by a `data-seat` attribute and slides between the four home squares with a transition, so the die visibly travels to the player on turn.
- The home square of the player on turn is drawn as a two-tone frame — a near-black stroke under a player-coloured one — with a gentle pulse.
- The dice tumble while the authoritative result is in flight and land on the server's number.
- A full-screen canvas above the board throws confetti when a player finishes and a larger burst for the champion. It honours the reduced-motion preference.
- The client reconnects on its own with a backoff, reclaims the seat with the stored token, and shows its state in the connection pill.

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
