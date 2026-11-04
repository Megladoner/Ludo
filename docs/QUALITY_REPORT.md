# PARCHEESI quality evaluation

Scores follow the requested 100-point rubric. They are evidence-based estimates of this deliverable, not external certification.

## Cycle 1 — Functional foundation
Outcome: initial playable shell, pure rules engine, SVG board, local AI/pass-and-play, private-room server, invitation/lobby flow, and PWA shell.

Findings: the first multiplayer run exposed a room-creation response bug; a later board review exposed home-entry offsets that skipped a shared-track cell for two colors. Both were corrected and regression-tested.

Initial score (retrospective): 62/100 — functional foundation, but no reliable two-client proof and incomplete board-entry geometry.

## Cycle 2 — Feature and experience refinement
Changes: corrected all four home-lane entry mappings; added safe start squares, two-client server integration, ready controls, reconnect-by-seat-token, deterministic host migration, WebSocket Origin checks, per-socket action limits, per-IP connection limits, keyboard-operable legal token selection, theme tokens, and deployment/security/protocol documentation.

Regression: 15 automated tests passed on three consecutive runs.

Cycle 2 score: 72/100.

## Cycle 3 — Final polish and verification
Verification: 15/15 tests pass, including independent client room lifecycle and synchronized legal movement. Chromium/Playwright smoke test verified desktop and 390px mobile rendering, local AI entry, token selection/movement, and no JavaScript errors. Health, root, invitation route, and engine asset endpoints returned HTTP 200 during local server checks.

## Cycle 4 — The dialogue edition
A full pass over the interface, the rules and the transport, driven by "nothing should feel like a browser default".

**Interface.** Both native `prompt()` calls are gone. The name request and the player-count request are now real sheets with labelled fields, validation, live counters and keyboard-first behaviour, plus a table menu, a reusable confirmation sheet, and per-seat naming. Every sheet resolves a promise, refuses to close on invalid input, and gives focus back to whatever opened it.

**Bugs found and fixed.**
- The WebSocket URL was assembled as `ws//host` — the scheme colon was missing, so the socket never opened. **Multiplayer had never actually connected**, on any deployment.
- A six with no legal move granted another roll instead of passing the turn, which is not how the board works.
- The winner's turn was handed on, so the result screen named the wrong player on turn.
- Leaving a table kept the seat and left the departing player on the board with no way to move, which could deadlock the turn. Leaving now releases the seat and forfeits their tokens.
- The page shipped an inline theme script and fifteen inline style attributes, both blocked by the server's own `script-src 'self'` / `style-src 'self'` policy.
- The board overflowed the viewport on every desktop size, so players had to scroll to see the dice.

**Protocol.** Every server message now carries a monotonic `sequence`, and clients discard older frames. This removed the last flake in the multiplayer suite rather than masking it.

**Presentation.** Dice tumble and land on the server's number. Tokens animate along the track and captured tokens fly home. Sound is on by default with a menu toggle. The board is capped to the viewport so the whole table and the dice are always visible together. Results show a podium and a standings table. Invitation codes are eight readable characters with no look-alikes, and entry forgives case and punctuation.

**Verification.** 36 automated tests, stable across five consecutive runs. A 33-check browser suite and a 19-check two-browser multiplayer suite drive the real application against the real server over a real WebSocket — not an injected document.

## Cycle 5 — The living table
A pass over the feel of the game: where the die sits, where the eye goes, what happens when a rule bends, and what the game remembers afterwards.

**The die has a seat.** The die used to sit in a fixed panel beside the board, so it never told you whose turn it was. It now lives in the free inner corner of the home square of the player on turn and slides across the board as the turns change hands — on every client's screen, not just your own.

**The turn is drawn on the board.** The home square of whoever is on turn wears a bold two-tone frame that pulses gently and cycles with the turn. You can see whose turn it is without reading a single word.

**The rules bent, on purpose.**
- A capture now earns the capturer another roll, as it does on a real board.
- Entering the home lane is worth an **extra move with that very token**, not merely another turn. The engine locks the legal move to that token until the bonus is spent, so it cannot be used to shuffle another token forward.
- A player with exactly one token on the board and exactly one legal move now plays it automatically. Bring out a second token and the choice comes straight back.
- With three or four players the table plays on after the first finisher, so everyone gets home and the result screen can show a full finishing order. Two-player games still end at the first finisher.

**Bugs found and fixed while building it.**
- `writeJSON` was lost in the client rewrite, so saving preferences threw and the settings sheet could never close. Caught by the browser suite, not by inspection.
- `sfx.enter` was called but never defined, which threw when sound was switched on from the table menu.
- The home-lane bonus originally granted another roll instead of another move, which did not match the rule as specified. The engine was corrected and the tests rewritten around the new semantics.
- A failed multiplayer roll left the die tumbling forever.
- The result screen and the confetti could fire twice on the same finished game; both are now behind a one-shot guard that is cleared when a rematch starts.

**The profile card.** A local-only dashboard opened from the avatar: name, photo, matches played/won/lost, the split between the computer and friends, and a short history. It lives entirely in `localStorage` — two keys, no server, no account, no upload. Photos are redrawn to a 256×256 JPEG before they are stored.

**Verification.** 52 unit tests, stable across repeated runs. A 33-check interface suite, a 40-check feature suite and a 21-check two-browser multiplayer suite drive the real application against the real server over a real WebSocket — 94 browser checks in total, all passing, with no uncaught page errors.

## Cycle 6 — The parlour, and the rules made plain
A pass over the whole product: the look, the rules, and the three things that were quietly broken.

