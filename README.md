# PARCHEESI

A mobile-first Ludo platform with local play, AI opponents, private multiplayer rooms, real-time synchronization, and a local profile card that remembers your table.

## Deploy to Cloudflare Workers (GitHub-connected)

This repository is preconfigured for Cloudflare Workers. It serves the PWA from Workers Static Assets and runs multiplayer rooms on a Durable Object with persistent SQLite storage.

1. In Cloudflare, open **Workers & Pages** → **Create application** → **GitHub**.
2. Connect your GitHub account and select **Megladoner/Ludo**.
3. Set the Worker name to **parcheesi** (it must match `wrangler.jsonc`).
4. Set the production branch to **main**.
5. Leave the root directory as `/`.
6. Build command: leave blank. Deploy command: `npx wrangler deploy`.
7. Select **Save and Deploy**. Cloudflare will create the Durable Object SQLite namespace from the migration and publish the Worker.
8. Open the `workers.dev` URL shown by Cloudflare.

No environment variables, API keys, or manually created databases are required. Future pushes to `main` automatically trigger a new deployment.

## What works on the hosted URL

- Main game page and PWA assets
- Local pass-and-play (2–4 players) with a named seat for every player
- Solo play against AI at three difficulty tiers
- Private multiplayer rooms (2–4 players)
- Readable invitation codes and invite links, ready lobby, server-generated dice and server-validated moves
- Reconnection using the seat token stored in that browser, with automatic retry and backoff
- Live room snapshots, in-room chat, rename, host removal, and a rematch flow
- Room persistence in Durable Object storage
- A local profile card: matches played, won and lost, split between the computer and friends, with a name and a photo

The room database starts empty on the first Cloudflare deployment. Existing Node-hosted room links and reconnect tokens are not imported.

## The rules of this table

- **A six** releases a token from base. A six with nothing to move passes the turn.
- **A capture** — landing on an opponent outside a safe square — sends their token home and earns the capturer **another roll**.
- **The home lane** is worth more than a turn: a token that enters it gets **one more move with that very token**, on the same die. Only that token may move until the bonus is spent.
- **One token plays itself.** If a player has exactly one token on the board and exactly one legal move, it moves automatically. Bring out a second token and the choice comes back to you.
- **Three sixes** forfeit the turn.
- **Two players** end the game the moment the first player brings all four tokens home.
- **Three or four players** play on until everyone is home, so the table gets a full finishing order. The first player home is still the champion.

## The interface

Nothing uses a native browser prompt any more.

- **What should we call you?** — a proper sheet with a labelled field, a character counter, and a "Surprise me" suggestion. Used when opening a table, changing your seat, or setting your profile from the avatar.
- **How many players?** — a sheet with 2/3/4 seat cards showing the colours that will take part, a name field per seat, and — against the AI — a difficulty choice.
- **Your table card** — the avatar in the top bar opens a profile sheet: your name, a photo, matches played, won and lost, the split between the computer and friends, and a short history. It lives only in this browser — no account, no upload, nothing leaves the device.
- **Table menu** — the `•••` button opens copy-link, rules, sound, reduced motion, full screen, and leave.
- **Confirmations** — leaving a table or removing a player always asks first.

## The table itself

- **The die has a seat.** It sits in the free inner corner of the home square of whoever is on turn, and slides across the board as the turns change hands — on every screen, not just yours.
- **The home square of the player on turn is outlined** in a bold two-tone frame that pulses gently and moves with the turn.
- **The dice tumble**, land on the authoritative number, and ring when a token is picked.
- **Confetti** falls when a player brings every token home, and a bigger burst marks the champion.
- **The story so far** panel narrates each move, including captures and home-lane bonuses.

## Run locally with Node.js

Requires Node.js 22+.

```bash
npm install
npm run check
npm test
npm start
```

The Node server uses `src/server/` and persists room data in `data/rooms.json`. It is independent from Cloudflare's Durable Object room store.

## Quality gates

- `npm run check` — syntax-checks every source file, verifies the browser engine is byte-for-byte identical to the shared engine, and asserts the page ships no inline styles or inline scripts.
- `npm test` — engine rules, AI behaviour, invitation codes, and live multiplayer against the real WebSocket server.
- `python3 tools/browser-smoke.py`, `python3 tools/browser-features.py`, and `python3 tools/browser-multiplayer.py` — headless Chromium drives the real interface against the real server over a real WebSocket. See `tools/README.md`.

## Scope

Not yet implemented: public matchmaking, accounts, QR invites, alternate rulesets, token/dice customization, and any cross-device profile sync. The profile card is deliberately local to one browser.
