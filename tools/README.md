# Browser verification

Three Playwright harnesses that drive the **real** application in a headless browser against the **real** server over a **real** WebSocket. Nothing is stubbed or injected, so they catch the class of bug where the interface looks right but the transport is broken.

They exist because of the bugs this project actually shipped with: a malformed WebSocket URL that meant multiplayer never connected at all, a join flow that closed its dialog before it knew whether the invitation worked, a seat that was never released when a player left mid-game, and a settings sheet that could never close because a helper function had been lost in a rewrite.

## Requirements

```bash
pip install playwright
playwright install chromium      # or set CHROME_PATH to an existing Chromium
```

## Running

Each script starts the Node server itself on `PORT` (default `3399`) and reuses one if it is already listening.

```bash
python3 tools/browser-smoke.py        # 33 checks: every dialog, both local modes, settings, mobile
python3 tools/browser-features.py     # 40 checks: the travelling die, the turn frame, the rules, the profile
python3 tools/browser-multiplayer.py  # 21 checks: two browsers, one table
```

`browser-features.py` drives the table precisely by reaching into the page's own engine and stubs the dice, so a check about "one token plays itself" is about the real behaviour rather than a lucky roll.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3399` | Port for the local server |
| `CHROME_PATH` | *(Playwright's own)* | Path to a Chromium binary |
| `SHOT_DIR` | `artifacts/screenshots` | Where screenshots are written |
| `FIXTURE_DIR` | `artifacts/fixtures` | Where the test photo fixture is written |

Each script prints a `PASS`/`FAIL` line per check and exits non-zero if anything failed.
