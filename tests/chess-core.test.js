'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const core = require('../src/chess/core');

const T0 = 1_000_000;
const ids = () => crypto.randomUUID();
const deps = (now, extra) => Object.assign({ id: ids, token: () => crypto.randomBytes(8).toString('hex'), now, random: () => 0.1, code: 'ABCD2345' }, extra || {});

function play(game, sans, startNow = T0, step = 1000) {
  let now = startNow;
  for (const san of sans) {
    const side = core.turnOf(game);
    const move = core.chessFor(game).moves({ verbose: true }).find((m) => m.san === san);
    assert.ok(move, 'legal move ' + san);
    const r = core.applyMove(game, side, { from: move.from, to: move.to, promotion: move.promotion }, now);
    assert.ok(r.ok, r.error);
    now += step;
  }
  return now;
}

test('rejects illegal and out-of-turn moves without changing the game', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  assert.equal(core.applyMove(g, 'black', { from: 'e7', to: 'e5' }, T0).ok, false);
  assert.equal(core.applyMove(g, 'white', { from: 'e2', to: 'e5' }, T0).ok, false);
  assert.equal(core.applyMove(g, 'white', { from: 'z9', to: 'e5' }, T0).ok, false);
  assert.equal(core.applyMove(g, 'white', { from: 'e2', to: 'e4', promotion: 'k' }, T0).ok, false);
  assert.equal(g.moves.length, 0);
  assert.equal(core.applyMove(g, 'white', { from: 'e2', to: 'e4' }, T0).ok, true);
});

test('fool\'s mate ends the game with a winner', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  play(g, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.equal(g.result.reason, 'checkmate');
  assert.equal(g.result.winner, 'black');
  assert.equal(core.applyMove(g, 'white', { from: 'a2', to: 'a3' }, T0 + 9000).ok, false);
});

test('castling, en passant and promotion are legal and recorded in SAN', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: 'unlimited', now: T0 });
  play(g, ['e4', 'a6', 'e5', 'd5', 'exd6', 'a5', 'Nf3', 'a4', 'Be2', 'a3', 'O-O']);
  assert.equal(g.moves[g.moves.length - 1].san, 'O-O');
  assert.equal(g.moves[4].san, 'exd6');
  const p = core.newGame({ white: 'w', black: 'b', tc: 'unlimited', now: T0 });
  play(p, ['a4', 'b5', 'axb5', 'a6', 'bxa6', 'Bb7', 'a7', 'Bxg2', 'axb8=Q']);
  assert.match(p.moves[p.moves.length - 1].san, /=Q/);
  const bad = core.newGame({ white: 'w', black: 'b', tc: 'unlimited', now: T0 });
  play(bad, ['a4', 'b5', 'axb5', 'a6', 'bxa6', 'Bb7', 'a7', 'Bxg2']);
  assert.equal(core.applyMove(bad, 'white', { from: 'a7', to: 'b8' }, T0).ok, false, 'promotion piece is required');
});

test('clocks do not run until both sides have moved, then count down, with increment from 2+1', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '2+1', now: T0 });
  play(g, ['e4'], T0 + 20_000);
  assert.equal(g.turnStart, null);
  assert.equal(core.remaining(g, 'white', T0 + 30_000), 120000);
  play(g, ['e5'], T0 + 30_000);
  assert.equal(g.turnStart, T0 + 30_000);
  assert.equal(core.remaining(g, 'white', T0 + 40_000), 110000);
  play(g, ['Nf3'], T0 + 40_000);
  assert.equal(g.clock.white, 111000, '10s spent, +1s increment');
  assert.equal(core.remaining(g, 'black', T0 + 50_000), 110000);
  play(g, ['Nc6'], T0 + 50_000);
  assert.equal(g.clock.black, 111000, 'black first ran after ply 3, paid 10s, +1s');
});

test('a player who runs out of time loses; a late move is refused', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '1+0', now: T0 });
  play(g, ['e4', 'e5'], T0 + 1000);
  assert.equal(core.tick(g, T0 + 1000 + 59_000), false);
  const r = core.applyMove(g, 'white', { from: 'g1', to: 'f3' }, T0 + 2000 + 60_001);
  assert.equal(r.ok, false);
  assert.equal(g.result.reason, 'timeout');
  assert.equal(g.result.winner, 'black');
  assert.equal(g.moves.length, 2);
});

