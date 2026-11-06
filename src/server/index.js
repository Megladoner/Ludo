'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { acceptUpgrade } = require('./websocket');
const rooms = require('./rooms');
const ROOT = path.resolve(__dirname, '../../public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
const hits = new Map();
function clientIp(req) { if (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim(); return req.socket.remoteAddress || 'unknown'; }
function rateLimit(req, res) {
  const ip = clientIp(req), now = Date.now(); const record = hits.get(ip) || { start: now, count: 0 };
  if (now - record.start > 60_000) { record.start = now; record.count = 0; }
  record.count++; hits.set(ip, record);
  if (record.count > 180) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"Rate limit exceeded"}'); return false; }
  return true;
}
const server = http.createServer((req, res) => {
  if (!rateLimit(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, service: 'parcheesi', time: Date.now() })); return; }
  if (req.method === 'GET' && url.pathname === '/api/config') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ publicUrl: process.env.PUBLIC_URL || `http://${req.headers.host}` })); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/ludo' ) { res.writeHead(307, { location: '/ludo/' }); res.end(); return; }
  if (pathname === '/chess') { res.writeHead(307, { location: '/chess/' }); res.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/ludo/' || /^\/room\/[a-zA-Z0-9_-]+$/.test(pathname)) pathname = '/ludo/index.html';
  else if (pathname === '/chess/' || /^\/chess\/(local|computer|room\/[A-Za-z0-9_-]+)\/?$/.test(pathname)) pathname = '/chess/index.html';
  else if (pathname.endsWith('/')) pathname += 'index.html';
  const chessPage = pathname.startsWith('/chess/');
  if (pathname === '/engine.js') pathname = '/../src/engine/ludo.js';
  const file = path.resolve(ROOT, `.${pathname}`);
  const allowed = file.startsWith(ROOT + path.sep) || file === path.resolve(ROOT, '../src/engine/ludo.js');
  if (!allowed) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'${chessPage ? " 'wasm-unsafe-eval'" : ''}; worker-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  });
});
const liveConnections = new Map();
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) { socket.destroy(); return; } } catch { socket.destroy(); return; } }
  if (!req.headers['sec-websocket-key'] || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const ip = clientIp(req); const count = liveConnections.get(ip) || 0;
  if (count >= 12 || new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  liveConnections.set(ip, count + 1);
  acceptUpgrade(req, socket, head, (p, msg) => rooms.handle(p, msg), (p) => { rooms.disconnect(p); const n = (liveConnections.get(ip) || 1) - 1; if (n <= 0) liveConnections.delete(ip); else liveConnections.set(ip, n); });
});
setInterval(rooms.cleanup, 60_000).unref();
server.listen(PORT, HOST, () => console.log(`PARCHEESI listening on http://${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
