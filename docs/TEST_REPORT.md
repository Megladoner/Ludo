# Test report

## Automated results
Last verified in the supplied environment (Node.js 22.19.0):

- `npm run check`: passed. Every source file passes `node --check`, the browser engine is byte-for-byte identical to the shared engine, and the page ships no inline scripts or inline styles.
- `npm test`: **36 tests passed, 0 failed.** Verified on five consecutive runs with no flakes.

### Engine and protocol coverage
- Board geometry: a gap-free ring of 52 unique cells, safe start squares, and every colour's home-lane entry aligned with its final shared-track cell.
- Rules: six releases a token, a non-six with no move passes the turn, a six with no legal move also passes the turn, three sixes forfeit the turn, an exact roll is required to finish, the first player with all four tokens home wins, and the winner keeps the turn so the result screen reads correctly.
- Captures: landing on an opponent on an ordinary square sends it home; safe squares protect.
- Forfeits: removing a player hands the turn on safely whether they were on turn, ahead of it, or last in the ring.
- Standings: ranking by tokens home, then distance covered, then captures.
- AI: every difficulty tier returns a legal move, the ruthless tier takes a capture the relaxed tier walks past, and AI names are unique.
- Invitation codes: 200 generated codes contain no look-alike characters, and every alphabet character survives normalisation.

### Multiplayer integration
Two independent WebSocket clients against a separately spawned server, covering room creation, invitation join, ready state, host disconnect with deterministic host migration, seat-token reconnection, start authorization, wrong-turn rejection, server-generated dice, legal token movement, matching authoritative sequence and state on both clients, renaming, host removal, and seat release on leave.

The suite previously matched incoming frames on message type alone, so a stale frame from the other player's turn could satisfy a wait. It now tracks the server's monotonic `sequence` and discards frames older than the last one consumed, which removed the flake at its root rather than papering over it.

### Browser verification
Headless Chromium (Playwright) drives the real application against the real server over a real WebSocket — no asset injection and no stubbed transport.

- **33-check interface suite**: every dialog opens, validates, cancels, and confirms; the name sheet replaces the old browser prompt; the setup sheet replaces the old player-count prompt; dice produce a face; tokens are selected and moved; the table menu and confirmation sheet work; an invalid invitation shows an inline error and keeps the sheet open; the theme previews live and persists; Escape closes a sheet; the mobile board renders; and no uncaught page errors occur.
- **19-check multiplayer suite**: two browsers create and join a room, sync readiness, start together, agree on whose turn it is, move a token, stay in sync, exchange chat, show an unread badge, and handle one player leaving mid-game without deadlocking the turn.
- Board fitting was verified at 1440×950, 1920×1080 and 1280×800 — the whole board and the dice controls are on screen without scrolling.

## Environment limitations
- PostgreSQL, Redis, Docker, and deployment credentials were not available. Database integration, external vulnerability scanning, and a hosted deployment were not performed.
- The Worker was verified by unit tests and a dry-run build, not by running on Cloudflare. The Node server implements the same protocol and was exercised directly.
- Screen-reader testing and a complete four-player game played to victory by hand were not executed; keyboard operability of token selection and of every sheet was verified in the browser.
- Tablet-specific layouts and landscape phone orientation were not exercised.

No unexecuted check is described as passed.
