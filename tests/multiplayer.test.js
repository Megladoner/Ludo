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
    update = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'roll');
    currentRoom = update.room;
    assert.ok(update.event.roll >= 1 && update.event.roll <= 6);
    sawPendingMove = update.room.state.awaitingMove;
  }
  assert.equal(sawPendingMove, true, 'a six eventually offers a move');

  activeClient.send({ type: 'game.move', token: 0 });
  const moved = await activeClient.wait((m) => m.type === 'game.update' && m.event.type === 'move');
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

test('voice chat is opt-in per room and only relays connection messages to the right players', async (t) => {
  const port = 3189;
  await startServer(t, port);

  // A room created without the voice switch refuses every voice message.
  const quietHost = await openClient(t, port);
  quietHost.send({ type: 'room.create', name: 'Quiet' });
  const quiet = await quietHost.wait((m) => m.type === 'room.created');
  assert.equal(quiet.room.voice, false);
  quietHost.send({ type: 'voice.state', phase: 'announce', joined: true });
  const refused = await quietHost.wait((m) => m.type === 'room.error');
  assert.match(refused.error, /voice chat is off/i);

  // Only a literal true switches voice on.
  const sloppy = await openClient(t, port);
  sloppy.send({ type: 'room.create', name: 'Sloppy', voice: 'yes' });
  assert.equal((await sloppy.wait((m) => m.type === 'room.created')).room.voice, false);

  // A room created with the switch relays voice messages.
  const host = await openClient(t, port);
  const guest = await openClient(t, port);
  const third = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Host', voice: true });
  const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.room.voice, true);
  guest.send({ type: 'room.join', invite: created.invite, name: 'Guest' });
  const guestJoined = await guest.wait((m) => m.type === 'room.joined');
  assert.equal(guestJoined.room.voice, true);
  third.send({ type: 'room.join', invite: created.invite, name: 'Third' });
  await third.wait((m) => m.type === 'room.joined');
  const hostId = created.room.players[0].id;
  const guestId = guestJoined.room.players[1].id;

  // A broadcast reaches the other two players but not the sender.
  host.send({ type: 'voice.state', phase: 'announce', joined: true, muted: false });
  const heardByGuest = await guest.wait((m) => m.type === 'voice.state');
  const heardByThird = await third.wait((m) => m.type === 'voice.state');
  for (const heard of [heardByGuest, heardByThird]) {
    assert.equal(heard.from, hostId);
    assert.equal(heard.phase, 'announce');
    assert.equal(heard.joined, true);
    assert.equal(typeof heard.sequence, 'undefined', 'voice frames never disturb the room sequence');
  }

  // A signal goes only to the player it is addressed to, and says who it is from.
  guest.send({ type: 'voice.signal', to: hostId, kind: 'offer', sid: 'abc', sdp: 'v=0' });
  const signal = await host.wait((m) => m.type === 'voice.signal');
  assert.deepEqual({ from: signal.from, kind: signal.kind, sid: signal.sid, sdp: signal.sdp }, { from: guestId, kind: 'offer', sid: 'abc', sdp: 'v=0' });
  await assert.rejects(third.wait((m) => m.type === 'voice.signal', 400), /Timed out/);

  // Malformed signals are rejected, and nobody can address themselves or a stranger.
  guest.send({ type: 'voice.signal', to: hostId, kind: 'hack', sdp: 'v=0' });
  assert.match((await guest.wait((m) => m.type === 'room.error')).error, /invalid voice/i);
  guest.send({ type: 'voice.signal', to: hostId, kind: 'offer', sdp: 'x'.repeat(20001) });
  assert.match((await guest.wait((m) => m.type === 'room.error')).error, /invalid voice/i);
  guest.send({ type: 'voice.signal', to: 'nobody', kind: 'offer', sdp: 'v=0' });
  await assert.rejects(host.wait((m) => m.type === 'voice.signal', 400), /Timed out/);

  // Nothing in the protocol lets one player mute another: the relayed state is always the sender's own.
  third.send({ type: 'voice.state', phase: 'update', joined: true, muted: true, from: hostId });
  const own = await host.wait((m) => m.type === 'voice.state');
  assert.notEqual(own.from, hostId);
});

test('token colours are chosen per player, stay unique, and are locked once the game starts', async (t) => {
  const port = 3193;
  await startServer(t, port);
  const host = await openClient(t, port);
  const guest = await openClient(t, port);
  host.send({ type: 'room.create', name: 'Amy', skin: 'purple' });
  const created = await host.wait((m) => m.type === 'room.created');
  assert.equal(created.room.players[0].skin, 'purple');
  guest.send({ type: 'room.join', invite: created.invite, name: 'Bo', skin: 'purple' });
  const joined = await guest.wait((m) => m.type === 'room.joined');
  const guestSkin = joined.room.players[1].skin;
  assert.notEqual(guestSkin, 'purple', 'a taken colour is never handed out twice');
  guest.send({ type: 'lobby.skin', skin: 'purple' });
  await guest.wait((m) => m.type === 'room.error');
  guest.send({ type: 'lobby.skin', skin: 'teal' });
  const snap = await host.wait((m) => m.type === 'room.snapshot' && m.room.players[1].skin === 'teal');
  assert.equal(snap.room.players[1].color, 'green', 'the seat never changes with the colour');
  guest.send({ type: 'lobby.ready', ready: true });
  await host.wait((m) => m.type === 'room.snapshot' && m.room.players[1].ready);
  host.send({ type: 'lobby.start' });
  await host.wait((m) => m.type === 'game.started');
  guest.send({ type: 'lobby.skin', skin: 'pink' });
  await guest.wait((m) => m.type === 'room.error');
});
