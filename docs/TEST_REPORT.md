# Test report

## Automated results
Last verified in the supplied environment (Node.js 22.19.0):

- `npm run check`: passed. Every source file passes `node --check`, the browser engine is byte-for-byte identical to the shared engine, and the page ships no inline scripts or inline styles.
- `npm test`: **52 tests passed, 0 failed.** Verified on five consecutive runs with no flakes.

### Engine and protocol coverage
- Board geometry: a gap-free ring of 52 unique cells, safe start squares, and every colour's home-lane entry aligned with its final shared-track cell.
- Rules: six releases a token, a non-six with no move passes the turn, a six with no legal move also passes the turn, three sixes forfeit the turn, an exact roll is required to finish, the first player with all four tokens home wins, and the winner keeps the turn so the result screen reads correctly.
- Bonus roll on a capture: the capturer keeps the turn, rolls again rather than moving again, and the capture is counted.
- Bonus move in the home lane: entering the lane flags the token, keeps the same die, leaves a move pending, locks the legal move to that token, and passes the turn once the bonus is spent. A home-lane entry whose bonus move lands home ends the game.
- Automatic play: a lone token with a single legal move is played for the player; a player with two tokens out is asked to choose; the bonus token is always preferred.
- Long games: with three players the table plays on after the first finisher and the finishing order ranks the table; with two players the game ends at the first finisher.
- Forfeits: removing a player hands the turn on safely whether they were on turn, ahead of it, or last in the ring.
- Standings: finishers first in finishing order, then by tokens home, distance covered and captures.
- AI: every difficulty tier returns a legal move, the ruthless tier takes a capture the relaxed tier walks past, and AI names are unique.
- Invitation codes: 200 generated codes contain no look-alike characters, and every alphabet character survives normalisation.

### Multiplayer integration
Two independent WebSocket clients against a separately spawned server, covering room creation, invitation join, ready state, host disconnect with deterministic host migration, seat-token reconnection, start authorization, wrong-turn rejection, server-generated dice, legal token movement, matching authoritative sequence and state on both clients, renaming, host removal, and seat release on leave.

The suite previously matched incoming frames on message type alone, so a stale frame from the other player's turn could satisfy a wait. It now tracks the server's monotonic `sequence` and discards frames older than the last one consumed, which removed the flake at its root rather than papering over it.

### Browser verification
Headless Chromium (Playwright) drives the real application against the real server over a real WebSocket — no asset injection and no stubbed transport.

- **33-check interface suite** (`tools/browser-smoke.py`): every dialog opens, validates, cancels, and confirms; the name sheet replaces the old browser prompt; the setup sheet replaces the old player-count prompt; dice produce a face; tokens are selected and moved; the table menu and confirmation sheet work; an invalid invitation shows an inline error and keeps the sheet open; the theme previews live and persists; Escape closes a sheet; the mobile board renders; and no uncaught page errors occur.
- **40-check feature suite** (`tools/browser-features.py`): the die sits in the first player's home square and transfers to the next player's, and visibly moves across the board; the active home square is outlined, the outline follows the player on turn, lands on the correct home square, measures at least 4px on screen, and cycles with the turns; a single deployed token moves by itself; two deployed tokens hand the choice back to the player; a token in the home lane gets a second move and then passes the turn; a capture sends the opponent home, keeps the turn with the capturer, and is recorded; the table plays on after a finisher; confetti is thrown and the result screen names the champion and ranks the finishers; the match is recorded against the computer as a win; the profile sheet opens with its stat cards and computer/friends breakdown; a photo can be uploaded, stored locally and removed; the name is remembered; the history is listed; and the profile can be cleared.
- **21-check multiplayer suite** (`tools/browser-multiplayer.py`): two browsers create and join a room, sync readiness, start together, agree on whose turn it is, show the die in the same home square and frame the same home square on both screens, move a token, stay in sync, exchange chat, show an unread badge, and handle one player leaving mid-game without deadlocking the turn.
- Board fitting was verified at 1440×950, 1920×1080 and 1280×800 — the whole board and the dice controls are on screen without scrolling.

**Total: 52 unit tests and 94 browser checks, all passing.**

## Environment limitations
- PostgreSQL, Redis, Docker, and deployment credentials were not available. Database integration, external vulnerability scanning, and a hosted deployment were not performed.
- The Worker was verified by unit tests and a dry-run build, not by running on Cloudflare. The Node server implements the same protocol and was exercised directly.
- Screen-reader testing and a complete four-player game played to victory by hand were not executed; keyboard operability of token selection and of every sheet was verified in the browser.
- Tablet-specific layouts and landscape phone orientation were not exercised.
- The localStorage quota for the profile photo was not measured at the browser limit; photos are constrained to a 256×256 JPEG to stay well inside it.

No unexecuted check is described as passed.