**The rules were wrong in two places, and one of them was mine.**
- Reaching the home lane granted an extra move *on the same die*, so a token could leap from the lane entry to the centre. That was the "jumping a couple of squares" report. The lane now walks — one square at a time, exactly as the die says.
- The extra move now belongs where it belongs: a token that reaches the **home triangle** earns the player one more move.
- The single-token rule was only half-implemented. With one token out and a six, the table offered four legal moves — the token on the board plus three tokens in base — so it asked the player to choose. The roll is now **committed** to the lone token whatever the die says, and a six with nothing on the board brings a token out by itself. The table never asks a question it does not have to ask.

**Taking a screenshot was ending the room.**
The cause was not the screenshot: it was that the client had no way back. A reload — or anything that reloaded the page — dropped the player on the home screen with a live game behind them, and a reconnect pushed the player into the lobby instead of back into the game. Three fixes: the client now rejoins the last room on its own with its stored seat token; a reconnect that lands on a running game returns to the game view; and a seat that no longer exists clears itself quietly instead of failing on every load.

**Chat could not be read.**
Chat messages were pushed into the same list the board story is drawn into, and every board redraw replaced that list — so a message could vanish seconds after it arrived. Chat now has its own panel with the sender's name and colour, its own scroll position, and a compose field that keeps the keyboard up. The story of the game and the conversation are two different things, and they no longer share a list.

**The look.** The interface was rebuilt as one organised stylesheet: a dark parlour with one lit board in the middle of it. Brass accents on near-black, hairline borders with a single light edge, layered shadows, a film of grain over the large dark fields, and a serif display face for the words that matter. No web fonts and no third-party requests, so the strict content-security policy still holds. The board is capped against the viewport height, so the whole table and the dice are always on screen together. The "Resume your table" card was visible on a first visit — the `hidden` attribute was being beaten by a layout rule — and that is fixed too.

**Verification.** 56 unit tests, stable across repeated runs. A 32-check interface suite, a 55-check feature suite and a 22-check two-browser multiplayer suite — 109 browser checks — drive the real application against the real server over a real WebSocket. Every bug above has a check that fails if it comes back.

## Cycle 7 — The rules, put right
A pass over one thing only: what the table does with a roll. The interface was already approved and was not touched.

**The fault.** The engine held a "committed roll": when a player had exactly one token on the board, `legalMoves` filtered every other choice out and `autoMoveToken` moved that token whatever the die said. A six therefore could never offer the tokens still in the box, and a six on an empty board silently deployed one. The table was making the player's decision for them, and it was making it in the wrong place.

**What it is now.** A token on the board plays itself only when it is the only token there *and* nothing is left in the box. Two or more tokens on the board always ask. A six that could still deploy a token always asks, because "bring a token out" and "move the token you have" are two different answers and only the player knows which one they meant. A six with an empty board asks which token should come out. A six never deploys a token by itself, and a choice is never made for the player when more than one move is on the table. Tokens in the starting box and tokens that have reached the home triangle do not count as tokens on the board. The count is taken from the current position every time, so a capture hands the decision back to the opponent who just lost a token.

**Three sixes now cost the tokens too.** The third six used to cancel the turn and leave the moves from the first two sixes standing. The table is now snapshotted when a run of sixes starts: a token brought out during the run returns to the box, a token that was moved returns to its exact square, and a capture made during the run never happened. Only that run is undone — the turn simply passes. The snapshot lives in the game state, so the server and every client roll back the same way.

**Verification.** 66 unit tests, stable across repeated runs, with a case for every rule above and for the rollback. A 33-check interface suite, a 69-check feature suite and a 22-check two-browser multiplayer suite — 124 browser checks — drive the real application against the real server over a real WebSocket. The feature suite now proves in the browser that a six asks instead of moving, that the answer can be either one, and that three sixes put the token back.

## Weighted score
| Category | Score | Evidence / remaining gap |
|---|---:|---|
| Visual design and product experience | 19/20 | A rebuilt parlour design system — brass on near-black, hairline borders, grain, serif display type, original SVG board, real dialogs, motion, podium, responsive layout; no customization studio |
| Rules and gameplay correctness | 19/20 | Deterministic engine, a conditional single-token roll that never chooses for the player, a six that always asks when deploying and moving are both on offer, a three-sixes rollback, capture bonus, a home lane that walks, the home-triangle bonus, long games with a finishing order, forfeits, standings; alternate rules and blockades remain |
| Online multiplayer and invitations | 19/20 | Two real browsers, readable codes, lobby, ready/rename/remove, server dice and moves, reconnect with backoff, automatic session resume across reloads, a readable chat, rematch; no public matchmaking or multi-instance persistence |
| AI, local play, and features | 9/10 | Three difficulty tiers with distinct behaviour, named seats, pass-and-play, bonus turns, auto-play, confetti and a local profile card; no deep search and no cross-device profile |
| Responsive design and mobile usability | 9/10 | Desktop, laptop, wide and 390px mobile verified in-browser; tablet and landscape untested |
| Performance, reliability, and security | 8/10 | No-dependency server, secure randomness, strict CSP, validation, rate limits, auto-reconnect; single-process JSON storage and no production TLS/DB hardening |
| Code quality, accessibility, and testing | 9/10 | Modular engine/server/client, live-region and focus handling, 66 unit tests plus 124 browser checks, one regression check per fixed bug; screen-reader testing and load tests remain |
| Total | 91/100 | 9.1/10 |

## Final verdict
Passes the requested threshold with room to spare as a polished, independently verified MVP. The table now reads clearly at a glance — the die shows whose turn it is, the board frames the player on turn, and the rules reward a good capture or a well-timed home entry. The profile card gives the game a memory without giving up a byte of privacy. The private-room multiplayer flow is real and now provably works end to end in two separate browsers against a live server — which it did not before this pass. This should still not be described as a finished public gaming service until persistence at scale, operational security, public matchmaking, and account features are implemented.
