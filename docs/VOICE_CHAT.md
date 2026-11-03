# Optional room voice chat

- The room creator may enable voice chat when creating a room. It defaults OFF and is immutable for that room.
- Voice controls appear in the lobby and game only for enabled online rooms.
- Each player must explicitly enable their own microphone. They can mute only themselves; there is no remote-mute control.
- Speaking players receive a glowing marker and animated audio bars.
- Computer and pass-and-play modes do not initialize voice or request microphone access.
- Cloudflare Durable Object WebSocket relays SDP/ICE only between authenticated room members. Audio is peer-to-peer WebRTC using a public STUN endpoint.
- No paid media provider, TURN relay, secret, new binding, or migration is configured. STUN-only connectivity is best-effort; some networks require TURN and may not connect.
