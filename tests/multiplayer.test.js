'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// A client that only ever hands back frames it has not already consumed.
// Matching on type alone lets a stale frame from the other player's turn
// satisfy the wait, which is what made this suite flaky.
function makeClient(url) {
  const ws = new WebSocket(url), queue = [], waiters = [];
  let consumed = -1;
  const fresh = (message) => typeof message.sequence !== 'number' || message.sequence > consumed;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!fresh(message)) return;
    const index = waiters.findIndex((waiter) => waiter.test(message));
    if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; consumed = Math.max(consumed, message.sequence ?? consumed); waiter.resolve(message); }
    else queue.push(message);
  });
  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)); },
    wait(testFn, timeout = 5000) {
      const index = queue.findIndex((message) => fresh(message) && testFn(message));
      if (index >= 0) {
        const message = queue.splice(index, 1)[0];
        consumed = Math.max(consumed, message.sequence ?? consumed);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const waiter = { test: testFn, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('Timed out waiting for multiplayer event'));
        }, timeout);
        waiter.resolve = (message) => { clearTimeout(timer); consumed = Math.max(consumed, message.sequence ?? consumed); resolve(message); };
      });
    },
  };
}

async function startServer(t, port) {
  const server = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROOM_TTL_HOURS: '1' },
    stdio: 'ignore',
  });
  t.after(() => server.kill('SIGTERM'));
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'server should start');
  return server;
}

async function openClient(t, port) {
  const client = makeClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => { try { client.ws.close(); } catch {} });
  await new Promise((resolve, reject) => {
    client.ws.addEventListener('open', resolve, { once: true });
    client.ws.addEventListener('error', reject, { once: true });
  });
  return client;
}

test('independent clients support invitations, readiness, host migration, reconnect, and synchronized legal moves', async (t) => {
  const port = 3187;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);

  host.send({ type: 'room.create', name: 'Host' });
  const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.playerColor, 'red');
  assert.equal(created.room.players.length, 1);
  assert.match(created.invite, /^[A-HJ-KM-NP-Z2-9]{8}$/, 'invitation codes stay easy to read aloud');

  guest.send({ type: 'room.join', invite: created.invite.toLowerCase(), name: 'Guest' });
  const joined = await guest.wait((m) => m.type === 'room.joined');
  assert.equal(joined.playerColor, 'green');
  assert.equal(joined.room.players.length, 2);
  assert.equal(Object.hasOwn(joined.room.players[0], 'token'), false);

  guest.send({ type: 'lobby.ready', ready: true });
  await host.wait((m) => m.type === 'room.snapshot' && m.room.players[1]?.ready === true);

  const guestSeatId = joined.room.players[1].id;
  host.ws.close();
  const migrated = await guest.wait((m) => m.type === 'room.snapshot' && m.room.host === guestSeatId);
  assert.equal(migrated.room.players[0].connected, false);

  const returningHost = await openClient(t, port);
  returningHost.send({ type: 'room.join', invite: created.invite, playerToken: created.playerToken, name: 'Host' });
  const rejoined = await returningHost.wait((m) => m.type === 'room.joined');
  assert.equal(rejoined.playerColor, 'red');
  assert.equal(rejoined.room.host, guestSeatId);

  guest.send({ type: 'lobby.start' });
  const started = await guest.wait((m) => m.type === 'game.started');
  assert.equal(started.room.status, 'playing');

  guest.send({ type: 'game.roll' });
  const rejected = await guest.wait((m) => m.type === 'room.error');
  assert.match(rejected.error, /not your turn/i);

  // Only the player on turn may roll; walk the game forward one legal roll at a time.
  let activeClient = returningHost;
  let update;
  let currentRoom = started.room;
  let sawPendingMove = false;
  for (let attempt = 0; attempt < 48 && !sawPendingMove; attempt++) {
    const activeColor = currentRoom.state.players[currentRoom.state.currentPlayer].id;
    activeClient = activeColor === 'red' ? returningHost : guest;
    activeClient.send({ type: 'game.roll' });
    // Both clients receive every update, so match only the one belonging to
    // the roll this client just made. Without that, a client can pick up the
    // other player's older update and lose the thread.
    update = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'roll' && m.event.player === activeColor);
    currentRoom = update.room;
    assert.ok(update.event.roll >= 1 && update.event.roll <= 6);
    sawPendingMove = update.room.state.awaitingMove;
  }
  assert.equal(sawPendingMove, true, 'a six eventually offers a move');

  const movingColor = currentRoom.state.players[currentRoom.state.currentPlayer].id;
  activeClient.send({ type: 'game.move', token: 0 });
  const moved = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'move' && m.event.player === movingColor);
  const otherClient = activeClient === returningHost ? guest : returningHost;
  const mirrored = await otherClient.wait((m) => m.type === 'game.update' && m.sequence === moved.sequence);
  const moverColor = moved.event.player;
  assert.equal(moved.room.state.players.find((p) => p.id === moverColor).tokens[0], 0);
  assert.equal(mirrored.room.sequence, moved.room.sequence);
});

