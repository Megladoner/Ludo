# Voice chat

Voice is **opt-in per room**. When the host creates a room, the name sheet has an **Enable voice chat** switch. It starts off. If it stays off, that room has no voice anywhere. Computer and pass & play games never show voice and never ask for a microphone.

## What players see

- A voice bar in the lobby and at the top of the Table Chat panel: **Join voice**, **Mute / Unmute**, **Leave**.
- A small badge on every player card: on voice, muted, connecting, or could not connect. When someone talks, the badge turns into moving bars and their colour dot glows. The bar also names who is talking.
- Nobody joins automatically and the microphone is only requested when a player taps **Join voice**.
- A player can mute only themselves. The server relays only each sender's own status, so nobody can mute anyone else.

## How it works

Audio goes straight between the players' browsers over WebRTC. The server only passes small connection messages and never sees a sound. Nothing is recorded or stored.

| Message | Payload | Notes |
| --- | --- | --- |
| `room.create` | `voice: true` | Only a literal `true` turns voice on. |
| `voice.state` | `phase` (`announce`, `reply`, `update`), `joined`, `muted`, `to?` | Relayed to the other players, or only to `to`. Always stamped with the sender's seat id as `from`. |
| `voice.signal` | `to`, `kind` (`offer`, `answer`), `sid`, `sdp` | Relayed only to `to`. SDP is limited to 20,000 characters. |

Voice frames carry no `sequence`, so they never disturb room ordering. They have their own rate limit (120 per 10 seconds), separate from game actions. A room created without voice rejects every voice message.

Of every pair of players, the one whose seat id sorts first makes the offer, so two browsers never offer at once. Network addresses are bundled into the offer or answer, so a call needs only two small messages.

## Networks

Free public STUN servers are used (`ICE_SERVERS` at the top of `public/voice.js`). Some strict mobile or school networks need a TURN relay as well; add one to that list if friends report they cannot hear each other.

## Tests

`npm test` covers the relay rules. `python3 tools/browser-voice.py` runs three real Chromium players with fake microphones and real WebRTC between them.
