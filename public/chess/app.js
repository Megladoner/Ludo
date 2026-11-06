import { Chess } from './vendor/chess.js';
import { Board } from './board.js';
import { PIECES } from './pieces.js';
import { Engine, LEVELS, budgetFor } from './engine.js';
import { analyzeGame, formatEval, winPct, MARKS } from './analysis.js';

/* ==========================================================================
   PARCHEESI — Chess client
   Sections: setup · prefs · state · helpers · game view · clocks · move list ·
             offline play · engine · online room · analysis · dialogs · routing
   ========================================================================== */

const Core = window.ChessCore;
Core.setChess(Chess);
const A = window.ParcheesiAudio;
const V = window.ParcheesiVoice;
const P = window.ParcheesiProfile;
const $ = (id) => document.getElementById(id);
const sfx = (name) => { try { if (A && A.sfx[name]) A.sfx[name](); } catch {} };
const THEMES = ['noir', 'classic', 'forest'];
const THEME_COLORS = { noir: '#000000', classic: '#14110d', forest: '#070c0a' };
const THEME_NAMES = { noir: 'Noir', classic: 'Classic', forest: 'Forest' };
const PREF_KEY = 'parcheesi.chess';
const OFFLINE_KEY = 'parcheesi.chess.offline';
const LAST_ROOM_KEY = 'parcheesi.chess.lastRoom';
const TC_ORDER = ['10+0', '5+0', '3+0', '2+1', '1+0', 'unlimited'];
const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/* ---------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readJSON = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } };
const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const other = Core.other;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sideLetter = (side) => (side === 'white' ? 'w' : 'b');

let toastTimer;
function toast(message, kind = 'info') {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('is-error', 'is-success');
  if (kind === 'error') node.classList.add('is-error');
  if (kind === 'success') node.classList.add('is-success');
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3400);
}
function announce(text) { const n = $('sr-live'); n.textContent = ''; setTimeout(() => { n.textContent = text; }, 30); }

function playerName() {
  try { const n = P && P.get().name; if (n) return n; } catch {}
  try { return localStorage.getItem('parcheesi.name') || ''; } catch { return ''; }
}
function rememberName(name) {
  try { if (P) P.setName(name); localStorage.setItem('parcheesi.name', name); } catch {}
}
const cleanName = (v) => String(v || '').split('').filter((c) => c.codePointAt(0) > 31).join('').replace(/[<>]/g, '').trim().slice(0, 20);

/* ----------------------------------------------------------------- prefs -- */

const DEFAULT_PREFS = { theme: 'noir', sound: true, volume: 80, motion: false, coords: true, legal: true, queen: false, setup: { side: 'random', tc: '10+0', level: 3, autoFlip: false } };
let prefs = Object.assign({}, DEFAULT_PREFS, readJSON(PREF_KEY, {}));
prefs.setup = Object.assign({}, DEFAULT_PREFS.setup, prefs.setup || {});
if (!THEMES.includes(prefs.theme)) prefs.theme = 'noir';
const savePrefs = () => writeJSON(PREF_KEY, prefs);

function applyPrefs() {
  const root = document.documentElement;
  root.dataset.chessTheme = prefs.theme;
  root.classList.toggle('reduced-motion', !!prefs.motion);
  root.classList.toggle('no-coords', !prefs.coords);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[prefs.theme]);
  if (A) { A.setEnabled(!!prefs.sound); A.setVolume(prefs.volume / 100); }
  const t = $('sound-toggle');
  t.setAttribute('aria-pressed', prefs.sound ? 'true' : 'false');
  t.classList.toggle('is-off', !prefs.sound);
  $('sound-waves').setAttribute('opacity', prefs.sound ? '1' : '0.15');
  $('pv-theme').textContent = THEME_NAMES[prefs.theme].toUpperCase();
  $('menu-theme-state').textContent = THEME_NAMES[prefs.theme];
  $('menu-sound-state').textContent = prefs.sound ? 'On' : 'Off';
}
function fillSettings() {
  document.querySelectorAll('input[name="ctheme"]').forEach((r) => { r.checked = r.value === prefs.theme; });
  $('set-sound').checked = !!prefs.sound;
  $('set-volume').value = prefs.volume;
  $('set-motion').checked = !!prefs.motion;
  $('set-coords').checked = !!prefs.coords;
  $('set-legal').checked = !!prefs.legal;
  $('set-queen').checked = !!prefs.queen;
}

/* ----------------------------------------------------------------- state -- */

const S = {
  view: 'menu', mode: null,
  g: null,                 // the game (core shape) shown on the board
  gameId: 0,               // bumps whenever a new game replaces the old one
  viewPly: null,           // null follows the live position
  humanSide: 'white',      // the side at the bottom (and, vs computer, the human's side)
  names: { p1: 'Player 1', p2: 'Player 2' },
  setup: null, thinking: false, engineLevel: 3, engine: null, autoFlip: false,
  // online
  room: null, token: null, playerId: null, myColor: null, mySide: null, socket: null, offset: 0, offsetSet: false,
  seq: -1, pending: null, intentional: false, reconnectTimer: null, attempts: 0, code: null, chat: [], unread: 0, flagAsked: 0,
  gameNo: 0, rematchSent: false,
  analysis: null,
  fens: [], checks: [], fensKey: '',
};
let board = null;

/* ------------------------------------------------------ derived game data -- */

function names() {
  if (S.mode === 'online' && S.room) {
    const out = { white: 'White', black: 'Black' };
    for (const p of S.room.players) if (p.side) out[p.side] = p.name;
    return out;
  }
  if (S.mode === 'computer') {
    const lvl = LEVELS[S.engineLevel - 1];
    const me = playerName() || 'You';
    return S.humanSide === 'white' ? { white: me, black: 'Stockfish · ' + lvl.name } : { white: 'Stockfish · ' + lvl.name, black: me };
  }
  const p1 = S.humanSide, p2 = other(p1);
  return { [p1]: S.names.p1, [p2]: S.names.p2 };
}
function mySideForUi() { return S.mode === 'online' ? S.mySide : S.mode === 'computer' ? S.humanSide : null; }
function plyCount() { return S.g ? S.g.moves.length : 0; }
function curPly() { return S.viewPly == null ? plyCount() : Math.min(S.viewPly, plyCount()); }
function isLive() { return curPly() === plyCount(); }
function nowMs() { return S.mode === 'online' ? Date.now() + S.offset : Date.now(); }

// Positions after every ply, for review and analysis. Rebuilt only when the game changes.
function ensureFens() {
  const key = S.gameId + ':' + plyCount();
  if (key === S.fensKey) return;
  const chess = new Chess();
  S.fens = [chess.fen()]; S.checks = [false];
  for (const m of S.g.moves) {
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    S.fens.push(chess.fen()); S.checks.push(chess.inCheck());
  }
  S.fensKey = key;
}

function fromPublic(pub) {
  return {
    white: pub.white, black: pub.black, tc: pub.tc, unlimited: pub.unlimited, inc: pub.inc, base: pub.base, moves: pub.moves,
    clock: { white: pub.clock.white, black: pub.clock.black }, turnStart: pub.clock.turnStart, result: pub.result, drawOffer: pub.drawOffer,
    startedAt: pub.startedAt, firstDeadline: pub.firstDeadline,
  };
}

/* ------------------------------------------------------------------ views -- */

const VIEWS = ['menu-view', 'lobby-view', 'game-view'];
function showView(name) {
  S.view = name;
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== name + '-view');
  window.scrollTo(0, 0);
  if (name === 'menu') startDemo(); else stopDemo();
  setNetwork();
  document.title = (name === 'game' ? names()[S.humanSide] + ' · ' : '') + 'Chess — PARCHEESI';
}

function setNetwork(forced) {
  let status = forced;
  if (!status) {
    if (S.mode === 'online' && S.view !== 'menu') status = S.socket && S.socket.readyState === 1 ? 'connected' : S.socket && S.socket.readyState === 0 ? 'connecting' : S.intentional ? 'idle' : 'reconnecting';
    else status = 'idle';
  }
  const map = {
    idle: ['READY TO PLAY', null, 'is-ready'], connecting: ['CONNECTING…', 'CONNECTING', 'is-reconnecting'], connected: ['ONLINE', 'CONNECTED', 'is-online'],
    reconnecting: ['RECONNECTING…', 'RECONNECTING', 'is-reconnecting'], offline: ['OFFLINE', 'DISCONNECTED', 'is-offline'],
  };
  const [label, pillText, klass] = map[status];
  $('network-label').textContent = label;
  $('network-status').className = 'online-indicator ' + klass;
  const pill = $('conn-pill');
  const local = S.mode !== 'online';
  pill.innerHTML = '<i></i> ' + (local ? (S.mode === 'computer' ? 'VS COMPUTER' : 'LOCAL') : pillText || 'CONNECTED');
  pill.className = 'connection-pill ' + (local ? 'is-ready' : klass);
}

