# Voice chat

A table of friends can talk while they play. The audio goes **straight from one browser to the next** — the game server carries the small handshake that opens the line and never sees a sound.

## Turning it on

- The host who opens a table may leave **Voice chat** switched on. It is on by default and can be turned off when the table is created.
- Every player opens their **own** microphone. Nobody else's microphone can be opened or muted by anyone else, and the microphone is never opened without a click.
- **Hold `V`** to push to talk. It works even when you are muted, so the table hears you only when you mean to speak.
- The button in the top bar mutes and unmutes. **Voice chat** in the table menu turns the microphone off completely.
- Beside each name a small marker shows who is talking, who has gone quiet, and who has left the voice.
- Computer and pass-and-play modes never initialise voice and never ask for a microphone.

## How the line is opened

The browser speaks WebRTC to the other browsers. The game server only relays six small messages — `hello`, `here`, `offer`, `answer`, `ice` and `state` — and refuses an unknown kind, a seat that is not at the table, a payload over 8 KB and any traffic from a table that turned voice off.

Two details keep the handshake steady. The seat earlier in the table opens the line, so the two browsers never offer at the same time. And every message carries a session stamp, so a player who closes and reopens their microphone starts a clean line instead of inheriting a stale one.

## The relay, and what it costs

A direct line is enough for most networks. For players behind strict mobile or corporate networks a **TURN relay** is needed, because they cannot be reached directly.

Cloudflare's managed TURN has a free allowance of **1,000 GB a month** — roughly 71,000 relayed hours of voice, which a casual table will never reach. Turning it on is two Worker secrets and nothing else:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

The key stays on the server. The Worker mints a short-lived credential (12 hours) for each table that asks, and hands only that to the browser. Without the secret, `GET /api/voice/ice` answers with Cloudflare's free STUN server alone and voice still works for most players.

No paid media provider, billing account or third-party script is involved, and nothing in this feature can raise a bill.
