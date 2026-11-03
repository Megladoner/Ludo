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

## Weighted score
| Category | Score | Evidence / remaining gap |
|---|---:|---|
| Visual design and product experience | 16/20 | Cohesive dark visual system, original SVG board, responsive layout; no full customization studio or motion/audio polish |
| Rules and gameplay correctness | 16/20 | Deterministic engine and core rules covered; alternate rules, blockades, and complete long-game simulations remain |
| Online multiplayer and invitations | 16/20 | Real independent clients, private invites, lobby, server dice/moves, reconnect, host migration; no public matchmaking, multi-instance persistence, or rematch |
| AI, local play, and features | 6/10 | Local pass-and-play and heuristic AI; no deep search, profiles, statistics, or public queue |
| Responsive design and mobile usability | 8/10 | Desktop and 390px mobile browser smoke test; tablet/landscape and assistive-technology testing incomplete |
| Performance, reliability, and security | 7/10 | No-dependency server, secure randomness, validation, basic rate limits; single-process JSON storage and no production TLS/DB hardening |
| Code quality, accessibility, and testing | 8/10 | Modular engine/server/client, docs, 15 tests, keyboard-operable moves; broader E2E, screen-reader, and load tests remain |
| Total | 77/100 | 7.7/10 |

## Final verdict
Passes the requested 7.0 threshold as an early playable MVP, not as the entire product vision. The core private-room multiplayer flow is real and independently tested against the server. This build should not be described as a finished public gaming service until persistence, operational security, public matchmaking, account/profile features, and the remaining UX scope are implemented.
