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
