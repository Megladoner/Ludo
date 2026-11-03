# Browser verification

Two Playwright harnesses that drive the **real** application in a headless browser against the **real** server over a **real** WebSocket. Nothing is stubbed or injected, so they catch the class of bug where the interface looks right but the transport is broken.

They exist because of the bugs this project actually shipped with: a malformed WebSocket URL that meant multiplayer never connected at all, a join flow that closed its dialog before it knew whether the invitation worked, and a seat that was never released when a player left mid-game.

## Requirements

```bash
pip install playwright
playwright install chromium      # or set CHROME_PATH to an existing Chromium
```

## Running

Both scripts start the Node server themselves on `PORT` (default `3399`) and reuse one if it is already listening.

```bash
python3 tools/browser-smoke.py        # 33 checks: every dialog, both local modes, settings, mobile
python3 tools/browser-multiplayer.py  # 19 checks: two browsers, one table
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3399` | Port for the local server |
| `CHROME_PATH` | *(Playwright's own)* | Path to a Chromium binary |
| `SHOT_DIR` | `artifacts/screenshots` | Where screenshots are written |

Each script prints a `PASS`/`FAIL` line per check and exits non-zero if anything failed.
