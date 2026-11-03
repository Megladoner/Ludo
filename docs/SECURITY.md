# Security notes

- Dice are generated on the server with Node's cryptographic random generator; clients never submit dice values or complete game states.
- Each player seat has a random bearer token. Keep it private; it is returned only to that seat and omitted from public room snapshots.
- Room invitations are separate random tokens. They permit lobby entry, not impersonation of an existing seat. They are eight readable characters drawn from an alphabet without look-alikes; entry normalises case and ignores punctuation, so codes can be dictated over a phone without granting any extra access.
- Leaving a table releases the seat immediately and forfeits the tokens that player still held. A dropped socket instead keeps the seat for the grace period so a brief interruption does not cost a player their place.
- The server validates room membership, host authority, turn ownership, legal moves, payload size, WebSocket origin, and basic action/connection rates.
- TRUST_PROXY is disabled by default. Enable it only behind a trusted proxy that overwrites forwarded client-address headers.
- Runtime room persistence contains private seat tokens. Restrict access to data/rooms.json, back it up securely, and do not commit it.
- The page ships no inline scripts or inline styles, so it satisfies a strict `script-src 'self'` / `style-src 'self'` policy. `npm run check` enforces this.
- Display names are stripped of control characters and angle brackets on both the client and the server, and every name is escaped before it reaches the DOM.
- The profile card is browser-local by design. Names, statistics and photos are written to `localStorage` and are never sent to the server, so there is no profile store to breach and no cross-user data to leak. A photo is redrawn to a 256×256 JPEG before it is stored, which keeps it well inside the browser's storage quota and stops a huge upload from being cached.
- The seat name is escaped before it reaches the DOM, and the server applies the same cleaning to names it receives.
- Use HTTPS/WSS in production. Configure the reverse proxy to preserve WebSocket upgrades and set the public host consistently.

This is an early MVP security baseline, not a formal penetration test. Before public launch, add dependency and infrastructure scanning, structured audit logs, abuse monitoring, stronger per-IP controls at the edge, secret rotation, backup/restore drills, and an independent security review.