test('a player may rename their seat and the host may remove another player', async (t) => {
  const port = 3188;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);

  host.send({ type: 'room.create', name: 'Host' });
  const created = await host.wait((m) => m.type === 'room.created');
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  const joined = await guest.wait((m) => m.type === 'room.joined');

  guest.send({ type: 'lobby.rename', name: 'Renamed Guest' });
  const renamed = await host.wait((m) => m.type === 'room.snapshot' && m.room.players[1]?.name === 'Renamed Guest');
  assert.equal(renamed.room.players[1].name, 'Renamed Guest');

  const guestId = joined.room.players[1].id;
  host.send({ type: 'lobby.kick', playerId: guestId });
  const trimmed = await host.wait((m) => m.type === 'room.snapshot' && m.room.players.length === 1);
  assert.equal(trimmed.room.players.length, 1);
  assert.equal(trimmed.room.players[0].name, 'Host');
});

test('leaving a table releases the seat for everyone else', async (t) => {
  const port = 3189;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);

  host.send({ type: 'room.create', name: 'Host' });
  const created = await host.wait((m) => m.type === 'room.created');
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  await guest.wait((m) => m.type === 'room.joined');

  guest.send({ type: 'room.leave' });
  const trimmed = await host.wait((m) => m.type === 'room.snapshot' && m.room.players.length === 1);
  assert.equal(trimmed.room.players.length, 1);
  assert.equal(trimmed.room.players[0].name, 'Host');
});

// --- Voice chat ---------------------------------------------------------------

test('room voice can be turned off, and the room says so', async (t) => {
  const port = 3190;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Host', voiceEnabled: false });
  const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.room.voiceEnabled, false);
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  const joined = await guest.wait((m) => m.type === 'room.joined');
  assert.equal(joined.room.voiceEnabled, false);
});

test('voice signalling is relayed only to the seat it was addressed to', async (t) => {
  const port = 3191;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Host', voiceEnabled: true });
  const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.room.voiceEnabled, true);
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  const joined = await guest.wait((m) => m.type === 'room.joined');
  const data = { type: 'offer', sdp: 'test-session-description' };
  host.send({ type: 'voice.signal', kind: 'offer', to: 'green', data });
  const relayed = await guest.wait((m) => m.type === 'voice.signal');
  assert.equal(relayed.kind, 'offer');
  assert.equal(relayed.from, 'red');
  assert.deepEqual(relayed.data, data);
});

test('a room that turned voice off refuses the handshake', async (t) => {
  const port = 3192;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Host', voiceEnabled: false });
  const created = await host.wait((m) => m.type === 'room.created');
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  await guest.wait((m) => m.type === 'room.joined');
  host.send({ type: 'voice.signal', kind: 'offer', to: 'green', data: { type: 'offer', sdp: 'not-allowed' } });
  const rejected = await host.wait((m) => m.type === 'room.error');
  assert.match(rejected.error, /voice chat is disabled/i);
});

test('a handshake for a seat that is not at the table is refused', async (t) => {
  const port = 3193;
  await startServer(t, port);
  const host = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Host' });
  await host.wait((m) => m.type === 'room.created');
  host.send({ type: 'voice.signal', kind: 'offer', to: 'yellow', data: { type: 'offer', sdp: 'nobody' } });
  const rejected = await host.wait((m) => m.type === 'room.error');
  assert.match(rejected.error, /not at this table/i);
});