/* ------------------------------------------------------------ board wiring -- */

function mayMove(side) {
  if (S.mode === 'local') return true;
  if (S.mode === 'computer') return side === S.humanSide;
  return S.mode === 'online' && side === S.mySide && S.room && S.room.status === 'playing';
}
function canMoveFrom(sq) {
  if (!S.g || S.g.result || S.analysis || S.thinking || S.pending || !isLive()) return false;
  const p = board.pos.get(sq);
  const turn = Core.turnOf(S.g);
  return !!p && p.color === sideLetter(turn) && mayMove(turn);
}
function targetsFrom(sq) {
  const moves = Core.chessFor(S.g).moves({ square: sq, verbose: true });
  const seen = new Map();
  for (const m of moves) if (!seen.has(m.to)) seen.set(m.to, { to: m.to, capture: m.flags.includes('c') || m.flags.includes('e'), promotion: !!m.promotion });
  return [...seen.values()];
}

function makeBoard() {
  board = new Board($('board'), {
    getTargets: targetsFrom, canMove: canMoveFrom, onMove: onBoardMove, announce,
    autoQueen: () => prefs.queen, showLegal: () => prefs.legal, animate: () => !prefs.motion,
  });
}

function onBoardMove(mv) {
  if (!S.g || S.g.result) return false;
  const side = Core.turnOf(S.g);
  if (S.mode === 'online') return playOnline(mv);
  const before = S.g.moves.length;
  const r = Core.applyMove(S.g, side, mv, Date.now());
  if (!r.ok) { sfx('chessIllegal'); toast(r.error, 'error'); if (r.ended) afterOfflineChange(null, true); return false; }
  afterOfflineChange(r.info, false, before);
  return true;
}

/* ------------------------------------------------------------- game render -- */

function renderGame(opts = {}) {
  if (!S.g) return;
  ensureFens();
  const ply = curPly();
  const fen = S.fens[ply];
  const last = ply > 0 ? [S.g.moves[ply - 1].from, S.g.moves[ply - 1].to] : null;
  const turnColor = fen.split(' ')[1];
  board.setPosition(fen, { lastMove: last, check: S.checks[ply] ? turnColor : null, animate: opts.animate });
  board.clearSelection();
  renderPlayers(fen, ply);
  renderMoves();
  renderStatus();
  renderControls();
  renderAnalysisBits();
  paintClocks();
  if (V) V.decorate();
}

function bottomSide() { return board ? board.orientation : S.humanSide; }

function renderPlayers(fen, ply) {
  const nm = names();
  const bottom = bottomSide(), top = other(bottom);
  const counts = { w: {}, b: {} };
  for (const ch of fen.split(' ')[0]) { if (/[pnbrq]/i.test(ch)) { const c = ch === ch.toLowerCase() ? 'b' : 'w'; const t = ch.toLowerCase(); counts[c][t] = (counts[c][t] || 0) + 1; } }
  const missing = (c) => { const out = []; for (const t of ['q', 'r', 'b', 'n', 'p']) for (let i = 0; i < Math.max(0, START_COUNTS[t] - (counts[c][t] || 0)); i++) out.push(t); return out; };
  const worth = (list) => list.reduce((a, t) => a + VALUES[t], 0);
  const lostW = missing('w'), lostB = missing('b');
  const diff = worth(lostB) - worth(lostW); // White's lead in material
  const fill = (el, side) => {
    const room = S.room, online = S.mode === 'online';
    const p = online && room ? room.players.find((x) => x.side === side) : null;
    el.dataset.color = p ? p.color : '';
    el.classList.toggle('turn', !S.g.result && Core.turnOf(S.g) === side && isLiveGame());
    el.querySelector('.ch-side-dot').className = 'ch-side-dot is-' + side;
    el.querySelector('.ch-pname').textContent = nm[side] + (mySideForUi() === side && S.mode === 'online' ? ' (you)' : '');
    let meta = cap(side);
    if (S.mode === 'computer' && side !== S.humanSide) meta = LEVELS[S.engineLevel - 1].rating + ' · ' + (S.thinking ? 'thinking…' : 'engine');
    if (online && p) {
      if (!p.connected) meta += ' · ' + (p.disconnectedFor > 3000 ? 'away ' + fmtAway(p.disconnectedFor + (Date.now() - S.room.receivedAt)) : 'reconnecting…');
      else meta += ' · connected';
    }
    el.querySelector('.ch-pmeta').textContent = meta;
    const takenList = side === 'white' ? lostB : lostW;
    const lead = side === 'white' ? diff : -diff;
    el.querySelector('.ch-captured').innerHTML = takenList.map((t) => '<span class="cp cp-' + (side === 'white' ? 'b' : 'w') + '">' + PIECES[(side === 'white' ? 'b' : 'w') + t] + '</span>').join('') + (lead > 0 ? '<em>+' + lead + '</em>' : '');
    el.dataset.side = side;
  };
  fill($('pl-bottom'), bottom);
  fill($('pl-top'), top);
}
function isLiveGame() { return !!S.g && !S.g.result; }
function fmtAway(ms) { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function renderStatus() {
  const g = S.g, nm = names(), el = $('status-line');
  let text = '';
  if (S.analysis) text = S.analysis.data ? 'Analysis · use ← → to step through the game' : 'Analysis running…';
  else if (g.result) text = Core.resultText(g.result, nm);
  else if (!isLive()) text = 'Reviewing move ' + curPly() + ' of ' + plyCount();
  else if (S.thinking) text = 'Stockfish is thinking…';
  else {
    const turn = Core.turnOf(g);
    const check = S.checks[plyCount()];
    const mine = mySideForUi();
    const who = mine ? (mine === turn ? 'Your move' : nm[turn] + ' to move') : nm[turn] + ' to move';
    text = (check ? 'Check. ' : '') + who;
    if (S.mode === 'online' && S.room && S.room.status === 'playing' && !Core.bothMoved(g)) {
      const left = g.firstDeadline ? Math.max(0, Math.ceil((g.firstDeadline - nowMs()) / 1000)) : 0;
      if (left) text += ' · first move within ' + left + 's';
    }
  }
  el.textContent = text;
  el.classList.toggle('is-check', !!(!g.result && !S.analysis && S.checks[plyCount()]));
  el.classList.toggle('is-over', !!g.result);
  const live = $('live-dot');
  live.textContent = g.result ? 'FINISHED' : isLive() ? 'LIVE' : 'REVIEW';
  live.classList.toggle('is-review', !isLive() && !g.result);
}

function renderControls() {
  const g = S.g, over = !!g.result, playing = !over && !S.analysis;
  const me = mySideForUi();
  const online = S.mode === 'online';
  const started = Core.bothMoved(g);
  const canAct = playing && (S.mode !== 'online' || (me && S.room && S.room.status === 'playing'));
  $('btn-abort').hidden = !(canAct && !started);
  $('btn-resign').hidden = !(canAct && started);
  const offerBtn = $('btn-draw');
  offerBtn.hidden = !(canAct && started);
  const mineOffered = g.drawOffer && g.drawOffer === me;
  offerBtn.disabled = !!mineOffered;
  offerBtn.textContent = mineOffered ? 'Draw offered…' : 'Offer draw';
  const incoming = online && g.drawOffer && me && g.drawOffer !== me && playing;
  $('draw-banner').hidden = !incoming;
  if (incoming) $('draw-text').textContent = names()[g.drawOffer] + ' offers a draw.';
  // Declare an opponent who has been gone for a minute to have left.
  let claim = false;
  if (online && playing && S.room && me) {
    const foe = S.room.players.find((p) => p.side && p.side !== me);
    claim = !!foe && !foe.connected && foe.disconnectedFor + (Date.now() - S.room.receivedAt) >= Core.ABANDON_MS;
  }
  $('btn-claim').hidden = !claim;
  $('btn-claim').textContent = started ? 'Claim win' : 'End game';

  const card = $('result-card');
  card.hidden = !over || !!S.analysis;
  if (over) {
    const r = g.result, nm = names();
    let title;
    if (r.aborted) title = 'Game aborted.';
    else if (!r.winner) title = 'Draw.';
    else if (me) title = r.winner === me ? 'You won.' : 'You lost.';
    else title = cap(r.winner) + ' wins.';
    $('result-eyebrow').textContent = (r.aborted ? 'NO RESULT' : Core.scoreOf(r) + ' · ' + r.reason.toUpperCase().replace('-', ' '));
    $('result-title').textContent = title;
    $('result-sub').textContent = Core.resultText(r, nm);
    $('btn-analyze').hidden = g.moves.length < 2;
    const rematch = $('btn-rematch');
    rematch.hidden = online && (!S.room || S.room.players.length < 2);
    if (online) {
      const asked = S.room && S.room.rematch.includes(S.playerId), theirs = S.room && S.room.rematch.length && !asked;
      rematch.textContent = asked ? 'Waiting for opponent…' : theirs ? 'Accept rematch' : 'Rematch';
      rematch.disabled = !!asked;
      $('btn-newgame').hidden = !(S.room && S.room.host === S.playerId);
      $('btn-newgame').textContent = 'Room settings';
    } else { rematch.textContent = 'Rematch'; rematch.disabled = false; $('btn-newgame').hidden = false; $('btn-newgame').textContent = 'New game'; }
  }
  $('menu-copy').hidden = !online;
  $('menu-restart').hidden = online;
  $('menu-leave-note').textContent = online ? 'The game keeps going. Rejoin from this link any time' : 'Return to the chess menu';
  $('flip-board').hidden = false;
}

/* ------------------------------------------------------------------ clocks -- */

function fmtClock(ms) {
  if (ms == null) return '∞';
  if (ms < 10000) { const t = Math.floor(ms / 100); return '0:' + String(Math.floor(t / 10)).padStart(2, '0') + '.' + (t % 10); }
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function paintClocks() {
  const g = S.g;
  if (!g) return;
  const now = nowMs();
  for (const [elId, side] of [['pl-bottom', bottomSide()], ['pl-top', other(bottomSide())]]) {
    const card = $(elId), clock = card.querySelector('.ch-clock'), t = clock.firstElementChild;
    const rem = Core.remaining(g, side, now);
    const text = g.unlimited ? '∞' : fmtClock(rem);
    if (t.textContent !== text) t.textContent = text;
    const running = !g.result && g.turnStart != null && Core.turnOf(g) === side;
    clock.classList.toggle('running', running);
    clock.classList.toggle('low', !g.unlimited && rem != null && rem < 10000 && !g.result);
    clock.classList.toggle('untimed', !!g.unlimited);
    clock.setAttribute('aria-label', g.unlimited ? 'No time limit' : cap(side) + ' clock ' + text);
  }
}
let clockTimer = null;
function startClockLoop() {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    if (S.view !== 'game' || !S.g) return;
    const g = S.g;
    if (!g.result) {
      if (S.mode === 'online') {
        const left = Core.remaining(g, Core.turnOf(g), nowMs());
        const due = (g.turnStart != null && !g.unlimited && left <= 0) || (!Core.bothMoved(g) && g.firstDeadline && nowMs() >= g.firstDeadline);
        if (due && Date.now() - S.flagAsked > 1500) { S.flagAsked = Date.now(); sendOnline('game.state'); }
        if (S.room && !Core.bothMoved(g) && g.firstDeadline) renderStatus();
        if (S.room && S.room.players.some((p) => !p.connected)) { renderPlayersTick(); }
      } else if (Core.tick(g, Date.now())) { afterOfflineChange(null, true); return; }
    }
    paintClocks();
  }, 100);
}
let awayTick = 0;
function renderPlayersTick() {
  if (Date.now() - awayTick < 1000) return;
  awayTick = Date.now();
  ensureFens();
  renderPlayers(S.fens[curPly()], curPly());
  renderControls();
}