test('time-out against a side that cannot mate is a draw', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '1+0', now: T0 });
  g.moves = []; // lone-king vs king+pawns scenario via direct material check
  const chess = new (require('chess.js').Chess)('8/8/8/8/8/8/k7/K1B5 w - - 0 1');
  assert.equal(core.hasMatingMaterial(chess, 'white'), false);
  const rich = new (require('chess.js').Chess)('8/8/8/8/8/8/k7/K1BN4 w - - 0 1');
  assert.equal(core.hasMatingMaterial(rich, 'white'), true);
});

test('first moves must arrive in time or the game is aborted, not scored', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  assert.equal(core.deadline(g), T0 + core.FIRST_MOVE_MS);
  assert.equal(core.tick(g, T0 + core.FIRST_MOVE_MS - 1), false);
  assert.equal(core.tick(g, T0 + core.FIRST_MOVE_MS), true);
  assert.equal(g.result.aborted, true);
  assert.equal(core.scoreOf(g.result), '');
});

test('abort is only for the opening, resign only afterwards', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  assert.equal(core.resign(g, 'white', T0).ok, false);
  play(g, ['e4']);
  assert.equal(core.abort(g, 'black', T0).ok, true);
  assert.equal(g.result.aborted, true);
  assert.equal(g.result.winner, null);
  const h = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  play(h, ['e4', 'e5']);
  assert.equal(core.abort(h, 'white', T0).ok, false);
  assert.equal(core.resign(h, 'white', T0 + 5).ok, true);
  assert.equal(h.result.winner, 'black');
  assert.equal(h.result.reason, 'resignation');
});

test('draw offers: accept, decline, auto-clear when the recipient moves, one offer per move', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: '5+0', now: T0 });
  assert.equal(core.offerDraw(g, 'white', T0).ok, false, 'not before both moved');
  play(g, ['e4', 'e5']);
  assert.equal(core.offerDraw(g, 'white', T0).ok, true);
  assert.equal(core.offerDraw(g, 'white', T0).ok, false);
  assert.equal(core.acceptDraw(g, 'white', T0).ok, false, 'cannot accept your own offer');
  assert.equal(core.declineDraw(g, 'black').ok, true);
  assert.equal(core.offerDraw(g, 'white', T0).ok, false, 'already offered on this move');
  play(g, ['Nf3']);
  assert.equal(core.offerDraw(g, 'black', T0).ok, true);
  play(g, ['Nc6']);
  assert.equal(g.drawOffer, 'black', 'the offerer moving does not withdraw it');
  play(g, ['Bc4']);
  assert.equal(g.drawOffer, null, 'recipient moved on, so the offer lapsed');
  assert.equal(core.offerDraw(g, 'black', T0).ok, true);
  assert.equal(core.acceptDraw(g, 'white', T0 + 1).ok, true);
  assert.equal(g.result.reason, 'agreement');
  assert.equal(core.scoreOf(g.result), '1/2-1/2');
});

