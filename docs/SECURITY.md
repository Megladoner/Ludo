# Security notes

- Dice are generated on the server with Node's cryptographic random generator; clients never submit dice values or complete game states.
- Each player seat has a random bearer token. Keep it private; it is returned only to that seat and omitted from public room snapshots.
- Room invitations are separate random tokens. They permit lobby entry, not impersonation of an existing seat.
- The server validates room membership, host authority, turn ownership, legal moves, payload size, WebSocket origin, and basic action/connection rates.
- TRUST_PROXY is disabled by default. Enable it only behind a trusted proxy that overwrites forwarded client-address headers.
- Runtime room persistence contains private seat tokens. Restrict access to data/rooms.json, back it up securely, and do not commit it.
- Use HTTPS/WSS in production. Configure the reverse proxy to preserve WebSocket upgrades and set the public host consistently.

This is an early MVP security baseline, not a formal penetration test. Before public launch, add dependency and infrastructure scanning, structured audit logs, abuse monitoring, stronger per-IP controls at the edge, secret rotation, backup/restore drills, and an independent security review.