/* --------------------------------------------------------------- move list -- */

let listKey = '';
function renderMoves() {
  const list = $('move-list'), moves = S.g.moves;
  const analysis = S.analysis && S.analysis.data;
  const key = moves.length + ':' + S.gameId + ':' + (analysis ? 'a' : '') + ':' + (S.analysis ? '1' : '0');
  if (key !== listKey) {
    listKey = key;
    if (!moves.length) list.innerHTML = '<p class="empty-activity">No moves yet. White opens.</p>';
    else {
      let html = '';
      for (let i = 0; i < moves.length; i += 2) {
        const cell = (n) => {
          const m = moves[n];
          if (!m) return '<span class="mv-empty"></span>';
          const j = analysis ? analysis.judged[n] : null;
          const mark = j && MARKS[j.kind].sym && j.kind !== 'best' ? '<i class="mk mk-' + j.kind + '" title="' + MARKS[j.kind].label + '">' + MARKS[j.kind].sym + '</i>' : '';
          return '<button type="button" class="mv" data-ply="' + (n + 1) + '">' + esc(m.san) + mark + '</button>';
        };
        html += '<div class="mv-row"><span class="mv-n">' + (i / 2 + 1) + '.</span>' + cell(i) + cell(i + 1) + '</div>';
      }
      list.innerHTML = html;
    }
  }
  const cur = curPly();
  list.querySelectorAll('.mv.cur').forEach((n) => n.classList.remove('cur'));
  const active = list.querySelector('.mv[data-ply="' + cur + '"]');
  if (active) { active.classList.add('cur'); active.setAttribute('aria-current', 'true'); if (isLive() || S.analysis || true) list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + 14); }
  else if (cur === 0) list.scrollTop = 0;
  $('nav-first').disabled = cur === 0;
  $('nav-prev').disabled = cur === 0;
  $('nav-next').disabled = cur >= plyCount();
  $('nav-last').disabled = cur >= plyCount();
}
function gotoPly(n) {
  const max = plyCount();
  n = Math.max(0, Math.min(max, n));
  const prev = curPly();
  S.viewPly = n === max ? null : n;
  if (n !== prev) { renderGame(); const m = S.g.moves[n - 1]; if (m && n > prev && !S.analysis) sfx(m.san.includes('x') ? 'chessCapture' : 'chessMove'); if (m) announce(m.san); }
}

/* ------------------------------------------------------------ offline play -- */

function fenAtLive() { ensureFens(); return S.fens[plyCount()]; }

function soundForMove(info, ended) {
  if (!info) return;
  if (info.mate) { sfx('chessCapture'); setTimeout(() => sfx('chessMate'), 140); return; }
  sfx(info.castle ? 'chessCastle' : info.captured ? 'chessCapture' : 'chessMove');
  if (info.check) setTimeout(() => sfx('chessCheck'), 110);
}

function afterOfflineChange(info, flagged, before) {
  S.viewPly = null;
  const ended = !!S.g.result;
  if (info) { soundForMove(info, ended); announce(info.san + (info.check ? ', check' : '')); }
  if (ended && !(info && info.mate)) sfx('chessEnd');
  if (S.autoFlip && !ended && S.mode === 'local') board.setOrientation(Core.turnOf(S.g));
  renderGame();
  saveOffline();
  if (ended) onEnded();
  else maybeEngineMove();
}

function saveOffline() {
  if (S.mode === 'online' || !S.g) return;
  writeJSON(OFFLINE_KEY, { mode: S.mode, g: S.g, humanSide: S.humanSide, names: S.names, level: S.engineLevel, autoFlip: S.autoFlip, tcSetup: S.setup, savedAt: Date.now() });
  updateResume();
}
function loadOffline(mode) {
  const saved = readJSON(OFFLINE_KEY, null);
  if (!saved || !saved.g || (mode && saved.mode !== mode)) return null;
  return saved;
}

function startOffline(mode, setup) {
  S.gameId++; S.mode = mode; S.thinking = false; S.analysis = null; S.viewPly = null; S.pending = null; closeAnalysisUi();
  const side = setup.side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : setup.side;
  S.humanSide = side; S.engineLevel = setup.level; S.autoFlip = mode === 'local' && !!setup.autoFlip; S.names = { p1: 'Player 1', p2: 'Player 2' };
  S.g = Core.newGame({ white: side === 'white' ? 'p1' : 'p2', black: side === 'white' ? 'p2' : 'p1', tc: setup.tc, now: Date.now(), firstMoveMs: 0 });
  S.setup = setup;
  if (S.engine) S.engine.newGame();
  openGame();
  board.setOrientation(S.autoFlip ? 'white' : side);
  renderGame({ animate: false });
  sfx('chessStart');
  saveOffline();
  if (mode === 'computer') { warmEngine(); maybeEngineMove(); }
}

function resumeOffline(saved) {
  S.gameId++; S.mode = saved.mode; S.thinking = false; S.analysis = null; S.viewPly = null; S.pending = null; closeAnalysisUi();
  S.g = saved.g; S.humanSide = saved.humanSide; S.names = saved.names || S.names; S.engineLevel = saved.level || 3; S.autoFlip = !!saved.autoFlip; S.setup = saved.tcSetup || prefs.setup;
  if (S.g.turnStart != null && !S.g.result) S.g.turnStart += Date.now() - saved.savedAt; // the clock waited while the page was closed
  openGame();
  board.setOrientation(S.autoFlip ? Core.turnOf(S.g) : S.humanSide);
  renderGame({ animate: false });
  if (S.mode === 'computer') { warmEngine(); maybeEngineMove(); }
}