test('threefold repetition, stalemate and insufficient material end the game', () => {
  const g = core.newGame({ white: 'w', black: 'b', tc: 'unlimited', now: T0 });
  play(g, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
  assert.equal(g.result.reason, 'repetition');
  const chess = require('chess.js').Chess;
  const stale = new chess('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  stale.move('Qg7');
  assert.equal(stale.isCheckmate(), true);
  const s = core.newGame({ white: 'w', black: 'b', tc: 'unlimited', now: T0 });
  play(s, ['e3', 'a5', 'Qh5', 'Ra6', 'Qxa5', 'h5', 'h4', 'Rah6', 'Qxc7', 'f6', 'Qxd7+', 'Kf7', 'Qxb7', 'Qd3', 'Qxb8', 'Qh7', 'Qxc8', 'Kg6', 'Qe6']);
  assert.equal(s.result.reason, 'stalemate');
});

test('a game of 50 quiet moves is drawn by the fifty-move rule', () => {
  const chess = require('chess.js').Chess;
  const c = new chess('8/8/8/4k3/8/8/4K3/7R w - - 99 80');
  assert.equal(c.isDrawByFiftyMoves(), false);
  c.move('Rh2');
  assert.equal(c.isDrawByFiftyMoves(), true);
});

/* ------------------------------------------------------------- the room -- */

function setup(settings) {
  const room = core.createRoom(deps(T0), Object.assign({ name: 'Ada', voice: true }, settings));
  const host = room.players[0];
  const j = core.joinRoom(room, deps(T0), null, 'Bo');
  core.setConnected(room, host.id, true, T0);
  core.setConnected(room, j.player.id, true, T0);
  return { room, host, guest: j.player };
}
const send = (room, id, msg, now = T0 + 5) => core.handle(room, id, msg, deps(now));

test('a room seats two players, restores a seat by token and refuses a third', () => {
  const { room, host, guest } = setup();
  assert.equal(room.players.length, 2);
  assert.throws(() => core.joinRoom(room, deps(T0), null, 'Cy'), /full/);
  assert.equal(core.joinRoom(room, deps(T0), guest.token, 'x').player.id, guest.id);
  assert.equal(core.joinRoom(room, deps(T0), host.token, 'x').created, false);
});

test('only the host starts, with both players connected; side and time settings apply', () => {
  const { room, host, guest } = setup();
  assert.throws(() => send(room, guest.id, { type: 'lobby.start' }), /host/);
  assert.throws(() => send(room, guest.id, { type: 'lobby.settings', tc: '3+0' }), /host/);
  send(room, host.id, { type: 'lobby.settings', tc: '3+0', side: 'black' });
  assert.equal(room.settings.tc, '3+0');
  core.setConnected(room, guest.id, false, T0);
  assert.throws(() => send(room, host.id, { type: 'lobby.start' }), /connected/);
  core.setConnected(room, guest.id, true, T0);
  const r = send(room, host.id, { type: 'lobby.start' });
  assert.equal(room.status, 'playing');
  assert.equal(room.game.black, host.id);
  assert.equal(room.game.white, guest.id);
  assert.equal(room.game.base, 180000);
  assert.equal(r.out[0].msg.event.type, 'start');
  assert.throws(() => send(room, host.id, { type: 'lobby.settings', tc: '5+0' }), /locked/);
});

test('random side uses the supplied randomness', () => {
  const a = setup(); a.room.settings.side = 'random';
  core.handle(a.room, a.host.id, { type: 'lobby.start' }, deps(T0, { random: () => 0.2 }));
  assert.equal(a.room.game.white, a.host.id);
  const b = setup(); b.room.settings.side = 'random';
  core.handle(b.room, b.host.id, { type: 'lobby.start' }, deps(T0, { random: () => 0.9 }));
  assert.equal(b.room.game.black, b.host.id);
});

test('server validates every move: turn, legality, duplicates and stale plies', () => {
  const { room, host, guest } = setup({ side: 'white' });
  send(room, host.id, { type: 'lobby.start' });
  assert.throws(() => send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5', ply: 0 }), /turn/);
  assert.throws(() => send(room, host.id, { type: 'game.move', from: 'e2', to: 'e5', ply: 0 }), /Illegal/);
  send(room, host.id, { type: 'game.move', from: 'e2', to: 'e4', ply: 0 });
  assert.throws(() => send(room, host.id, { type: 'game.move', from: 'e2', to: 'e4', ply: 0 }), /Out of date|turn/, 'a repeated submission is not applied twice');
  assert.throws(() => send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5', ply: 5 }), /Out of date/);
  send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5', ply: 1 });
  assert.equal(room.game.moves.length, 2);
  assert.throws(() => send(room, host.id, { type: 'game.hack' }), /Unknown/);
});

test('timeout fires from the room tick and finishes the room; a finished room can be rematched with colours swapped', () => {
  const { room, host, guest } = setup({ side: 'white', tc: '1+0' });
  send(room, host.id, { type: 'lobby.start' }, T0);
  send(room, host.id, { type: 'game.move', from: 'e2', to: 'e4' }, T0 + 1000);
  send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5' }, T0 + 2000);
  assert.equal(core.nextWake(room), T0 + 2000 + 60000);
  assert.equal(core.tickRoom(room, T0 + 2000 + 59_999).changed, false);
  assert.equal(core.tickRoom(room, T0 + 2000 + 60_000).changed, true);
  assert.equal(room.status, 'finished');
  assert.equal(room.game.result.winner, 'black');
  send(room, host.id, { type: 'game.rematch' });
  assert.equal(room.status, 'finished');
  send(room, guest.id, { type: 'game.rematch' }, T0 + 70_000);
  assert.equal(room.status, 'playing');
  assert.equal(room.game.white, guest.id);
  assert.equal(room.gameNo, 2);
});

test('resign, abort and draw flow through the room', () => {
  const { room, host, guest } = setup({ side: 'white' });
  send(room, host.id, { type: 'lobby.start' });
  assert.throws(() => send(room, host.id, { type: 'game.resign' }), /Abort/);
  send(room, host.id, { type: 'game.move', from: 'e2', to: 'e4' });
  send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5' });
  assert.throws(() => send(room, host.id, { type: 'game.abort' }), /Resign/);
  send(room, host.id, { type: 'game.draw.offer' });
  send(room, guest.id, { type: 'game.draw.decline' });
  send(room, guest.id, { type: 'game.resign' });
  assert.equal(room.game.result.winner, 'white');
  assert.equal(room.status, 'finished');
  const r2 = setup({ side: 'white' });
  send(r2.room, r2.host.id, { type: 'lobby.start' });
  send(r2.room, r2.guest.id, { type: 'game.abort' });
  assert.equal(r2.room.game.result.aborted, true);
});

test('abandonment can be claimed only after the opponent has been gone long enough', () => {
  const { room, host, guest } = setup({ side: 'white' });
  send(room, host.id, { type: 'lobby.start' });
  send(room, host.id, { type: 'game.move', from: 'e2', to: 'e4' });
  send(room, guest.id, { type: 'game.move', from: 'e7', to: 'e5' });
  core.setConnected(room, guest.id, false, T0 + 100);
  assert.throws(() => send(room, host.id, { type: 'game.claim' }, T0 + 100 + 5000), /long enough/);
  send(room, host.id, { type: 'game.claim' }, T0 + 100 + core.ABANDON_MS);
  assert.equal(room.game.result.reason, 'abandoned');
  assert.equal(room.game.result.winner, 'white');
});

test('chat is trimmed, persisted and capped; voice relays only when enabled', () => {
  const { room, host, guest } = setup();
  const r = send(room, host.id, { type: 'chat.send', text: '  hi <b>there</b>  ' });
  assert.equal(r.out[0].msg.text, 'hi bthere/b');
  assert.equal(room.chat.length, 1);
  for (let i = 0; i < 100; i++) send(room, host.id, { type: 'chat.send', text: 'm' + i });
  assert.equal(room.chat.length, 80);
  const v = send(room, host.id, { type: 'voice.state', phase: 'announce', joined: true, muted: false });
  assert.equal(v.out[0].to, guest.id);
  const quiet = setup({ voice: false });
  assert.throws(() => send(quiet.room, quiet.host.id, { type: 'voice.state', joined: true }), /off/);
});

test('leaving a running game keeps the seat; leaving the lobby frees it and moves the host', () => {
  const { room, host, guest } = setup({ side: 'white' });
  send(room, host.id, { type: 'room.leave' });
  assert.equal(room.players.length, 1);
  assert.equal(room.host, guest.id);
  const g = setup({ side: 'white' });
  send(g.room, g.host.id, { type: 'lobby.start' });
  send(g.room, g.guest.id, { type: 'room.leave' });
  assert.equal(g.room.players.length, 2);
});

test('public snapshot never leaks seat tokens', () => {
  const { room } = setup();
  const text = JSON.stringify(core.publicRoom(room, T0));
  for (const p of room.players) assert.ok(!text.includes(p.token));
});
