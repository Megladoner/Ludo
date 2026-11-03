# Deployment guide

## Cloudflare Workers (recommended)

The repository is configured for a one-click Git-connected Worker deployment. No terminal commands, environment variables, API keys, or manually created database are required for the dashboard flow.

1. Open Cloudflare Dashboard → **Workers & Pages** → **Create application** → **GitHub**.
2. Connect GitHub and select `Megladoner/Ludo`.
3. Worker name: `parcheesi` (must match `wrangler.jsonc`).
4. Production branch: `main`.
5. Root directory: `/`.
6. Build command: leave blank.
7. Deploy command: `npx wrangler deploy`.
8. Select **Save and Deploy** and wait for the deployment to finish.
9. Open the `workers.dev` URL Cloudflare provides.

Cloudflare provisions the Durable Object SQLite namespace from the migration in `wrangler.jsonc`. Static files in `public/` are served by Workers Static Assets. The Worker handles `/health`, `/api/config`, and `/ws`; SPA fallback serves invite routes such as `/room/INVITECODE`.

After connecting the repository, pushes to `main` trigger deployments automatically.

### Cloudflare runtime details

- `src/worker/index.js` is the Worker entry point.
- `RoomHub` coordinates multiplayer WebSockets and persists room snapshots in Durable Object SQLite storage.
- The current first-release topology uses one globally named RoomHub. This is simple and keeps all rooms coordinated, but is not yet sharded per room.
- The first Cloudflare deployment starts with an empty room store. Existing Node `data/rooms.json` and `data/rooms.json.enc` are not imported. Existing invitation links and seat tokens therefore do not transfer.
- The Node and Cloudflare deployments use separate room stores and do not synchronize.
- Cloudflare account limits and pricing apply.

### Voice chat — the optional relay

Voice chat works out of the box: the browsers connect directly to one another over Cloudflare's free STUN service, and the audio never touches the Worker.

A **TURN relay** is only needed for players on strict mobile or corporate networks, where a direct line cannot be opened. Cloudflare's managed TURN carries a free allowance of **1,000 GB a month** — roughly 71,000 relayed hours of voice, which a casual table will never reach. Adding it takes about two minutes and costs nothing inside that allowance:

1. Open **Cloudflare Dashboard → Realtime → TURN** and create a TURN key.
2. Create an API token with permission to use the TURN key (`Realtime TURN — Edit`).
3. Store both as Worker secrets:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

The key never reaches a browser. The Worker mints a short-lived credential (12 hours) for each table that asks and hands that to the client. Without the secrets, `GET /api/voice/ice` answers with STUN only and voice still works for most players.

The Node deployment takes the same two values as environment variables.

### Smoke test after deployment

Open the Worker URL in two different browsers or browser profiles:
1. In browser A, choose **Create a room**.
2. Copy the invite link and open it in browser B.
3. Join with a player name, then mark both players ready.
4. Start the game, roll dice, move tokens, and send a chat message.
5. Refresh browser B and use the same browser profile to verify its seat token reconnects.

Also test **Play vs AI** and **Pass & play** from the home page. The `/health` endpoint should return JSON with `ok: true`.

## Self-host with Node.js

The original Node server remains available. Requires Node.js 22+.

```bash
npm install
npm run check
npm test
npm start
```

It uses a persistent writable `data/` directory and a reverse proxy that preserves WebSocket upgrades. See the Nginx example below.

## Example Nginx location

```nginx
server {
    listen 443 ssl http2;
    server_name play.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```