function openGame() {
  const online = S.mode === 'online';
  $('g-mode').textContent = online ? 'ONLINE ROOM' : S.mode === 'computer' ? 'VS COMPUTER' : 'PASS & PLAY';
  $('game-title').textContent = online ? 'Room ' + S.code : S.mode === 'computer' ? 'Against Stockfish.' : 'Two players, one board.';
  $('tab-btn-chat').hidden = !online;
  document.querySelector('.ch-side').classList.toggle('no-chat', !online);
  selectTab('moves');
  showView('game');
  startClockLoop();
}

/* ------------------------------------------------------------------ engine -- */

function engine() { if (!S.engine) S.engine = new Engine(); return S.engine; }
function warmEngine() { engine().start().catch(() => {}); }

async function maybeEngineMove() {
  if (S.mode !== 'computer' || !S.g || S.g.result || S.thinking) return;
  const side = Core.turnOf(S.g);
  if (side === S.humanSide) return;
  const id = S.gameId;
  S.thinking = true;
  renderStatus(); renderPlayers(fenAtLive(), plyCount());
  const level = LEVELS[S.engineLevel - 1];
  const started = performance.now();
  let res = null;
  try {
    const rem = Core.remaining(S.g, side, Date.now());
    const { movetime, depth } = budgetFor(level, rem);
    res = await engine().go({ fen: fenAtLive(), movetime, depth, options: level.opts });
  } catch (error) {
    if (id === S.gameId) { S.thinking = false; renderStatus(); toast('The chess engine could not start. Check your connection and try again.', 'error'); showEngineRetry(); }
    return;
  }
  const wait = Math.max(0, 380 - (performance.now() - started));
  await new Promise((r) => setTimeout(r, wait));
  if (id !== S.gameId || !S.g || S.g.result) return;
  S.thinking = false;
  if (!res || !res.best) { renderGame(); return; }
  const mv = { from: res.best.slice(0, 2), to: res.best.slice(2, 4), promotion: res.best[4] };
  const before = S.g.moves.length;
  const r = Core.applyMove(S.g, side, mv, Date.now());
  if (!r.ok) { if (r.ended) afterOfflineChange(null, true); else { renderGame(); toast('The engine suggested an unplayable move', 'error'); } return; }
  afterOfflineChange(r.info, false, before);
}
function showEngineRetry() {
  const banner = $('board-banner');
  banner.hidden = false;
  banner.innerHTML = '<span>The engine did not load.</span> <button type="button" class="button" id="engine-retry">Try again</button>';
  $('engine-retry').onclick = () => { banner.hidden = true; if (S.engine) { S.engine.terminate(); S.engine = null; } maybeEngineMove(); };
}

async function engineAcceptsDraw() {
  try {
    const fen = fenAtLive();
    const res = await engine().go({ fen, movetime: 400, options: {} });
    const cp = res.info ? (res.info.kind === 'mate' ? (res.info.value > 0 ? 10000 : -10000) : res.info.value) : 0;
    const engineSide = other(S.humanSide);
    const forEngine = fen.split(' ')[1] === sideLetter(engineSide) ? cp : -cp;
    return forEngine <= 40 && plyCount() >= 16;
  } catch { return false; }
}

/* -------------------------------------------------------------- game ends -- */

function onEnded() {
  S.thinking = false;
  if (S.engine && S.mode === 'computer') S.engine.stop();
  const r = S.g.result;
  if (r && r.reason === 'checkmate') { /* the mate sound already played with the move */ }
}

/* ------------------------------------------------------------ game actions -- */

async function confirmDialog({ eyebrow = 'ARE YOU SURE', title, body, ok = 'Confirm', cancel = 'Cancel' }) {
  const dlg = $('confirm-dialog');
  $('confirm-eyebrow').textContent = eyebrow; $('confirm-heading').textContent = title; $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok; $('confirm-cancel').textContent = cancel;
  return new Promise((resolve) => {
    let result = false;
    const form = $('confirm-form');
    const submit = (e) => { e.preventDefault(); result = true; dlg.close(); };
    const cancelBtn = () => dlg.close();
    const closed = () => { form.removeEventListener('submit', submit); $('confirm-cancel').removeEventListener('click', cancelBtn); dlg.removeEventListener('close', closed); resolve(result); };
    form.addEventListener('submit', submit); $('confirm-cancel').addEventListener('click', cancelBtn); dlg.addEventListener('close', closed);
    dlg.showModal();
  });
}

async function actionAbort() {
  if (S.mode === 'online') { if (await confirmDialog({ title: 'Abort this game?', body: 'No one wins and nothing is recorded. You can only abort before both players have moved.', ok: 'Abort game' })) sendOnline('game.abort'); return; }
  const r = Core.abort(S.g, S.humanSide, Date.now());
  if (r.ok) afterOfflineChange(null, true); else toast(r.error, 'error');
}
async function actionResign() {
  const body = S.mode === 'local' ? 'The player to move resigns and their opponent wins.' : 'Your opponent wins the game.';
  if (!(await confirmDialog({ title: 'Resign?', body, ok: 'Resign' }))) return;
  if (S.mode === 'online') return sendOnline('game.resign');
  const side = S.mode === 'local' ? Core.turnOf(S.g) : S.humanSide;
  const r = Core.resign(S.g, side, Date.now());
  if (r.ok) { sfx('chessEnd'); afterOfflineChange(null, true); } else toast(r.error, 'error');
}
async function actionDraw() {
  if (S.mode === 'online') { sendOnline('game.draw.offer'); toast('Draw offered'); return; }
  if (S.mode === 'local') {
    if (!(await confirmDialog({ eyebrow: 'DRAW', title: 'Agree a draw?', body: 'Both players must agree. Press Draw if you both do.', ok: 'Draw', cancel: 'Keep playing' }))) return;
    Core.endGame(S.g, null, 'agreement', Date.now()); afterOfflineChange(null, true); return;
  }
  toast('Asking Stockfish…');
  if (await engineAcceptsDraw()) { Core.endGame(S.g, null, 'agreement', Date.now()); afterOfflineChange(null, true); }
  else toast('The computer declines the draw', 'error');
}
function rematchOffline() { startOffline(S.mode, Object.assign({}, S.setup || prefs.setup, { side: S.mode === 'computer' ? (S.setup && S.setup.side === 'random' ? 'random' : other(S.humanSide)) : other(S.humanSide), level: S.engineLevel, autoFlip: S.autoFlip })); }

/* ----------------------------------------------------------------- analysis -- */

function closeAnalysisUi() {
  $('analysis-box').hidden = true; $('evalbar').hidden = true; $('board-wrap').classList.remove('has-eval');
  if (board) board.setArrows([]);
}
function stopAnalysis() {
  if (S.analysis) { S.analysis.cancelled = true; if (S.analysis.engine) S.analysis.engine.terminate(); }
  S.analysis = null; listKey = '';
  closeAnalysisUi();
  if (S.g) { renderGame({ animate: false }); }
}
async function startAnalysis() {
  if (!S.g || S.g.moves.length < 2 || S.analysis) return;
  const run = { cancelled: false, data: null, engine: new Engine(), progress: 0 };
  S.analysis = run;
  if (S.engine) S.engine.stop();
  S.viewPly = 0;
  $('analysis-box').hidden = false; $('evalbar').hidden = false; $('board-wrap').classList.add('has-eval');
  $('an-note').textContent = 'Analyzing with Stockfish…'; $('an-bar').style.width = '0%'; $('an-summary').textContent = ''; $('an-graph').textContent = ''; $('an-now').textContent = '';
  $('an-progress').hidden = false;
  listKey = '';
  renderGame({ animate: false });
  try {
    const data = await analyzeGame(run.engine, S.g.moves, {
      movetime: 170, isCancelled: () => run.cancelled,
      onProgress: (p) => { run.progress = p; $('an-bar').style.width = Math.round(p * 100) + '%'; $('an-progress').setAttribute('aria-valuenow', String(Math.round(p * 100))); if (S.analysis === run) { $('an-note').textContent = 'Analyzing… ' + Math.round(p * 100) + '%'; } },
    });
    if (!data || run.cancelled) return;
    run.data = data; run.engine.terminate();
    $('an-progress').hidden = true;
    $('an-note').textContent = 'Stockfish 19 · each position searched at full strength.';
    listKey = '';
    drawGraph(); renderSummary();
    renderGame({ animate: false });
  } catch (error) {
    if (S.analysis === run) { $('an-note').textContent = 'The analysis engine could not start. Try again later.'; $('an-progress').hidden = true; toast('The analysis engine could not start', 'error'); }
  }
}

