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

## Weighted score
| Category | Score | Evidence / remaining gap |
|---|---:|---|
| Visual design and product experience | 18/20 | Cohesive visual system, original SVG board, real dialogs, motion, podium, responsive layout; no customization studio |
| Rules and gameplay correctness | 17/20 | Deterministic engine, correct six handling, forfeits, standings; alternate rules and blockades remain |
| Online multiplayer and invitations | 18/20 | Two real browsers, readable codes, lobby, ready/rename/remove, server dice and moves, reconnect with backoff, rematch; no public matchmaking or multi-instance persistence |
| AI, local play, and features | 8/10 | Three difficulty tiers with distinct behaviour, named seats, pass-and-play; no deep search, profiles or statistics |
| Responsive design and mobile usability | 9/10 | Desktop, laptop, wide and 390px mobile verified in-browser; tablet and landscape untested |
| Performance, reliability, and security | 8/10 | No-dependency server, secure randomness, strict CSP, validation, rate limits, auto-reconnect; single-process JSON storage and no production TLS/DB hardening |
| Code quality, accessibility, and testing | 9/10 | Modular engine/server/client, live-region and focus handling, 36 unit tests plus 52 browser checks; screen-reader testing and load tests remain |
| Total | 87/100 | 8.7/10 |

## Final verdict
Passes the requested threshold with room to spare as a polished, independently verified MVP. The private-room multiplayer flow is real and now provably works end to end in two separate browsers against a live server — which it did not before this pass. This should still not be described as a finished public gaming service until persistence at scale, operational security, public matchmaking, and account features are implemented.
