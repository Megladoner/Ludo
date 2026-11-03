# Optional room voice chat

- Room creator can enable voice at creation; default is OFF and immutable for the room.
- Voice UI is shown only for enabled online rooms. Computer and pass-and-play modes never request microphone access.
- Each player must explicitly enable their own microphone. They can mute only themselves; there is no remote mute control.
- Speaking state is shown with a glowing player marker and animated audio bars.
- Cloudflare Durable Object WebSocket relays SDP/ICE only between authenticated room members. Audio is peer-to-peer WebRTC using a public STUN endpoint.
- No paid media provider, TURN relay, secret, new binding, or migration is configured. STUN-only connectivity is best-effort; some networks require TURN and may not connect.