function renderSummary() {
  const d = S.analysis.data, nm = names();
  const row = (side) => {
    const s = d.summary[side];
    return '<div class="an-side"><b>' + esc(nm[side]) + '</b><span class="an-acc">' + Math.round(s.accuracy) + '%<small>accuracy</small></span>' +
      '<ul><li><i class="mk mk-inaccuracy">?!</i>' + s.inaccuracy + (s.inaccuracy === 1 ? ' inaccuracy' : ' inaccuracies') + '</li><li><i class="mk mk-mistake">?</i>' + s.mistake + (s.mistake === 1 ? ' mistake' : ' mistakes') + '</li><li><i class="mk mk-blunder">??</i>' + s.blunder + (s.blunder === 1 ? ' blunder' : ' blunders') + '</li></ul></div>';
  };
  $('an-summary').innerHTML = row('white') + row('black');
}

function drawGraph() {
  const d = S.analysis.data, n = d.positions.length, W = 300, H = 64;
  const pts = d.positions.map((p, i) => [(i / Math.max(1, n - 1)) * W, H - (winPct(p.cp) / 100) * H]);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'an-svg');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('d', 'M0,' + H + ' L' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' L' + W + ',' + H + ' Z'); area.setAttribute('class', 'an-area');
  const mid = document.createElementNS(NS, 'line'); mid.setAttribute('x1', 0); mid.setAttribute('x2', W); mid.setAttribute('y1', H / 2); mid.setAttribute('y2', H / 2); mid.setAttribute('class', 'an-mid');
  const cursor = document.createElementNS(NS, 'line'); cursor.setAttribute('y1', 0); cursor.setAttribute('y2', H); cursor.setAttribute('class', 'an-cursor'); cursor.setAttribute('id', 'an-cursor');
  svg.append(area, mid, cursor);
  const box = $('an-graph'); box.textContent = ''; box.appendChild(svg);
  box.onclick = (e) => { const r = box.getBoundingClientRect(); gotoPly(Math.round(((e.clientX - r.left) / r.width) * (n - 1))); };
}

function renderAnalysisBits() {
  const an = S.analysis;
  if (!an) return;
  const ply = curPly();
  board.setArrows([]);
  const fill = document.querySelector('.ch-evalbar-fill'), label = document.querySelector('.ch-evalbar-label'), bar = $('evalbar');
  bar.classList.toggle('flip', board.orientation === 'black');
  if (!an.data) { fill.style.height = '50%'; label.textContent = '…'; return; }
  const d = an.data, cp = d.positions[ply].cp;
  fill.style.height = winPct(cp).toFixed(1) + '%';
  label.textContent = formatEval(cp);
  label.classList.toggle('on-white', winPct(cp) >= 50);
  const cursor = $('an-cursor'); if (cursor) { const x = (ply / Math.max(1, d.positions.length - 1)) * 300; cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); }
  let now = '<b>' + formatEval(cp) + '</b> ';
  if (ply === 0) now += 'Starting position';
  else {
    const j = d.judged[ply - 1], m = S.g.moves[ply - 1];
    now += '<span>' + Math.ceil(ply / 2) + (ply % 2 ? '. ' : '… ') + esc(m.san) + '</span> <i class="mk mk-' + j.kind + '">' + (MARKS[j.kind].sym || '•') + '</i> ' + MARKS[j.kind].label;
    if (!j.playedBest && j.best && j.kind !== 'good') {
      now += '<p>Better was <button type="button" class="an-best" data-ply="' + (ply - 1) + '">' + esc(j.bestSan) + '</button></p>';
      board.setArrows([{ from: j.best.slice(0, 2), to: j.best.slice(2, 4), kind: 'best' }]);
    } else if (!j.playedBest && j.best) now += '<p>Engine preferred ' + esc(j.bestSan) + '.</p>';
  }
  $('an-now').innerHTML = now;
}

/* ------------------------------------------------------------- online room -- */

const tokenKey = (code) => 'parcheesi:chess:' + code;
function rememberRoom(code) { writeJSON(LAST_ROOM_KEY, { code, at: Date.now() }); updateResume(); }
function sendOnline(type, data = {}) {
  const ws = S.socket;
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type, ...data })); return true; }
  toast('Reconnecting — try again in a moment', 'error');
  scheduleReconnect();
  return false;
}
function quietSend(type, data) { const ws = S.socket; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); }

function openSocket(code) {
  closeSocket();
  S.intentional = false; S.code = code;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/ws/chess/' + code); } catch { toast('Could not reach the game server', 'error'); return; }
  S.socket = ws; setNetwork('connecting');
  const timer = setTimeout(() => { try { ws.close(); } catch {} }, 8000);
  ws.onopen = () => {
    clearTimeout(timer); S.attempts = 0;
    ws.send(JSON.stringify({ type: 'room.join', invite: code, playerToken: S.token, name: S.joinName || playerName() || 'Player' }));
  };
  ws.onmessage = (event) => { try { onServer(JSON.parse(event.data)); } catch (error) { console.error(error); } };
  ws.onclose = () => {
    clearTimeout(timer);
    if (S.socket !== ws) return;
    if (S.intentional || S.mode !== 'online') { setNetwork(); return; }
    setNetwork('reconnecting'); renderPlayersSafe();
    scheduleReconnect();
  };
  ws.onerror = () => {};
}
function closeSocket() {
  clearTimeout(S.reconnectTimer);
  if (S.socket) { S.intentional = true; try { S.socket.close(); } catch {} S.socket = null; }
}
function scheduleReconnect() {
  if (S.reconnectTimer || S.intentional || S.mode !== 'online' || !S.code) return;
  const delay = Math.min(700 * Math.pow(1.7, S.attempts), 10000);
  S.attempts++;
  S.reconnectTimer = setTimeout(async () => {
    S.reconnectTimer = null;
    if (S.intentional || S.mode !== 'online') return;
    const gone = await roomStatus(S.code);
    if (gone && gone.exists === false) { toast('This room has expired', 'error'); leaveOnline(true); return; }
    openSocket(S.code);
  }, delay);
}
function renderPlayersSafe() { if (S.g && S.view === 'game') { ensureFens(); renderPlayers(S.fens[curPly()], curPly()); } }

async function roomStatus(code) {
  try { const res = await fetch('/api/chess/room/' + code, { cache: 'no-store' }); return await res.json(); } catch { return null; }
}

function onServer(m) {
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'voice.state' || m.type === 'voice.signal') { if (V) V.handle(m); return; }
  if (m.type === 'room.error') { onServerError(m.error); return; }
  if (m.type === 'room.closed') { toast('The host closed this room'); leaveOnline(true); return; }
  if (m.type === 'room.left') { leaveOnline(true); return; }
  if (m.type === 'chat.message') { onChat(m); return; }
  if (typeof m.sequence === 'number' && m.type !== 'room.joined') { if (m.sequence < S.seq) return; }
  if (typeof m.serverNow === 'number') { const sample = m.serverNow - Date.now(); S.offset = S.offsetSet ? S.offset * 0.7 + sample * 0.3 : sample; S.offsetSet = true; }
  if (m.type === 'room.joined') {
    S.seq = m.sequence; S.token = m.playerToken; S.playerId = m.playerId; S.myColor = m.playerColor;
    try { localStorage.setItem(tokenKey(m.invite), m.playerToken); } catch {}
    rememberRoom(m.invite);
    S.chat = m.chat || []; renderChat(true);
    applyRoom(m.room, null, true);
    if (V) V.onRoom();
    return;
  }
  if (m.type === 'room.snapshot') { S.seq = Math.max(S.seq, m.sequence); applyRoom(m.room, m.event, false); }
}

function onServerError(text) {
  S.pending = null;
  if (S.joining) { S.joining = false; toast(text, 'error'); leaveOnline(true); return; }
  toast(text, 'error');
  sfx('chessIllegal');
  if (S.room && S.view === 'game') sendOnline('game.state');
}

