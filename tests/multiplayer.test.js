'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
function makeClient(url) {
  const ws = new WebSocket(url), queue = [], waiters = [];
  ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); const index = waiters.findIndex((waiter) => waiter.test(message)); if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else queue.push(message); });
  return { ws, send(message) { ws.send(JSON.stringify(message)); }, wait(testFn, timeout = 3000) {
    const index = queue.findIndex(testFn); if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const waiter = { test: testFn, resolve }; waiters.push(waiter); const timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); reject(new Error('Timed out waiting for multiplayer event')); }, timeout); waiter.resolve = (message) => { clearTimeout(timer); resolve(message); }; });
  } };
}
test('independent clients support invitations, readiness, host migration, reconnect, and synchronized legal moves', async (t) => {
  const port = 3187;
  const server = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROOM_TTL_HOURS: '1' }, stdio: 'ignore' });
  t.after(() => server.kill('SIGTERM'));
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) { ready = true; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(ready, true, 'server should start');
  const host = makeClient(`ws://127.0.0.1:${port}/ws`), guest = makeClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => { host.ws.close(); guest.ws.close(); });
  await Promise.all([new Promise((resolve, reject) => { host.ws.addEventListener('open', resolve, { once: true }); host.ws.addEventListener('error', reject, { once: true }); }), new Promise((resolve, reject) => { guest.ws.addEventListener('open', resolve, { once: true }); guest.ws.addEventListener('error', reject, { once: true }); })]);
  host.send({ type: 'room.create', name: 'Host' }); const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.playerColor, 'red'); assert.equal(created.room.players.length, 1);
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' }); const joined = await guest.wait((m) => m.type === 'room.joined');
  assert.equal(joined.playerColor, 'green'); assert.equal(joined.room.players.length, 2); assert.equal(Object.hasOwn(joined.room.players[0], 'token'), false);
  guest.send({ type: 'lobby.ready', ready: true }); await host.wait((m) => m.type === 'room.snapshot' && m.room.players[1]?.ready === true);
  const guestSeatId = joined.room.players[1].id; host.ws.close();
  const migrated = await guest.wait((m) => m.type === 'room.snapshot' && m.room.host === guestSeatId); assert.equal(migrated.room.players[0].connected, false);
  const returningHost = makeClient(`ws://127.0.0.1:${port}/ws`); t.after(() => returningHost.ws.close());
  await new Promise((resolve, reject) => { returningHost.ws.addEventListener('open', resolve, { once: true }); returningHost.ws.addEventListener('error', reject, { once: true }); });
  returningHost.send({ type: 'room.join', invite: created.invite, playerToken: created.playerToken, name: 'Host' }); const rejoined = await returningHost.wait((m) => m.type === 'room.joined');
  assert.equal(rejoined.playerColor, 'red'); assert.equal(rejoined.room.host, guestSeatId);
  guest.send({ type: 'lobby.start' }); const started = await guest.wait((m) => m.type === 'game.started'); assert.equal(started.room.status, 'playing');
  guest.send({ type: 'game.roll' }); const rejected = await guest.wait((m) => m.type === 'room.error'); assert.match(rejected.error, /not your turn/i);
  let activeClient = returningHost, update, currentRoom = started.room;
  for (let attempt = 0; attempt < 48; attempt++) { const activeColor = currentRoom.state.players[currentRoom.state.currentPlayer].id; activeClient = activeColor === 'red' ? returningHost : guest; activeClient.send({ type: 'game.roll' }); update = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'roll'); currentRoom = update.room; assert.ok(update.event.roll >= 1 && update.event.roll <= 6); if (update.room.state.awaitingMove) break; }
  assert.equal(update.room.state.awaitingMove, true);
  activeClient.send({ type: 'game.move', token: 0 }); const moved = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'move');
  const otherClient = activeClient === returningHost ? guest : returningHost; const mirrored = await otherClient.wait((m) => m.type === 'game.update' && m.sequence === moved.sequence);
  const moverColor = moved.event.player; assert.equal(moved.room.state.players.find((p) => p.id === moverColor).tokens[0], 0); assert.equal(mirrored.room.sequence, moved.room.sequence);
});
