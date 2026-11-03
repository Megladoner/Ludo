# Deployment guide

## Supported deployment shape
Run PARCHEESI as one persistent Node.js process behind an HTTPS reverse proxy. The reverse proxy must preserve WebSocket upgrades. The current release stores rooms in data/rooms.json; therefore use one application instance and a persistent writable volume. Do not put this process on a serverless-only host or scale it horizontally.

## Local setup
```bash
node --version
cp .env.example .env
export HOST=0.0.0.0
export PORT=3000
export PUBLIC_URL=https://play.example.com
node src/server/index.js
```

Open http://localhost:3000. To exercise multiplayer, open the invitation link in a second browser profile or on another device.

## Production process
1. Provision a Linux host with Node.js 22 or newer.
2. Copy the project and create a persistent writable data directory.
3. Set HOST=127.0.0.1, PORT=3000, PUBLIC_URL=https://play.example.com, ROOM_TTL_HOURS=24, and RECONNECT_GRACE_SECONDS=120 in the process manager.
4. Run npm run check && npm test before deployment.
5. Start with npm start under systemd, PM2, or another process supervisor.
6. Terminate TLS at a trusted reverse proxy and proxy / plus /ws to the same Node process.
7. Back up data/rooms.json securely. It contains active room data and private seat-reconnection tokens; restrict file permissions and never publish it.

The server currently does not parse .env files automatically. Export environment variables in the shell or configure them in the process manager.

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

Configure HTTP-to-HTTPS redirection separately. Use a real domain and valid TLS certificate. The application checks WebSocket Origin against the request Host; keep the public host consistent.

## Database and scaling
There is no SQL database, ORM, Redis, or migration system in this release. Local JSON persistence is appropriate only for a single-instance early deployment. Before scaling, move rooms, player identities, game events, and statistics to a transactional database; add shared pub/sub; add durable idempotency and recovery; and perform a security review.

## PWA and offline use
The service worker caches the app shell and static engine assets. A local game can be played offline after the app shell has been installed/cached. Private rooms, invitations, and online play require a working network connection.