function applyRoom(room, event, joined) {
  const prev = S.room;
  room.receivedAt = Date.now();
  S.room = room; S.joining = false;
  const me = room.players.find((p) => p.id === S.playerId);
  S.mySide = me ? me.side : null;
  S.myColor = me ? me.color : S.myColor;
  if (S.mode !== 'online') { S.mode = 'online'; S.code = room.invite; }
  // Presence sounds.
  if (prev && event && event.type === 'presence' && event.player !== S.playerId) sfx(event.connected ? 'chessJoin' : 'chessLeave');
  if (room.status === 'lobby') {
    S.g = null; S.gameNo = room.gameNo; S.pending = null; S.rematchSent = false;
    if (S.analysis) stopAnalysis();
    renderLobby(); showView('lobby'); if (V) V.decorate();
    return;
  }
  // A game is running or finished.
  const newGame = room.gameNo !== S.gameNo || !S.g;
  const prevLen = S.g ? S.g.moves.length : 0;
  S.g = fromPublic(room.game);
  if (newGame) {
    S.gameNo = room.gameNo; S.gameId++; S.viewPly = null; S.pending = null; if (S.analysis) stopAnalysis(); listKey = '';
    $('board-banner').hidden = true;
  }
  if (S.pending && S.g.moves.length >= S.pending.ply) S.pending = null;
  if (S.view !== 'game') openGame();
  if (newGame) { board.setOrientation(S.mySide || 'white'); }
  S.humanSide = S.mySide || 'white';
  // Sounds for what the other side did.
  if (event) {
    if (event.type === 'start' && newGame) sfx('chessStart');
    if (event.type === 'move' && event.move && event.move.color !== S.mySide) { soundForMove(event.move, event.ended); announce(event.move.san); }
    else if (event.type === 'move' && event.ended && event.move && event.move.mate) { /* own mate: sound already played */ }
    if (event.type === 'end' || (event.type === 'move' && event.ended)) { if (!(event.move && event.move.mate)) sfx('chessEnd'); }
    if (event.type === 'draw-offer' && event.by !== S.mySide) { sfx('chessJoin'); toast(names()[event.by] + ' offers a draw'); }
    if (event.type === 'draw-declined' && event.by !== S.mySide) toast('Draw declined');
  }
  if (S.g.moves.length < prevLen) S.viewPly = null;
  renderGame({ animate: !newGame && !joined });
  if (joined || event) if (V) V.decorate();
}

function playOnline(mv) {
  const side = Core.turnOf(S.g);
  if (side !== S.mySide) return false;
  const chess = new Chess(fenAtLive());
  let made;
  try { made = chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion }); } catch { sfx('chessIllegal'); return false; }
  const ply = plyCount();
  S.pending = { ply: ply + 1 };
  soundForMove({ captured: made.captured, castle: made.san.indexOf('O-O') === 0, check: chess.inCheck(), mate: chess.isCheckmate() }, false);
  board.setPosition(chess.fen(), { lastMove: [made.from, made.to], check: chess.inCheck() ? chess.turn() : null, animate: !mv.dropped });
  if (!sendOnline('game.move', { from: mv.from, to: mv.to, promotion: mv.promotion, ply })) { S.pending = null; renderGame(); return false; }
  // If the server never answers, fall back to the authoritative position.
  const id = S.gameId;
  setTimeout(() => { if (S.pending && S.pending.ply === ply + 1 && S.gameId === id) { S.pending = null; sendOnline('game.state'); } }, 4000);
  return true;
}

/* ------------------------------------------------------------------- lobby -- */

function tcButtons(container, selected, onPick, disabled) {
  container.innerHTML = TC_ORDER.map((id) => {
    const tc = Core.TIME_CONTROLS[id];
    const sub = id === 'unlimited' ? 'No clock' : id === '2+1' ? '2 min + 1 s' : tc.base / 60000 + ' min';
    const main = id === 'unlimited' ? '∞' : id;
    return '<button type="button" class="ch-tc" role="radio" data-tc="' + id + '" aria-checked="' + (id === selected) + '"' + (disabled ? ' disabled' : '') + '><b>' + main + '</b><small>' + sub + '</small></button>';
  }).join('');
  container.onclick = (e) => { const b = e.target.closest('.ch-tc'); if (!b || b.disabled) return; container.querySelectorAll('.ch-tc').forEach((x) => x.setAttribute('aria-checked', String(x === b))); onPick(b.dataset.tc); };
}
function segmented(container, selected, onPick, disabled) {
  container.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.side === selected)); b.disabled = !!disabled; });
  container.onclick = (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; container.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); onPick(b.dataset.side); };
}

function renderLobby() {
  const room = S.room;
  const host = room.host === S.playerId;
  $('room-code').textContent = room.invite;
  const full = room.players.length === 2;
  const ready = full && room.players.every((p) => p.connected);
  $('lobby-heading').textContent = full ? 'Ready when you are.' : 'Waiting for your opponent.';
  $('lobby-status').textContent = !full ? 'WAITING FOR AN OPPONENT' : ready ? 'READY TO PLAY' : 'OPPONENT RECONNECTING';
  const seats = [0, 1].map((i) => {
    const p = room.players[i];
    if (!p) return '<div class="player-seat seat-empty"><span class="seat-dot color-muted"></span><div class="seat-info"><b>Open seat</b><small>Waiting for a friend…</small></div></div>';
    return '<div class="player-seat" data-color="' + p.color + '"><span class="seat-dot ' + (p.color === 'p1' ? 'color-yellow' : 'color-blue') + '"></span><div class="seat-info"><b>' + esc(p.name) + (p.id === S.playerId ? ' (you)' : '') + '</b><small>' + (p.host ? 'HOST · ' : '') + (p.connected ? 'CONNECTED' : 'RECONNECTING') + '</small></div></div>';
  });
  $('player-grid').innerHTML = seats.join('');
  segmented($('lobby-side'), room.settings.side, (v) => sendOnline('lobby.settings', { side: v }), !host);
  tcButtons($('lobby-tc'), room.settings.tc, (v) => sendOnline('lobby.settings', { tc: v }), !host);
  $('side-hint').textContent = host ? 'The side you will play. Random is picked when the game starts.' : 'The host has picked how the sides are decided.';
  $('rule-tc').textContent = room.settings.tc === 'unlimited' ? 'UNLIMITED' : room.settings.tc.replace('+', ' + ').toUpperCase();
  $('rule-side').textContent = room.settings.side.toUpperCase();
  $('rule-voice').hidden = !room.voice;
  $('start-game').disabled = !(host && ready);
  $('close-room').hidden = !host;
  $('lobby-hint').textContent = !full ? 'Share the link. The game starts when you press Start.' : !ready ? 'Waiting for your opponent to reconnect.' : host ? 'Everything is set. Press Start when you are ready.' : 'Waiting for the host to start the game.';
  S.myColor = (room.players.find((p) => p.id === S.playerId) || {}).color || S.myColor;
}
function roomUrl() { return location.origin + '/chess/room/' + S.code; }
async function copyText(text, okMessage) {
  try { await navigator.clipboard.writeText(text); toast(okMessage, 'success'); }
  catch { window.prompt('Copy this:', text); }
}

