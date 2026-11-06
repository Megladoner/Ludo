'use strict';
/* ==========================================================================
   PARCHEESI — chess core

   One rules-and-clock module shared by every place a chess game is decided:
     · the Cloudflare Durable Object (src/worker/chess-room.js)
     · the Node self-host server       (src/server/chess-rooms.js)
     · the browser, for Pass & play and Play vs computer (public/chess/core.js)

   It owns the game (legal moves via chess.js, results, clocks, abort / resign /
   draw offers) and the two-seat room around it (lobby, settings, start, rematch,
   chat, voice relay). Nothing in here touches a socket, a timer or storage:
   every function takes `now` and returns data, so the same code runs on the
   server as the authority and in the browser for offline play.

   public/chess/core.js is a byte-for-byte copy of this file (checked by `npm run check`).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    try { api.setChess(require('chess.js').Chess); } catch (error) { /* the host calls setChess() */ }
  } else {
    root.ChessCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ChessImpl = null;
  function setChess(impl) { ChessImpl = impl; }

  var TIME_CONTROLS = {
    '10+0': { id: '10+0', label: '10 minutes', short: '10 min', base: 600000, inc: 0 },
    '5+0': { id: '5+0', label: '5 minutes', short: '5 min', base: 300000, inc: 0 },
    '3+0': { id: '3+0', label: '3 minutes', short: '3 min', base: 180000, inc: 0 },
    '2+1': { id: '2+1', label: '2 + 1', short: '2+1', base: 120000, inc: 1000 },
    '1+0': { id: '1+0', label: '1 minute', short: '1 min', base: 60000, inc: 0 },
    unlimited: { id: 'unlimited', label: 'Unlimited', short: '∞', base: 0, inc: 0, unlimited: true },
  };
  var SIDES = ['white', 'black'];
  var FIRST_MOVE_MS = 60 * 1000;          // each side's first move must arrive within this, or the game is aborted
  var ABANDON_MS = 60 * 1000;             // an opponent gone this long can be declared abandoned
  var IDLE_TTL_MS = 24 * 60 * 60 * 1000;  // lobby / finished rooms
  var PLAY_TTL_MS = 72 * 60 * 60 * 1000;  // a running game (unlimited games may be slow)
  var MAX_CHAT = 80;
  var SQUARE = /^[a-h][1-8]$/;
  var NAME_FALLBACK = 'Player';

  function other(side) { return side === 'white' ? 'black' : 'white'; }
  function opposite(side) { return other(side); }

  /* ------------------------------------------------------------------ game -- */

  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function chessFor(game) {
    var hit = cache && cache.get(game);
    if (hit && hit.n === game.moves.length) return hit.chess;
    var chess = new ChessImpl();
    for (var i = 0; i < game.moves.length; i++) {
      var m = game.moves[i];
      chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    }
    if (cache) cache.set(game, { chess: chess, n: game.moves.length });
    return chess;
  }

  // opts: { white, black, tc, now, firstMoveMs }
  function newGame(opts) {
    var tc = TIME_CONTROLS[opts.tc] || TIME_CONTROLS['10+0'];
    var firstMoveMs = opts.firstMoveMs == null ? FIRST_MOVE_MS : opts.firstMoveMs;
    var game = {
      white: opts.white, black: opts.black, tc: tc.id, base: tc.base, inc: tc.inc, unlimited: !!tc.unlimited,
      startedAt: opts.now, moves: [], clock: { white: tc.base, black: tc.base },
      // The clocks stay still until both sides have moved once; `turnStart` is when the running clock began.
      turnStart: null, firstDeadline: firstMoveMs ? opts.now + firstMoveMs : null, firstMoveMs: firstMoveMs,
      result: null, drawOffer: null, lastOfferPly: { white: -1, black: -1 },
    };
    chessFor(game);
    return game;
  }

  function turnOf(game) { return game.moves.length % 2 === 0 ? 'white' : 'black'; }
  function fenOf(game) { return chessFor(game).fen(); }
  function bothMoved(game) { return game.moves.length >= 2; }

  function remaining(game, side, now) {
    if (game.unlimited) return null;
    var left = game.clock[side];
    if (!game.result && game.turnStart != null && turnOf(game) === side) left -= now - game.turnStart;
    return Math.max(0, left);
  }

  function endGame(game, winner, reason, now, extra) {
    if (game.result) return game.result;
    if (!game.unlimited && game.turnStart != null) {
      var side = turnOf(game);
      game.clock[side] = Math.max(0, game.clock[side] - (now - game.turnStart));
    }
    game.turnStart = null;
    game.drawOffer = null;
    game.result = Object.assign({ winner: winner, reason: reason, at: now, aborted: false }, extra || {});
    return game.result;
  }

  // Who can still deliver mate? Lone king, or king and one minor piece, cannot.
  function hasMatingMaterial(chess, side) {
    var letter = side === 'white' ? 'w' : 'b', minors = 0, board = chess.board();
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
      var p = board[r][f];
      if (!p || p.color !== letter) continue;
      if (p.type === 'p' || p.type === 'r' || p.type === 'q') return true;
      if (p.type === 'n' || p.type === 'b') minors++;
    }
    return minors >= 2;
  }

  function flagOut(game, side, now) {
    var claimant = other(side);
    if (hasMatingMaterial(chessFor(game), claimant)) return endGame(game, claimant, 'timeout', now);
    return endGame(game, null, 'timeout-material', now);
  }

  // Applies the clock rules for a time-out and returns true when the game just ended.
  function tick(game, now) {
    if (game.result) return false;
    if (!bothMoved(game)) {
      if (game.firstDeadline != null && now >= game.firstDeadline) {
        endGame(game, null, 'aborted', now, { aborted: true, idle: true, by: turnOf(game) });
        return true;
      }
      return false;
    }
    if (game.unlimited || game.turnStart == null) return false;
    var side = turnOf(game);
    if (game.clock[side] - (now - game.turnStart) <= 0) { flagOut(game, side, now); return true; }
    return false;
  }

  // The moment the server should next look at this game, or null.
  function deadline(game) {
    if (!game || game.result) return null;
    if (!bothMoved(game)) return game.firstDeadline;
    if (game.unlimited || game.turnStart == null) return null;
    return game.turnStart + game.clock[turnOf(game)];
  }

  // mv: { from, to, promotion? }. Returns { ok, error?, info? , ended? }.
  function applyMove(game, side, mv, now) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (side !== turnOf(game)) return { ok: false, error: 'It is not your turn' };
    if (!mv || !SQUARE.test(String(mv.from)) || !SQUARE.test(String(mv.to))) return { ok: false, error: 'Illegal move' };
    var promotion = mv.promotion == null || mv.promotion === '' ? undefined : String(mv.promotion).toLowerCase();
    if (promotion !== undefined && 'qrbn'.indexOf(promotion) < 0) return { ok: false, error: 'Illegal move' };
    if (tick(game, now)) return { ok: false, error: 'Time is up', ended: true };
    var chess = chessFor(game), made;
    try { made = chess.move({ from: mv.from, to: mv.to, promotion: promotion }); }
    catch (error) { return { ok: false, error: 'Illegal move' }; }

    if (game.turnStart != null && !game.unlimited) {
      game.clock[side] = Math.max(0, game.clock[side] - (now - game.turnStart)) + game.inc;
    }
    game.moves.push({ san: made.san, from: made.from, to: made.to, promotion: made.promotion || undefined, uci: made.from + made.to + (made.promotion || '') });
    if (cache) cache.set(game, { chess: chess, n: game.moves.length });
    if (game.drawOffer && game.drawOffer !== side) game.drawOffer = null;

    var info = { san: made.san, from: made.from, to: made.to, color: side, piece: made.piece, captured: made.captured || null, promotion: made.promotion || null, castle: made.san.indexOf('O-O') === 0, check: chess.inCheck(), mate: chess.isCheckmate() };
    if (bothMoved(game)) { game.turnStart = now; game.firstDeadline = null; }
    else game.firstDeadline = game.firstMoveMs ? now + game.firstMoveMs : null;

    var ended = false;
    if (chess.isCheckmate()) { endGame(game, side, 'checkmate', now); ended = true; }
    else if (chess.isStalemate()) { endGame(game, null, 'stalemate', now); ended = true; }
    else if (chess.isInsufficientMaterial()) { endGame(game, null, 'insufficient', now); ended = true; }
    else if (chess.isThreefoldRepetition()) { endGame(game, null, 'repetition', now); ended = true; }
    else if (chess.isDrawByFiftyMoves()) { endGame(game, null, 'fifty', now); ended = true; }
    return { ok: true, info: info, ended: ended };
  }

  function legalMoves(game) { return chessFor(game).moves({ verbose: true }); }

  function resign(game, side, now) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (!bothMoved(game)) return { ok: false, error: 'Both players must move before anyone can resign. Abort instead.' };
    endGame(game, other(side), 'resignation', now, { by: side });
    return { ok: true };
  }
  function abort(game, side, now) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (bothMoved(game)) return { ok: false, error: 'The game is under way. Resign instead.' };
    endGame(game, null, 'aborted', now, { aborted: true, by: side });
    return { ok: true };
  }
  function offerDraw(game, side, now) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (!bothMoved(game)) return { ok: false, error: 'Draws can be offered once both players have moved' };
    if (game.drawOffer === other(side)) { endGame(game, null, 'agreement', now); return { ok: true, accepted: true }; }
    if (game.drawOffer === side) return { ok: false, error: 'Your offer is still open' };
    if (game.lastOfferPly[side] === game.moves.length) return { ok: false, error: 'You already offered a draw this move' };
    game.drawOffer = side;
    game.lastOfferPly[side] = game.moves.length;
    return { ok: true };
  }
  function acceptDraw(game, side, now) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (game.drawOffer !== other(side)) return { ok: false, error: 'There is no draw offer to accept' };
    endGame(game, null, 'agreement', now);
    return { ok: true };
  }
  function declineDraw(game, side) {
    if (game.result) return { ok: false, error: 'The game is over' };
    if (game.drawOffer !== other(side)) return { ok: false, error: 'There is no draw offer to decline' };
    game.drawOffer = null;
    return { ok: true };
  }
  function cancelDraw(game, side) {
    if (game.drawOffer !== side) return { ok: false, error: 'You have no open offer' };
    game.drawOffer = null;
    return { ok: true };
  }

  function resultText(result, names) {
    if (!result) return '';
    var who = function (s) { return (names && names[s]) || (s === 'white' ? 'White' : 'Black'); };
    var win = result.winner ? who(result.winner) : '';
    switch (result.reason) {
      case 'checkmate': return 'Checkmate. ' + win + ' wins';
      case 'resignation': return who(other(result.winner)) + ' resigned. ' + win + ' wins';
      case 'timeout': return who(other(result.winner)) + ' ran out of time. ' + win + ' wins';
      case 'abandoned': return who(other(result.winner)) + ' left the game. ' + win + ' wins';
      case 'stalemate': return 'Draw by stalemate';
      case 'repetition': return 'Draw by threefold repetition';
      case 'fifty': return 'Draw by the fifty-move rule';
      case 'insufficient': return 'Draw by insufficient material';
      case 'timeout-material': return 'Draw. Time ran out but the opponent cannot mate';
      case 'agreement': return 'Draw by agreement';
      case 'aborted': return result.idle ? 'Game aborted. A first move was not played in time' : 'Game aborted';
      default: return 'Game over';
    }
  }
  function scoreOf(result) {
    if (!result || result.aborted) return '';
    return result.winner === 'white' ? '1-0' : result.winner === 'black' ? '0-1' : '1/2-1/2';
  }

  // What both browsers and the server show of a game. Clock values are the time left
  // when `turnStart` began (server clock); the side to move counts down from there.
  function publicGame(game, now) {
    if (!game) return null;
    return {
      white: game.white, black: game.black, tc: game.tc, unlimited: game.unlimited, inc: game.inc, base: game.base,
      startedAt: game.startedAt, moves: game.moves, turn: turnOf(game), fen: fenOf(game),
      clock: { white: game.clock.white, black: game.clock.black, turnStart: game.turnStart, running: !game.result && game.turnStart != null ? turnOf(game) : null, serverNow: now },
      firstDeadline: game.firstDeadline, result: game.result, drawOffer: game.drawOffer,
      check: !game.result || game.result.reason === 'checkmate' ? chessFor(game).inCheck() : false,
    };
  }

  /* ------------------------------------------------------------------ room -- */

  function cleanName(value) {
    var printable = String(value == null ? '' : value).split('').filter(function (ch) {
      var code = ch.codePointAt(0);
      return code > 31 && code !== 127;
    }).join('');
    return printable.replace(/[<>]/g, '').trim().slice(0, 20) || NAME_FALLBACK;
  }
  function cleanSettings(input, prior) {
    var next = Object.assign({ tc: '10+0', side: 'random' }, prior || {});
    if (input && TIME_CONTROLS[input.tc]) next.tc = input.tc;
    if (input && (input.side === 'white' || input.side === 'black' || input.side === 'random')) next.side = input.side;
    return next;
  }

  // deps: { id(), token(), code, now }
  function createRoom(deps, opts) {
    var hostId = deps.id();
    var room = {
      code: deps.code, createdAt: deps.now, updatedAt: deps.now, status: 'lobby', voice: !!opts.voice,
      host: hostId, settings: cleanSettings(opts, null), sequence: 0, gameNo: 0, rematch: [], chat: [],
      players: [{ id: hostId, token: deps.token(), name: cleanName(opts.name), color: 'p1', side: null, connected: false, disconnectedAt: deps.now, joinedAt: deps.now }],
      game: null,
    };
    return room;
  }

  function playerBySide(room, side) {
    if (!room.game) return null;
    return room.players.find(function (p) { return p.id === room.game[side]; }) || null;
  }
  function sideOf(room, playerId) {
    if (!room.game) return null;
    return room.game.white === playerId ? 'white' : room.game.black === playerId ? 'black' : null;
  }
  function migrateHost(room) {
    var host = room.players.find(function (p) { return p.id === room.host; });
    if (host && host.connected) return;
    var next = room.players.find(function (p) { return p.connected; }) || room.players[0];
    if (next) room.host = next.id;
  }

  function publicRoom(room, now) {
    return {
      invite: room.code, status: room.status, host: room.host, createdAt: room.createdAt, voice: !!room.voice,
      settings: room.settings, gameNo: room.gameNo, rematch: room.rematch.slice(), sequence: room.sequence, serverNow: now,
      players: room.players.map(function (p) {
        return { id: p.id, name: p.name, color: p.color, side: sideOf(room, p.id), connected: p.connected, host: p.id === room.host, disconnectedFor: p.connected || !p.disconnectedAt ? 0 : Math.max(0, now - p.disconnectedAt) };
      }),
      game: publicGame(room.game, now),
    };
  }

  // Finds a seat for a join request. Returns { player, created }.
  function joinRoom(room, deps, token, name) {
    var player = token ? room.players.find(function (p) { return p.token === token; }) : null;
    var created = false;
    if (!player) {
      if (room.players.length >= 2) throw new Error('This room is full');
      if (room.status === 'playing') throw new Error('This game has already started');
      var taken = room.players.map(function (p) { return p.color; });
      player = { id: deps.id(), token: deps.token(), name: cleanName(name), color: taken.indexOf('p1') < 0 ? 'p1' : 'p2', side: null, connected: false, disconnectedAt: deps.now, joinedAt: deps.now };
      room.players.push(player);
      created = true;
    }
    return { player: player, created: created };
  }

  function setConnected(room, playerId, connected, now) {
    var p = room.players.find(function (x) { return x.id === playerId; });
    if (!p || p.connected === connected) return false;
    p.connected = connected;
    p.disconnectedAt = connected ? null : now;
    if (connected) { /* nothing else: the clock is the server's, and a returning player simply carries on */ }
    migrateHost(room);
    return true;
  }

  function startGame(room, deps) {
    var host = room.players.find(function (p) { return p.id === room.host; });
    var guest = room.players.find(function (p) { return p.id !== room.host; });
    var side = room.settings.side;
    if (side === 'random') side = deps.random() < 0.5 ? 'white' : 'black';
    var white = side === 'white' ? host : guest, black = side === 'white' ? guest : host;
    room.game = newGame({ white: white.id, black: black.id, tc: room.settings.tc, now: deps.now });
    room.status = 'playing';
    room.rematch = [];
    room.gameNo++;
  }

  function finish(room) { if (room.game && room.game.result) room.status = 'finished'; }

  function chatLine(room, player, text, now) {
    var body = String(text == null ? '' : text).split('').filter(function (ch) { var c = ch.codePointAt(0); return c > 31 && c !== 127; }).join('').replace(/[<>]/g, '').trim().slice(0, 240);
    if (!body) return null;
    var line = { id: room.sequence + '-' + room.chat.length, player: player.name, color: player.color, playerId: player.id, text: body, at: now };
    room.chat.push(line);
    if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
    return line;
  }

  // The abandonment rule: an opponent who has been gone for ABANDON_MS can be declared to have left.
  function claimAbandon(room, playerId, now) {
    var game = room.game;
    if (!game || game.result) return { ok: false, error: 'There is no game to claim' };
    var side = sideOf(room, playerId);
    if (!side) return { ok: false, error: 'You are not playing' };
    var foe = playerBySide(room, other(side));
    if (!foe || foe.connected || !foe.disconnectedAt || now - foe.disconnectedAt < ABANDON_MS) return { ok: false, error: 'Your opponent has not been away long enough' };
    if (!bothMoved(game)) endGame(game, null, 'aborted', now, { aborted: true, by: side, abandoned: true });
    else endGame(game, side, 'abandoned', now, { by: other(side) });
    return { ok: true };
  }

  // Handles one client message from an already-seated player. Returns { out, persist, close }.
  //   out: [{ to: 'all' | playerId, msg }]   persist: save the room   close: delete the room
  function handle(room, playerId, msg, deps) {
    var now = deps.now, res = { out: [], persist: false, close: false };
    var player = room.players.find(function (p) { return p.id === playerId; });
    if (!player) throw new Error('Room membership is no longer valid');
    var type = msg.type, game = room.game, event = null;
    var side = sideOf(room, playerId);
    var isHost = room.host === playerId;

    function need(ok, text) { if (!ok) throw new Error(text); }
    function guardGame() { need(room.status === 'playing' && game && !game.result, 'There is no game in progress'); need(side, 'You are not playing this game'); }

    if (type === 'voice.state' || type === 'voice.signal') { voiceRelay(room, player, msg, res); return res; }

    if (type === 'game.state') {
      res.out.push({ to: playerId, msg: snapshotMsg(room, now, null, true) });
      return res;
    }

    if (type === 'chat.send') {
      var line = chatLine(room, player, msg.text, now);
      if (line) { room.sequence++; res.out.push({ to: 'all', msg: { type: 'chat.message', sequence: room.sequence, id: line.id, player: line.player, color: line.color, playerId: line.playerId, text: line.text, at: line.at } }); res.persist = true; }
      return res;
    }

    if (type === 'lobby.settings') {
      need(isHost, 'Only the host can change the settings');
      need(room.status !== 'playing', 'Settings are locked while a game is running');
      room.settings = cleanSettings(msg, room.settings);
    } else if (type === 'lobby.rename') {
      player.name = cleanName(msg.name);
    } else if (type === 'lobby.start') {
      need(isHost, 'Only the host can start the game');
      need(room.status === 'lobby', 'A game has already started');
      need(room.players.length === 2, 'Waiting for an opponent to join');
      need(room.players.every(function (p) { return p.connected; }), 'Both players need to be connected');
      startGame(room, deps);
      game = room.game;
      event = { type: 'start' };
    } else if (type === 'lobby.back') {
      need(isHost, 'Only the host can return to the lobby');
      need(room.status === 'finished', 'The game is still running');
      room.game = null; room.status = 'lobby'; room.rematch = [];
    } else if (type === 'game.move') {
      guardGame();
      need(Number.isInteger(msg.ply) ? msg.ply === game.moves.length : true, 'Out of date. Your board has been refreshed');
      var before = game.moves.length;
      var r = applyMove(game, side, { from: msg.from, to: msg.to, promotion: msg.promotion }, now);
      if (!r.ok && r.ended) { finish(room); event = { type: 'end' }; }
      else {
        need(r.ok, r.error);
        event = { type: 'move', move: r.info, ply: before + 1 };
        if (r.ended) { finish(room); event.ended = true; }
      }
    } else if (type === 'game.resign') {
      guardGame(); var rr = resign(game, side, now); need(rr.ok, rr.error); finish(room); event = { type: 'end' };
    } else if (type === 'game.abort') {
      guardGame(); var ra = abort(game, side, now); need(ra.ok, ra.error); finish(room); event = { type: 'end' };
    } else if (type === 'game.draw.offer') {
      guardGame(); var ro = offerDraw(game, side, now); need(ro.ok, ro.error);
      if (ro.accepted) { finish(room); event = { type: 'end' }; } else event = { type: 'draw-offer', by: side };
    } else if (type === 'game.draw.accept') {
      guardGame(); var rd = acceptDraw(game, side, now); need(rd.ok, rd.error); finish(room); event = { type: 'end' };
    } else if (type === 'game.draw.decline') {
      guardGame(); var rx = declineDraw(game, side); need(rx.ok, rx.error); event = { type: 'draw-declined', by: side };
    } else if (type === 'game.draw.cancel') {
      guardGame(); var rc = cancelDraw(game, side); need(rc.ok, rc.error); event = { type: 'draw-cancelled' };
    } else if (type === 'game.claim') {
      var rl = claimAbandon(room, playerId, now); need(rl.ok, rl.error); finish(room); event = { type: 'end' };
    } else if (type === 'game.rematch') {
      need(room.status === 'finished' && room.game, 'The game is still running');
      need(room.players.length === 2, 'Your opponent has left');
      if (room.rematch.indexOf(playerId) < 0) room.rematch.push(playerId);
      if (room.rematch.length === 2) {
        var prev = room.game;
        room.game = newGame({ white: prev.black, black: prev.white, tc: room.settings.tc, now: now });
        room.status = 'playing'; room.rematch = []; room.gameNo++;
        event = { type: 'start', rematch: true };
      } else event = { type: 'rematch-offer', by: playerId };
    } else if (type === 'room.leave') {
      // Leaving mid-game only drops the connection; the seat and the clock stay. Lobby and
      // finished rooms release the seat.
      if (room.status === 'playing') { res.out.push({ to: playerId, msg: { type: 'room.left', sequence: room.sequence } }); return res; }
      room.players = room.players.filter(function (p) { return p.id !== playerId; });
      room.rematch = room.rematch.filter(function (id) { return id !== playerId; });
      res.out.push({ to: playerId, msg: { type: 'room.left', sequence: room.sequence } });
      if (!room.players.length) { res.close = true; return res; }
      migrateHost(room);
      if (room.status === 'finished') { room.status = 'lobby'; room.game = null; }
    } else if (type === 'room.close') {
      need(isHost, 'Only the host can close the room');
      need(room.status !== 'playing', 'Finish or abort the game before closing the room');
      res.out.push({ to: 'all', msg: { type: 'room.closed' } });
      res.close = true;
      return res;
    } else {
      throw new Error('Unknown action');
    }

    room.updatedAt = now;
    room.sequence++;
    res.persist = true;
    res.out.push({ to: 'all', msg: snapshotMsg(room, now, event, false) });
    return res;
  }

  function snapshotMsg(room, now, event, resync) {
    var m = { type: 'room.snapshot', sequence: room.sequence, room: publicRoom(room, now), serverNow: now };
    if (event) m.event = event;
    if (resync) m.resync = true;
    return m;
  }

  // Voice chat only relays small connection messages between the two players.
  function voiceRelay(room, player, msg, res) {
    if (!room.voice) throw new Error('Voice chat is off for this room');
    var target = null;
    if (msg.to !== undefined && msg.to !== null) {
      target = room.players.find(function (p) { return p.id === msg.to; });
      if (!target || target.id === player.id) return;
    }
    var out;
    if (msg.type === 'voice.signal') {
      if (!target) return;
      if (msg.kind !== 'offer' && msg.kind !== 'answer') throw new Error('Invalid voice message');
      if (typeof msg.sdp !== 'string' || msg.sdp.length > 20000) throw new Error('Invalid voice message');
      out = { type: 'voice.signal', from: player.id, kind: msg.kind, sdp: msg.sdp, sid: String(msg.sid || '').slice(0, 40) };
    } else {
      var phase = ['announce', 'reply', 'update'].indexOf(msg.phase) >= 0 ? msg.phase : 'update';
      out = { type: 'voice.state', from: player.id, phase: phase, joined: !!msg.joined, muted: !!msg.muted };
    }
    var recipients = target ? [target] : room.players.filter(function (p) { return p.id !== player.id; });
    recipients.forEach(function (p) { res.out.push({ to: p.id, msg: out }); });
  }

  // Runs the clock rules for a room: call when an alarm or timer fires. Returns { changed, event }.
  function tickRoom(room, now) {
    if (room.status !== 'playing' || !room.game) return { changed: false };
    if (!tick(room.game, now)) return { changed: false };
    finish(room);
    room.updatedAt = now;
    room.sequence++;
    return { changed: true, event: { type: 'end' } };
  }

  // When should the host environment wake this room up next? (timestamp or null)
  function nextWake(room) {
    var wake = room.updatedAt + (room.status === 'playing' ? PLAY_TTL_MS : IDLE_TTL_MS);
    var d = room.status === 'playing' ? deadline(room.game) : null;
    return d != null ? Math.min(wake, d) : wake;
  }
  function isExpired(room, now) {
    return now >= room.updatedAt + (room.status === 'playing' ? PLAY_TTL_MS : IDLE_TTL_MS);
  }

  return {
    setChess: setChess, TIME_CONTROLS: TIME_CONTROLS, SIDES: SIDES, FIRST_MOVE_MS: FIRST_MOVE_MS, ABANDON_MS: ABANDON_MS,
    other: other, opposite: opposite,
    // game
    newGame: newGame, applyMove: applyMove, legalMoves: legalMoves, resign: resign, abort: abort,
    offerDraw: offerDraw, acceptDraw: acceptDraw, declineDraw: declineDraw, cancelDraw: cancelDraw,
    tick: tick, deadline: deadline, remaining: remaining, turnOf: turnOf, fenOf: fenOf, bothMoved: bothMoved,
    endGame: endGame, resultText: resultText, scoreOf: scoreOf, publicGame: publicGame, hasMatingMaterial: hasMatingMaterial, chessFor: chessFor,
    // room
    createRoom: createRoom, joinRoom: joinRoom, setConnected: setConnected, handle: handle, publicRoom: publicRoom,
    snapshotMsg: snapshotMsg, tickRoom: tickRoom, nextWake: nextWake, isExpired: isExpired, chatLine: chatLine,
    cleanName: cleanName, cleanSettings: cleanSettings, sideOf: sideOf, playerBySide: playerBySide, migrateHost: migrateHost,
  };
});
