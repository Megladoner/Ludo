'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { initialState, applyRoll, applyMove, removePlayer } = require('../engine/ludo');
const DATA_DIR = path.join(__dirname, '../../data');
const ROOM_FILE = path.join(DATA_DIR, 'rooms.json');
const TTL_MS = Number(process.env.ROOM_TTL_HOURS || 24) * 3600_000;
const GRACE_MS = Number(process.env.RECONNECT_GRACE_SECONDS || 120) * 1000;
// Unambiguous alphabet: no I, L, O, 0 or 1, so codes can be read aloud without confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rooms = new Map(), sockets = new Map(), eventRates = new WeakMap(), voiceRates = new WeakMap();
function token(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
function inviteCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}
function normalizeInvite(value) {
  return String(value || '').toUpperCase().split('').filter((ch) => CODE_ALPHABET.includes(ch)).join('');
}
function safeRoom(room) { return { invite: room.invite, status: room.status, host: room.host, createdAt: room.createdAt, voice: !!room.voice, players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, ready: p.ready, connected: p.connected, host: p.id === room.host })), state: room.state, sequence: room.sequence }; }
function persist() { fs.mkdirSync(DATA_DIR, { recursive: true }); const serializable = [...rooms.values()].map(r => ({ ...r, peers: undefined })); const tmp = ROOM_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(serializable)); fs.renameSync(tmp, ROOM_FILE); }
function restore() { try { const data = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8')); for (const r of data) { r.peers = new Map(); for (const player of r.players) { player.connected = false; player.disconnectedAt = Date.now(); } rooms.set(r.invite, r); } } catch {} }
function emit(room, message) { for (const peer of room.peers.values()) peer.send({ sequence: room.sequence, ...message }); }
function migrateHost(room) { const current = room.players.find(p => p.id === room.host); if (current?.connected) return; const successor = room.players.find(p => p.connected) || room.players[0]; if (successor) room.host = successor.id; }
function snapshot(room) { emit(room, { type: 'room.snapshot', room: safeRoom(room) }); }
function cleanName(value) {
  // Strip control characters and angle brackets without relying on literal escapes.
  const printable = String(value || 'Player').split('').filter((ch) => { const code = ch.codePointAt(0); return code > 31 && code !== 127; }).join('');
  return printable.replace(/[<>]/g, '').trim().slice(0, 20) || 'Player';
}
function createRoom(peer, name, voice) {
  const invite = inviteCode(8), playerToken = token(24), id = crypto.randomUUID();
  const room = { id, invite, host: id, status: 'lobby', createdAt: Date.now(), updatedAt: Date.now(), voice: voice === true, players: [{ id, token: playerToken, name: cleanName(name), color: 'red', ready: true, connected: true, disconnectedAt: null }], state: null, sequence: 0, peers: new Map() };
  rooms.set(invite, room); attach(room, room.players[0], peer); migrateHost(room); persist();
  peer.send({ type: 'room.created', sequence: room.sequence, invite, playerToken, playerColor: room.players[0].color, room: safeRoom(room) });
}
function attach(room, player, peer) { const old = room.peers.get(player.id); if (old && old !== peer) old.close(4001); room.peers.set(player.id, peer); player.connected = true; player.disconnectedAt = null; sockets.set(peer, { room, player }); }
function joinRoom(peer, invite, playerToken, name) {
  const room = rooms.get(normalizeInvite(invite)); if (!room || Date.now() - room.createdAt > TTL_MS) throw new Error('Invitation is invalid or expired');
  let player = room.players.find(p => p.token === playerToken);
  if (!player) { if (room.status !== 'lobby') throw new Error('Game already started; use your original seat link to reconnect'); if (room.players.length >= 4) throw new Error('Room is full'); player = { id: crypto.randomUUID(), token: token(24), name: cleanName(name), color: ['red', 'green', 'yellow', 'blue'][room.players.length], ready: false, connected: true, disconnectedAt: null }; room.players.push(player); }
  attach(room, player, peer); migrateHost(room); room.sequence++; room.updatedAt = Date.now(); persist();
  peer.send({ type: 'room.joined', sequence: room.sequence, invite: room.invite, playerToken: player.token, playerColor: player.color, room: safeRoom(room) }); snapshot(room);
}
// Voice chat only relays small connection messages between players. The audio itself
// travels directly between the players' browsers and never passes through the server.
function voiceRelay(room, player, msg) {
  if (!room.voice) throw new Error('Voice chat is off for this table');
  let target = null;
  if (msg.to !== undefined && msg.to !== null) {
    target = room.players.find(p => p.id === msg.to);
    if (!target || target.id === player.id) return;
  }
  let out;
  if (msg.type === 'voice.signal') {
    if (!target) return;
    if (msg.kind !== 'offer' && msg.kind !== 'answer') throw new Error('Invalid voice message');
    if (typeof msg.sdp !== 'string' || msg.sdp.length > 20000) throw new Error('Invalid voice message');
    out = { type: 'voice.signal', from: player.id, kind: msg.kind, sdp: msg.sdp, sid: String(msg.sid || '').slice(0, 40) };
  } else {
    const phase = ['announce', 'reply', 'update'].includes(msg.phase) ? msg.phase : 'update';
    out = { type: 'voice.state', from: player.id, phase, joined: !!msg.joined, muted: !!msg.muted };
  }
  const recipients = target ? [target] : room.players.filter(p => p.id !== player.id);
  for (const other of recipients) { const socket = room.peers.get(other.id); if (socket) socket.send(out); }
}
function playerContext(peer) { const ctx = sockets.get(peer); if (!ctx) throw new Error('Join a room first'); return ctx; }
function handle(peer, msg) {
  try {
    const now = Date.now(), isVoice = !!msg && typeof msg.type === 'string' && msg.type.startsWith('voice.');
    const rates = isVoice ? voiceRates : eventRates, rate = rates.get(peer) || { start: now, count: 0 };
    if (now - rate.start > 10_000) { rate.start = now; rate.count = 0; } rate.count++; rates.set(peer, rate);
    if (rate.count > (isVoice ? 120 : 50)) throw new Error('Too many actions. Please slow down.');
    if (!msg || typeof msg.type !== 'string') throw new Error('Invalid message');
    if (msg.type === 'room.create') return createRoom(peer, msg.name, msg.voice);
    if (msg.type === 'room.join') return joinRoom(peer, msg.invite, msg.playerToken, msg.name);
    const { room, player } = playerContext(peer);
    if (msg.type === 'voice.state' || msg.type === 'voice.signal') return voiceRelay(room, player, msg);
    if (msg.type === 'lobby.ready') { if (room.status !== 'lobby') throw new Error('Lobby is closed'); player.ready = !!msg.ready; room.sequence++; }
    else if (msg.type === 'lobby.rename') { const next = cleanName(msg.name); if (!next) throw new Error('Name cannot be empty'); player.name = next; room.sequence++; }
    else if (msg.type === 'lobby.kick') {
      if (player.id !== room.host) throw new Error('Only the host can remove a player');
      const target = room.players.find(p => p.id === msg.playerId);
      if (!target) throw new Error('That player is not at this table');
      if (target.id === room.host) throw new Error('The host cannot be removed');
      const targetPeer = room.peers.get(target.id);
      room.players = room.players.filter(p => p.id !== target.id);
      if (targetPeer) { targetPeer.send({ type: 'room.kicked' }); targetPeer.close(1000); sockets.delete(targetPeer); room.peers.delete(target.id); }
      room.sequence++;
    }
    else if (msg.type === 'lobby.start') {
      if (player.id !== room.host) throw new Error('Only the host can start the game');
      if (room.status !== 'lobby') throw new Error('Game already started');
      if (room.players.length < 2) throw new Error('At least two players are required');
      if (room.players.some(p => !p.ready)) throw new Error('Everyone must be ready');
      room.state = initialState({ players: room.players.map(p => p.color), names: Object.fromEntries(room.players.map(p => [p.color, p.name])) });
      room.status = 'playing'; room.sequence++; emit(room, { type: 'game.started', sequence: room.sequence, room: safeRoom(room) }); return;
    } else if (msg.type === 'game.roll') {
      if (room.status !== 'playing') throw new Error('Game is not active');
      if (room.state.players[room.state.currentPlayer].id !== player.color) throw new Error('It is not your turn');
      const roll = crypto.randomInt(1, 7); room.state = applyRoll(room.state, roll); room.sequence++;
      emit(room, { type: 'game.update', sequence: room.sequence, room: safeRoom(room), event: { type: 'roll', player: player.color, roll } }); return;
    } else if (msg.type === 'game.move') {
      if (room.status !== 'playing') throw new Error('Game is not active');
      if (room.state.players[room.state.currentPlayer].id !== player.color) throw new Error('It is not your turn');
      if (!Number.isInteger(msg.token) || msg.token < 0 || msg.token > 3) throw new Error('Invalid token');
      room.state = applyMove(room.state, msg.token); room.sequence++; if (room.state.status === 'finished') room.status = 'finished';
      emit(room, { type: 'game.update', sequence: room.sequence, room: safeRoom(room), event: { type: 'move', player: player.color, token: msg.token } }); return;
    } else if (msg.type === 'game.rematch') {
      if (room.status !== 'finished') throw new Error('The game is still running');
      room.state = null; room.status = 'lobby';
      for (const seated of room.players) seated.ready = false;
      room.sequence++;
    } else if (msg.type === 'game.state') { peer.send({ type: 'room.snapshot', sequence: room.sequence, room: safeRoom(room) }); return; }
    else if (msg.type === 'room.leave') {
      // An explicit leave releases the seat. A dropped socket keeps the seat for the grace period instead.
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.state) removePlayer(room.state, player.color);
      room.sequence++;
      sockets.delete(peer); room.peers.delete(player.id);
      if (!room.players.length) rooms.delete(room.invite);
      else { migrateHost(room); room.updatedAt = Date.now(); }
      persist(); if (room.players.length) snapshot(room);
      return;
    }
    else if (msg.type === 'chat.send') { const body = String(msg.text || '').trim().slice(0, 240); if (!body) return; emit(room, { type: 'chat.message', player: player.name, color: player.color, text: body, sequence: ++room.sequence }); return; }
    else if (msg.type === 'room.close') {
      if (player.id !== room.host) throw new Error('Only the host can close the room');
      room.status = 'closed'; for (const connectedPeer of room.peers.values()) { connectedPeer.send({ type: 'room.closed' }); connectedPeer.close(1000); sockets.delete(connectedPeer); }
      room.peers.clear(); rooms.delete(room.invite); persist(); return;
    } else throw new Error('Unknown action');
    room.updatedAt = Date.now(); persist(); snapshot(room);
  } catch (error) { peer.send({ type: 'room.error', error: error.message || 'Request failed' }); }
}
function disconnect(peer) {
  const ctx = sockets.get(peer); if (!ctx) return; const { room, player } = ctx; sockets.delete(peer);
  if (room.peers.get(player.id) === peer) { room.peers.delete(player.id); player.connected = false; player.disconnectedAt = Date.now(); migrateHost(room); room.sequence++; room.updatedAt = Date.now(); persist(); snapshot(room); }
}
function cleanup() {
  const now = Date.now();
  for (const [invite, room] of rooms) {
    const expired = now - room.createdAt > TTL_MS;
    const abandoned = room.players.every(p => !p.connected && p.disconnectedAt && now - p.disconnectedAt > GRACE_MS) && room.status !== 'playing';
    if (expired || abandoned) { for (const peer of room.peers.values()) { peer.send({ type: 'room.closed' }); peer.close(1000); sockets.delete(peer); } room.peers.clear(); rooms.delete(invite); }
  }
  persist();
}
restore();
module.exports = { handle, disconnect, cleanup, safeRoom, inviteCode, normalizeInvite, CODE_ALPHABET };