async function createRoom(form) {
  const err = $('create-error'); err.hidden = true;
  const name = cleanName($('create-name').value);
  if (!name) { err.textContent = 'Please enter a name.'; err.hidden = false; return; }
  rememberName(name);
  $('create-confirm').disabled = true;
  try {
    const res = await fetch('/api/chess/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, voice: $('create-voice').checked, tc: form.tc, side: form.side }) });
    const data = await res.json();
    if (!res.ok || !data.code) throw new Error(data.error || 'Could not create a room');
    try { localStorage.setItem(tokenKey(data.code), data.playerToken); } catch {}
    $('create-dialog').close();
    go('/chess/room/' + data.code);
  } catch (error) { err.textContent = error.message || 'Could not create a room'; err.hidden = false; }
  finally { $('create-confirm').disabled = false; }
}

async function enterRoom(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  resetOnlineState();
  S.mode = 'online'; S.code = code;
  let token = null;
  try { token = localStorage.getItem(tokenKey(code)); } catch {}
  showView('menu'); // keeps the page calm while we check the room
  const status = await roomStatus(code);
  if (!status) { toast('Could not reach the game server', 'error'); S.mode = null; go('/chess/', true); return; }
  if (!status.exists) { S.mode = null; go('/chess/', true); roomProblem('This room link is invalid or has expired.'); return; }
  if (!token && !status.joinable) { S.mode = null; go('/chess/', true); roomProblem(status.status === 'playing' ? 'That game has already started.' : 'That room is full.'); return; }
  S.token = token; S.joining = true;
  if (!token) { openJoinDialog(code); return; }
  S.joinName = playerName() || 'Player';
  openSocket(code);
}
function roomProblem(text) { $('join-note').textContent = text; toast(text, 'error'); }

function resetOnlineState() {
  closeSocket();
  S.room = null; S.token = null; S.playerId = null; S.mySide = null; S.seq = -1; S.pending = null; S.chat = []; S.unread = 0; S.offsetSet = false; S.gameNo = 0; S.joining = false;
  renderChat(true);
  if (V) V.reset();
}
function leaveOnline(toMenu) {
  const code = S.code;
  resetOnlineState();
  if (S.analysis) stopAnalysis();
  S.mode = null; S.g = null;
  if (toMenu) go('/chess/', true);
  updateResume();
}

/* -------------------------------------------------------------------- chat -- */

function renderChat(reset) {
  const list = $('chat-list');
  if (reset || !S.chat.length) { list.innerHTML = '<p class="empty-chat">Say hello. Chat stays out of the way of the board.</p>'; }
  if (!S.chat.length) return;
  list.innerHTML = S.chat.map(chatHtml).join('');
  list.scrollTop = list.scrollHeight;
}
function chatHtml(c) {
  const t = new Date(c.at), hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  return '<div class="chat-line' + (c.playerId === S.playerId ? ' is-mine' : '') + '"><i class="seat-dot ' + (c.color === 'p1' ? 'color-yellow' : 'color-blue') + '"></i><b>' + esc(c.player) + '</b><span>' + esc(c.text) + ' <time datetime="' + t.toISOString() + '">' + hh + '</time></span></div>';
}
function onChat(m) {
  if (S.chat.some((c) => c.id === m.id)) return;
  S.chat.push({ id: m.id, player: m.player, color: m.color, playerId: m.playerId, text: m.text, at: m.at });
  if (S.chat.length > 80) S.chat.shift();
  const list = $('chat-list');
  if (list.querySelector('.empty-chat')) list.textContent = '';
  list.insertAdjacentHTML('beforeend', chatHtml(S.chat[S.chat.length - 1]));
  list.scrollTop = list.scrollHeight;
  if (m.playerId !== S.playerId) {
    sfx('chessChat');
    const narrow = window.matchMedia('(max-width: 999px)').matches;
    if (S.view === 'game' && narrow && $('tab-chat').classList.contains('is-active') === false) { S.unread++; paintBadge(); }
  }
}
function paintBadge() { const b = $('chat-badge'); b.hidden = !S.unread; b.textContent = S.unread; }
function selectTab(name) {
  document.querySelectorAll('.ch-tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $('tab-moves').classList.toggle('is-active', name === 'moves');
  $('tab-chat').classList.toggle('is-active', name === 'chat');
  if (name === 'chat') { S.unread = 0; paintBadge(); const l = $('chat-list'); l.scrollTop = l.scrollHeight; }
}
function sendChat() {
  const input = $('chat-input'), text = input.value.trim();
  if (!text) return;
  if (sendOnline('chat.send', { text })) input.value = '';
}

/* ----------------------------------------------------------------- dialogs -- */

function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); return d; }

function buildSetup(mode) {
  const dlg = $('setup-dialog');
  const s = Object.assign({}, prefs.setup);
  dlg.dataset.mode = mode;
  $('setup-eyebrow').textContent = mode === 'computer' ? 'PLAY THE COMPUTER' : 'PASS & PLAY';
  $('setup-heading').textContent = mode === 'computer' ? 'Choose your opponent.' : 'Set up the board.';
  $('setup-side-title').textContent = mode === 'computer' ? 'You play' : 'Player 1 plays';
  $('setup-level-block').hidden = mode !== 'computer';
  $('setup-flip-row').hidden = mode !== 'local';
  $('setup-autoflip').checked = !!s.autoFlip;
  $('setup-levels').innerHTML = LEVELS.map((l) => '<button type="button" class="ch-level" role="radio" data-level="' + l.id + '" aria-checked="' + (l.id === s.level) + '"><span class="ch-level-n">' + l.id + '</span><span class="ch-level-t"><b>' + l.name + '</b><small>' + l.blurb + '</small></span><em>' + l.rating + '</em></button>').join('');
  $('setup-levels').onclick = (e) => { const b = e.target.closest('.ch-level'); if (!b) return; s.level = Number(b.dataset.level); $('setup-levels').querySelectorAll('.ch-level').forEach((x) => x.setAttribute('aria-checked', String(x === b))); };
  segmented($('setup-side'), s.side, (v) => { s.side = v; });
  tcButtons($('setup-tc'), s.tc, (v) => { s.tc = v; });
  $('setup-error').hidden = true;
  $('setup-form').onsubmit = (e) => {
    e.preventDefault();
    s.autoFlip = $('setup-autoflip').checked;
    prefs.setup = Object.assign({}, prefs.setup, s); savePrefs();
    dlg.close();
    startOffline(mode, Object.assign({}, s));
    go('/chess/' + mode, false, true);
  };
  openDialog('setup-dialog');
}

function openCreateDialog() {
  const dlg = $('create-dialog');
  const f = { side: prefs.setup.side, tc: prefs.setup.tc };
  $('create-name').value = playerName();
  segmented($('create-side'), f.side, (v) => { f.side = v; });
  tcButtons($('create-tc'), f.tc, (v) => { f.tc = v; });
  $('create-error').hidden = true;
  $('create-form').onsubmit = (e) => { e.preventDefault(); prefs.setup.side = f.side; prefs.setup.tc = f.tc; savePrefs(); createRoom(f); };
  openDialog('create-dialog');
}

function openJoinDialog(code) {
  const dlg = $('join-dialog');
  $('join-code').value = code || '';
  $('join-code-field').hidden = !!code;
  $('join-name').value = playerName();
  $('join-note').textContent = code ? 'You were invited to room ' + code + '. Choose a name to sit down.' : 'Enter the room code your friend shared with you.';
  $('join-error').hidden = true;
  $('join-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('join-error'); err.hidden = true;
    const raw = $('join-code').value || code || '';
    const clean = String(raw).toUpperCase().replace(/.*\/ROOM\//, '').replace(/[^A-Z0-9]/g, '');
    if (clean.length < 8) { err.textContent = 'Room codes have eight characters.'; err.hidden = false; return; }
    const name = cleanName($('join-name').value) || 'Player';
    rememberName(name); S.joinName = name;
    dlg.close();
    if (code) { S.token = null; S.joining = true; openSocket(clean); }
    else go('/chess/room/' + clean);
  };
  openDialog('join-dialog');
}

/* ------------------------------------------------------------------- menu --- */

function updateResume() {
  const off = loadOffline();
  const last = readJSON(LAST_ROOM_KEY, null);
  let online = null;
  if (last && last.code && Date.now() - last.at < 24 * 3600 * 1000) { try { if (localStorage.getItem(tokenKey(last.code))) online = last; } catch {} }
  const offlineLive = off && !off.g.result;
  const btn = $('m-resume');
  btn.hidden = !(online || offlineLive);
  if (online && (!offlineLive || last.at > off.savedAt)) { btn.dataset.kind = 'online'; btn.dataset.code = online.code; $('m-resume-detail').textContent = 'Room ' + online.code; }
  else if (offlineLive) { btn.dataset.kind = 'offline'; btn.dataset.mode = off.mode; $('m-resume-detail').textContent = off.mode === 'computer' ? 'Game against the computer' : 'Pass & play'; }
}

let demoTimer = null, demoBoard = null, demoStep = 0;
const DEMO = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8'];
function startDemo() {
  if (!demoBoard) { demoBoard = new Board($('menu-board'), { getTargets: () => [], canMove: () => false, animate: () => !prefs.motion }); }
  const chess = new Chess();
  const seq = [chess.fen()];
  for (const u of DEMO) { chess.move({ from: u.slice(0, 2), to: u.slice(2, 4) }); seq.push(chess.fen()); }
  demoBoard.demo = seq;
  const show = () => { demoBoard.setPosition(seq[demoStep % seq.length], { lastMove: demoStep ? [DEMO[(demoStep - 1) % DEMO.length].slice(0, 2), DEMO[(demoStep - 1) % DEMO.length].slice(2, 4)] : null, animate: demoStep % seq.length !== 0 }); };
  show();
  clearInterval(demoTimer);
  if (!prefs.motion) demoTimer = setInterval(() => { if (document.hidden || S.view !== 'menu') return; demoStep = (demoStep + 1) % seq.length; show(); }, 1700);
}
function stopDemo() { clearInterval(demoTimer); demoTimer = null; }

/* ----------------------------------------------------------------- routing -- */

function go(path, replace, silent) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  if (!silent) route();
}
function leaveToMenu() {
  if (S.mode === 'online') { closeSocket(); S.room = S.room; }
  stopAnalysis();
  if (S.engine && S.mode === 'computer') S.engine.stop();
  S.thinking = false; S.gameId++;
  if (S.mode === 'online') { const keep = S.code; resetOnlineState(); S.code = keep; }
  S.mode = null; S.g = null;
  updateResume();
  go('/chess/');
}

function route() {
  const path = location.pathname.replace(/\/+$/, '');
  const room = /^\/chess\/room\/([A-Za-z0-9_-]+)$/.exec(path);
  $('board-banner').hidden = true;
  if (room) { if (S.mode === 'online' && S.code && S.code === room[1].toUpperCase() && S.room) return; enterRoom(room[1]); return; }
  if (S.mode === 'online') { closeSocket(); const keep = S.code; resetOnlineState(); S.mode = null; S.g = null; S.code = keep; }
  if (path === '/chess/local' || path === '/chess/computer') {
    const mode = path.endsWith('computer') ? 'computer' : 'local';
    if (S.g && S.mode === mode && S.view === 'game') return;
    const saved = loadOffline(mode);
    if (saved && !saved.g.result) { resumeOffline(saved); return; }
    S.mode = null; showView('menu'); buildSetup(mode); return;
  }
  S.mode = null; S.g = null;
  showView('menu'); updateResume();
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  // Close buttons on every dialog.
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  });
  $('setup-dialog').addEventListener('close', () => { if (S.view === 'menu' && /\/chess\/(local|computer)$/.test(location.pathname)) go('/chess/', true); });
  $('join-dialog').addEventListener('close', () => { if (S.joining && !S.socket && S.view === 'menu') { S.joining = false; go('/chess/', true); } });

  $('m-friends').onclick = openCreateDialog;
  $('m-join').onclick = () => openJoinDialog('');
  $('m-computer').onclick = () => buildSetup('computer');
  $('m-local').onclick = () => buildSetup('local');
  $('m-resume').onclick = () => {
    const b = $('m-resume');
    if (b.dataset.kind === 'online') go('/chess/room/' + b.dataset.code);
    else { const saved = loadOffline(); if (saved) { go('/chess/' + saved.mode, false, true); resumeOffline(saved); } }
  };

  $('lobby-back').onclick = leaveToMenu;
  $('copy-invite').onclick = () => copyText(roomUrl(), 'Link copied');
  $('copy-code').onclick = () => copyText(S.code, 'Code copied');
  $('share-invite').onclick = async () => { if (navigator.share) { try { await navigator.share({ title: 'Chess on PARCHEESI', text: 'Join my chess game', url: roomUrl() }); return; } catch (e) { if (e && e.name === 'AbortError') return; } } copyText(roomUrl(), 'Link copied'); };
  $('start-game').onclick = () => sendOnline('lobby.start');
  $('rename-self').onclick = () => { $('name-input').value = (S.room && S.room.players.find((p) => p.id === S.playerId) || {}).name || playerName(); openDialog('name-dialog'); };
  $('name-form').onsubmit = (e) => { e.preventDefault(); const n = cleanName($('name-input').value); if (!n) return; rememberName(n); sendOnline('lobby.rename', { name: n }); $('name-dialog').close(); };
  $('close-room').onclick = async () => { if (await confirmDialog({ title: 'Close this room?', body: 'The link stops working for everyone.', ok: 'Close room' })) sendOnline('room.close'); };

  // Game view.
  $('g-back').onclick = onBack;
  $('g-menu').onclick = () => openDialog('menu-dialog');
  $('btn-abort').onclick = actionAbort;
  $('btn-resign').onclick = actionResign;
  $('btn-draw').onclick = actionDraw;
  $('btn-claim').onclick = () => sendOnline('game.claim');
  $('draw-accept').onclick = () => sendOnline('game.draw.accept');
  $('draw-decline').onclick = () => sendOnline('game.draw.decline');
  $('btn-analyze').onclick = startAnalysis;
  $('an-close').onclick = stopAnalysis;
  $('btn-rematch').onclick = () => { if (S.mode === 'online') sendOnline('game.rematch'); else rematchOffline(); };
  $('btn-newgame').onclick = () => { if (S.mode === 'online') sendOnline('lobby.back'); else buildSetup(S.mode); };
  $('nav-first').onclick = () => gotoPly(0);
  $('nav-prev').onclick = () => gotoPly(curPly() - 1);
  $('nav-next').onclick = () => gotoPly(curPly() + 1);
  $('nav-last').onclick = () => gotoPly(plyCount());
  $('flip-board').onclick = flip;
  $('move-list').addEventListener('click', (e) => { const b = e.target.closest('.mv'); if (b) gotoPly(Number(b.dataset.ply)); });
  $('an-now').addEventListener('click', (e) => { const b = e.target.closest('.an-best'); if (b) gotoPly(Number(b.dataset.ply)); });
  document.querySelectorAll('.ch-tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('chat-send').onclick = sendChat;
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

  // Game menu.
  $('menu-copy').onclick = () => { $('menu-dialog').close(); copyText(roomUrl(), 'Link copied'); };
  $('menu-theme').onclick = () => { prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]; savePrefs(); applyPrefs(); };
  $('menu-sound').onclick = () => { prefs.sound = !prefs.sound; savePrefs(); applyPrefs(); fillSettings(); };
  $('menu-flip').onclick = () => { $('menu-dialog').close(); flip(); };
  $('menu-fullscreen').onclick = () => { $('menu-dialog').close(); if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available here', 'error')); };
  $('menu-restart').onclick = () => { $('menu-dialog').close(); buildSetup(S.mode); };
  $('menu-leave').onclick = () => { $('menu-dialog').close(); onBack(); };

  // Settings.
  $('settings-open').onclick = () => { fillSettings(); openDialog('settings-dialog'); };
  $('sound-toggle').onclick = () => { prefs.sound = !prefs.sound; savePrefs(); applyPrefs(); if (prefs.sound) sfx('chessMove'); };
  document.querySelectorAll('input[name="ctheme"]').forEach((r) => r.addEventListener('change', () => { prefs.theme = r.value; savePrefs(); applyPrefs(); }));
  $('set-sound').onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); applyPrefs(); if (prefs.sound) sfx('chessMove'); };
  $('set-volume').oninput = (e) => { prefs.volume = Number(e.target.value); savePrefs(); applyPrefs(); };
  $('set-volume').onchange = () => sfx('chessMove');
  $('set-motion').onchange = (e) => { prefs.motion = e.target.checked; savePrefs(); applyPrefs(); startDemo(); };
  $('set-coords').onchange = (e) => { prefs.coords = e.target.checked; savePrefs(); applyPrefs(); };
  $('set-legal').onchange = (e) => { prefs.legal = e.target.checked; savePrefs(); if (board) board.paintMarks(); };
  $('set-queen').onchange = (e) => { prefs.queen = e.target.checked; savePrefs(); };

  // A soft tap under buttons, like the rest of the site.
  document.addEventListener('click', (e) => { const c = e.target.closest('button, .menu-item'); if (c && !c.disabled && !c.closest('#board')) sfx('click'); });

  document.addEventListener('keydown', (e) => {
    if (S.view !== 'game' || !S.g || e.target.closest('input, textarea, dialog')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); gotoPly(curPly() - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); gotoPly(curPly() + 1); }
    else if (e.key === 'Home') { e.preventDefault(); gotoPly(0); }
    else if (e.key === 'End') { e.preventDefault(); gotoPly(plyCount()); }
    else if (e.key === 'f' || e.key === 'F') flip();
  });
  window.addEventListener('popstate', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.mode === 'online' && S.code && (!S.socket || S.socket.readyState > 1) && !S.intentional) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; openSocket(S.code); } });
  window.addEventListener('online', () => { if (S.mode === 'online' && S.code && !S.intentional && (!S.socket || S.socket.readyState > 1)) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; openSocket(S.code); } });
  window.addEventListener('pagehide', () => { if (S.socket) { S.intentional = true; try { S.socket.close(); } catch {} } });
  window.addEventListener('pageshow', (e) => { if (e.persisted && S.mode === 'online' && S.code) { S.intentional = false; openSocket(S.code); } });
}

function flip() { if (!board) return; board.flip(); if (S.g) renderGame({ animate: false }); }

async function onBack() {
  if (S.mode === 'online') {
    if (S.room && S.room.status === 'playing' && S.mySide && !S.g.result) {
      if (!(await confirmDialog({ title: 'Leave the game?', body: 'Leaving does not resign. Your clock keeps running and the room stays open. Use the room link to come back.', ok: 'Leave', cancel: 'Stay' }))) return;
    }
    leaveToMenu(); return;
  }
  if (S.g && !S.g.result && Core.bothMoved(S.g)) {
    if (!(await confirmDialog({ title: 'Leave this game?', body: 'Your game is saved on this device. You can resume it from the chess menu.', ok: 'Leave', cancel: 'Stay' }))) return;
  }
  leaveToMenu();
}

// The voice module speaks to the app through this small adapter.
function initVoice() {
  if (!V) return;
  V.init({ room: () => S.room, color: () => S.myColor, isLocal: () => S.mode !== 'online', toast, send: (type, data) => quietSend(type, data) });
}

function init() {
  applyPrefs();
  makeBoard();
  wire();
  initVoice();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateResume();
  route();
}
init();
