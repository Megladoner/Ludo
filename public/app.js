'use strict';

/* ==========================================================================
   PARCHEESI — client
   Sections: state · utils · preferences · audio · profile · dialogs
             network · board · rendering · actions · wiring
   ========================================================================== */

const E = window.LudoEngine;
const P = window.ParcheesiProfile;
const V = window.ParcheesiVoice;
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const A = window.ParcheesiAudio;
// Token colours are cosmetic. Seats (and the rules) never change; each seat just wears a colour.
const SKINS = ['red', 'green', 'yellow', 'blue', 'purple', 'orange', 'teal', 'pink'];

// Every colour also wears its own small mark, so tokens never rely on hue alone.
const MARK_SHAPES = {
  red: ['circle'],
  green: ['polygon', [0, -1, 0.95, 0.75, -0.95, 0.75]],
  yellow: ['polygon', [-0.8, -0.8, 0.8, -0.8, 0.8, 0.8, -0.8, 0.8]],
  blue: ['polygon', [0, -1, 0.9, 0, 0, 1, -0.9, 0]],
  purple: ['path', 'M0 -1V1M-1 0H1'],
  orange: ['path', 'M-0.8 -0.8L0.8 0.8M0.8 -0.8L-0.8 0.8'],
  teal: ['polygon', [0, -1, 0.95, -0.3, 0.6, 0.85, -0.6, 0.85, -0.95, -0.3]],
  pink: ['polygon', [-1, 0, -0.5, -0.87, 0.5, -0.87, 1, 0, 0.5, 0.87, -0.5, 0.87]],
};
const SKIN_NAMES = { red: 'Ruby', green: 'Sage', yellow: 'Amber', blue: 'Cobalt', purple: 'Violet', orange: 'Ember', teal: 'Lagoon', pink: 'Rose' };
// Cube rotation [x, y] that brings each face to the front.
const DIE_TURN = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
const DIE_PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const TUMBLE_MIN = 420;
const SETTLE_MS = 520;
const BASE = {red:[[1.5,1.5],[3.5,1.5],[1.5,3.5],[3.5,3.5]],green:[[10.5,1.5],[12.5,1.5],[10.5,3.5],[12.5,3.5]],yellow:[[10.5,10.5],[12.5,10.5],[10.5,12.5],[12.5,12.5]],blue:[[1.5,10.5],[3.5,10.5],[1.5,12.5],[3.5,12.5]]};
const YARD = {red:[-.5,-.5],green:[8.5,-.5],yellow:[8.5,8.5],blue:[-.5,8.5]};
const DIR = {red:[-1,0],green:[0,-1],yellow:[1,0],blue:[0,1]};
const STACK_OFFSETS = [[0,0],[-.2,-.2],[.2,-.2],[-.2,.2],[.2,.2]];
const VIEWS = ['home-view','lobby-view','game-view','result-view'];

const state = {
  socket: null, room: null, token: null, color: null, game: null,
  local: false, ai: false, aiDifficulty: 'normal', mode: '', gameMode: 'local',
  activity: [], inviteUrl: '', seenLen: null, diceAnim: null,
  pendingJoin: null, reconnectTimer: null, reconnectAttempts: 0,
  intentionalClose: false, chatUnread: 0, sequence: -1,
  resultRecorded: false, autoMoveTimer: null, moveLock: 0, finishedSeen: [],
  chat: [], resuming: false,
  skins: {}, fx: null, lastTurn: null, rolling: false,
};

/* ---------------------------------------------------------------- utils -- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function cleanName(value) {
  const printable = String(value ?? '').split('').filter((ch) => { const code = ch.codePointAt(0); return code > 31 && code !== 127; }).join('');
  return printable.replace(/[<>]/g, '').trim().slice(0, 20);
}
function readJSON(key, fallback) {
  try { const parsed = JSON.parse(localStorage.getItem(key) || 'null'); return parsed ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function legacyName() { try { return localStorage.getItem('parcheesi.name') || ''; } catch { return ''; } }

function view(id) {
  VIEWS.forEach((v) => $(v).classList.toggle('hidden', v !== id));
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(message, kind = 'info') {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('is-error', 'is-success');
  if (kind === 'error') node.classList.add('is-error');
  if (kind === 'success') node.classList.add('is-success');
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function playerName() {
  const stored = P.get().name;
  if (stored) return stored;
  return legacyName() || 'Player';
}
function setPlayerName(name) {
  P.setName(name);
  try { localStorage.setItem('parcheesi.name', name); } catch {}
  syncAvatar();
}
function syncAvatar() {
  const name = playerName();
  $('avatar-initial').textContent = (name[0] || 'P').toUpperCase();
  const photo = P.getPhoto();
  const image = $('avatar-photo');
  if (photo) { image.src = photo; image.hidden = false; $('avatar-initial').hidden = true; }
  else { image.hidden = true; $('avatar-initial').hidden = false; }
}

/* ---------------------------------------------------------- preferences -- */

const THEMES = ['noir', 'classic', 'forest'];
const DEFAULT_PREFS = { motion: false, sound: true, theme: 'noir', volume: 80 };
let prefs = (() => {
  const stored = readJSON('parcheesi.settings', {});
  const merged = { ...DEFAULT_PREFS, ...stored };
  if (!THEMES.includes(merged.theme)) merged.theme = 'noir';
  merged.volume = Number.isFinite(Number(merged.volume)) ? Math.max(0, Math.min(100, Number(merged.volume))) : 80;
  return merged;
})();

function applyPrefs(next) {
  const root = document.documentElement;
  root.dataset.theme = next.theme;
  root.classList.toggle('reduced-motion', !!next.motion);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#08090b');
  if (A) { A.setEnabled(next.sound); A.setVolume((next.volume == null ? 80 : next.volume) / 100); }
  const soundState = $('menu-sound-state');
  if (soundState) soundState.textContent = next.sound ? 'On' : 'Off';
  const motionState = $('menu-motion-state');
  if (motionState) motionState.textContent = next.motion ? 'On' : 'Off';
}
function readForm() {
  const theme = document.querySelector('input[name="theme"]:checked');
  return { motion: $('motion-setting').checked, sound: $('sound-setting').checked, theme: theme ? theme.value : 'noir', volume: Number($('volume-setting').value) };
}
function fillForm(settings) {
  $('motion-setting').checked = !!settings.motion;
  $('sound-setting').checked = !!settings.sound;
  $('volume-setting').value = String(settings.volume == null ? 80 : settings.volume);
  const option = document.querySelector(`input[name="theme"][value="${settings.theme}"]`) || document.querySelector('input[name="theme"][value="noir"]');
  if (option) option.checked = true;
}
function savePrefs(settings) {
  prefs = { motion: !!settings.motion, sound: !!settings.sound, theme: THEMES.includes(settings.theme) ? settings.theme : 'noir', volume: Number.isFinite(Number(settings.volume)) ? Math.max(0, Math.min(100, Number(settings.volume))) : 80 };
  writeJSON('parcheesi.settings', prefs);
  applyPrefs(prefs);
}
function openSettings() {
  fillForm(prefs);
  $('settings-dialog').showModal();
}

/* --------------------------------------------------------------- audio -- */

// All sounds are synthesised in audio.js. Without it the table simply plays silent.
const sfx = A ? A.sfx : new Proxy({}, { get: () => () => {} });

/* --------------------------------------------------------------- skins -- */

function savedSkin() { const value = readJSON('parcheesi.skin', null); return SKINS.includes(value) ? value : 'red'; }
function saveSkin(value) { if (SKINS.includes(value)) writeJSON('parcheesi.skin', value); }
function skinOf(seat) {
  if (!seat) return 'red';
  if (state.local) return state.skins[seat] || seat;
  const player = state.room?.players.find((p) => p.color === seat);
  return (player && player.skin) || seat;
}
function swatchButtons(current, taken) {
  return SKINS.map((key) => {
    const owner = taken ? taken(key) : null;
    return '<button type="button" class="swatch k-' + key + '" data-skin="' + key + '" role="radio" aria-checked="' + (key === current) + '"' +
      ' aria-label="' + SKIN_NAMES[key] + (owner ? ', taken by ' + esc(owner) : '') + '" title="' + SKIN_NAMES[key] + (owner ? ' · ' + esc(owner) : '') + '"' +
      (owner ? ' disabled' : '') + '></button>';
  }).join('');
}

/* -------------------------------------------------------------- confetti -- */

const confetti = {
  canvas: null, ctx: null, particles: [], frame: null,
  init() {
    this.canvas = $('confetti');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  },
  resize() {
    if (!this.canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * ratio);
    this.canvas.height = Math.floor(window.innerHeight * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  },
  colors() {
    const root = getComputedStyle(document.documentElement);
    return ['--red', '--green', '--yellow', '--blue', '--accent']
      .map((name) => root.getPropertyValue(name).trim())
      .filter(Boolean);
  },
  burst(count, origin) {
    if (!this.ctx) return;
    const colors = this.colors();
    const scale = prefs.motion ? 0.25 : 1;
    const total = Math.round(count * scale);
    for (let i = 0; i < total; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 9;
      this.particles.push({
        x: origin.x + (Math.random() - 0.5) * 40,
        y: origin.y + (Math.random() - 0.5) * 24,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 5,
        size: 4 + Math.random() * 7,
        color: colors[Math.floor(Math.random() * colors.length)] || '#e5dbc7',
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.34,
        life: 1,
        decay: 0.006 + Math.random() * 0.008,
        square: Math.random() > 0.45,
      });
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  },
  tick() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const particle of this.particles) {
      particle.vy += 0.34;
      particle.vx *= 0.99;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.spin;
      particle.life -= particle.decay;
      if (particle.life <= 0) continue;
      this.ctx.save();
      this.ctx.globalAlpha = Math.max(0, Math.min(1, particle.life));
      this.ctx.translate(particle.x, particle.y);
      this.ctx.rotate(particle.rotation);
      this.ctx.fillStyle = particle.color;
      if (particle.square) this.ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.62);
      else { this.ctx.beginPath(); this.ctx.ellipse(0, 0, particle.size / 2, particle.size / 3, 0, 0, Math.PI * 2); this.ctx.fill(); }
      this.ctx.restore();
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
    if (this.particles.length) this.frame = requestAnimationFrame(() => this.tick());
    else { this.frame = null; this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  },
  celebrate(kind) {
    if (!this.ctx) return;
    const center = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
    if (kind === 'win') {
      this.burst(150, center);
      this.burst(60, { x: center.x - window.innerWidth * 0.28, y: center.y });
      this.burst(60, { x: center.x + window.innerWidth * 0.28, y: center.y });
    } else {
      this.burst(70, center);
    }
  },
};

/* -------------------------------------------------------------- profile -- */

function profileStats() { return P.get().stats; }

function paintProfileAvatar(photo, name) {
  const holder = $('profile-avatar');
  const initials = $('profile-initials');
  holder.querySelectorAll('img').forEach((node) => node.remove());
  initials.hidden = false;
  initials.textContent = (String(name || 'P')[0] || 'P').toUpperCase();
  if (photo) {
    const image = document.createElement('img');
    image.src = photo;
    image.alt = '';
    holder.appendChild(image);
    initials.hidden = true;
  }
}

function renderProfileStats() {
  const stats = profileStats();
  const cards = [
    { label: 'MATCHES', value: stats.total.played, cls: '' },
    { label: 'WON', value: stats.total.won, cls: 'is-won' },
    { label: 'LOST', value: stats.total.lost, cls: 'is-lost' },
  ];
  const summary = $('profile-stats');
  summary.innerHTML = cards.map((card) =>
    '<div class="stat-card ' + card.cls + '"><b>' + card.value + '</b><span>' + card.label + '</span></div>'
  ).join('') +
    '<div class="rule-line"><span>AGAINST THE COMPUTER</span><b>' + stats.computer.played + ' played · ' + stats.computer.won + ' won</b></div>' +
    '<div class="rule-line"><span>AGAINST FRIENDS</span><b>' + stats.friends.played + ' played · ' + stats.friends.won + ' won</b></div>';
}

function renderProfileHistory() {
  const history = P.get().history;
  const list = $('profile-history');
  $('profile-history-count').textContent = history.length ? history.length + ' RECORDED' : 'NONE YET';
  if (!history.length) {
    list.innerHTML = '<p class="profile-history-empty">Play a table and it will show up here.</p>';
    return;
  }
  list.innerHTML = history.map((entry) => {
    const outcome = entry.outcome === 'won' ? 'WON' : entry.outcome === 'lost' ? 'LOST' : 'PLAYED';
    const cls = entry.outcome === 'won' ? 'is-won' : entry.outcome === 'lost' ? 'is-lost' : 'is-draw';
    const when = new Date(entry.at);
    const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return '<div class="profile-match">' +
      '<span class="profile-match-name">' + esc(entry.label || (entry.mode === 'computer' ? 'Against the computer' : 'Against friends')) + '</span>' +
      '<small>' + esc(date) + '</small>' +
      '<span class="profile-outcome ' + cls + '">' + outcome + '</span></div>';
  }).join('');
}

function openProfile() {
  const stored = P.get();
  $('profile-name').value = stored.name || '';
  const photo = P.getPhoto();
  paintProfileAvatar(photo, stored.name || playerName());
  $('profile-photo-remove').hidden = !photo;
  renderProfileStats();
  renderProfileHistory();
  $('profile-dialog').showModal();
}

function saveProfile() {
  const name = cleanName($('profile-name').value);
  P.setName(name);
  try { localStorage.setItem('parcheesi.name', name); } catch {}
  syncAvatar();
  renderProfileStats();
  renderProfileHistory();
  toast('Profile saved', 'success');
}

function recordMatch(mode, outcome, opponents, label) {
  P.recordMatch({ mode, outcome, opponents, label });
}

/* ------------------------------------------------------------- dialogs -- */

function setDialogError(id, message) {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

/** Show the name dialog and resolve with the chosen name (or null when cancelled). */
function askName(options = {}) {
  const dialog = $('name-dialog');
  const form = $('name-form');
  const input = $('name-input');
  $('name-eyebrow').textContent = options.eyebrow || 'YOUR SEAT';
  $('name-heading').textContent = options.heading || 'What should we call you?';
  $('name-note').textContent = options.note || 'This is the name the other players will see.';
  $('name-confirm').textContent = options.confirm || 'Continue';
  $('name-voice-row').hidden = !options.voiceOption;
  $('name-voice').checked = false;
  input.value = options.value !== undefined ? options.value : playerName();
  setDialogError('name-error', '');
  $('name-count').textContent = String(input.value.length);
  dialog.showModal();
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const value = cleanName(input.value);
      if (!value) { setDialogError('name-error', 'Please enter a name for your seat.'); input.focus(); return; }
      dialog.close();
      finish(value);
    };
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

/** Show the table setup dialog. mode: 'local' (pass & play) or 'ai'. */
function askSetup(mode) {
  const dialog = $('setup-dialog');
  const form = $('setup-form');
  const namesBox = $('setup-names');
  const aiBlock = $('setup-ai-block');
  const options = [...$('setup-counts').querySelectorAll('.seat-option')];
  const difficulties = [...$('setup-difficulty').querySelectorAll('button')];

  let count = 4;
  let difficulty = state.aiDifficulty || 'normal';
  const skins = {};
  E.PLAYER_IDS.forEach((id, index) => { skins[id] = SKINS[index]; });
  const chooseSkin = (seat, skin) => {
    const other = Object.keys(skins).find((key) => key !== seat && skins[key] === skin);
    if (other) skins[other] = skins[seat];
    skins[seat] = skin;
  };
  chooseSkin(E.PLAYER_IDS[0], savedSkin());

  $('setup-eyebrow').textContent = mode === 'ai' ? 'CHALLENGE THE TABLE' : 'PASS & PLAY';
  $('setup-heading').textContent = mode === 'ai' ? 'How tough a table?' : 'How many players?';
  $('setup-note').textContent = mode === 'ai'
    ? 'You take the first seat. Pick the colour of your tokens; the rest of the table plays the house.'
    : 'Everyone shares this device. Each player picks the colour of their own tokens.';
  $('setup-confirm').textContent = mode === 'ai' ? 'Take your seat →' : 'Deal the cards →';
  aiBlock.hidden = mode !== 'ai';

  const paintOptions = () => {
    options.forEach((option) => option.setAttribute('aria-checked', String(Number(option.dataset.count) === count)));
    difficulties.forEach((option) => option.setAttribute('aria-checked', String(option.dataset.difficulty === difficulty)));
  };
  const draft = {};
  let openSeat = E.PLAYER_IDS[0];
  const paintNames = () => {
    const ids = E.PLAYER_IDS.slice(0, count);
    const aiNames = mode === 'ai' ? E.pickAiNames(Math.max(0, count - 1)) : [];
    namesBox.innerHTML = '';
    ids.forEach((id, index) => {
      const isAi = mode === 'ai' && index > 0;
      const row = document.createElement('div');
      row.className = 'setup-name' + (isAi ? ' is-ai' : '') + (id === openSeat ? ' is-open' : '');
      row.dataset.row = id;
      const dot = document.createElement('span');
      dot.className = 'seat-dot color-' + skins[id];
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.dataset.seat = id;
      if (isAi && draft[id] === undefined) draft[id] = aiNames[index - 1];
      input.value = draft[id] ?? (index === 0 ? playerName() : 'Player ' + (index + 1));
      input.readOnly = isAi;
      input.setAttribute('aria-label', 'Name for the ' + id + ' seat');
      input.addEventListener('input', () => { draft[id] = input.value; });
      row.append(dot, input);
      if (!isAi) {
        const picker = document.createElement('div');
        picker.className = 'swatches swatches-inline';
        picker.setAttribute('role', 'radiogroup');
        picker.setAttribute('aria-label', 'Token colour for ' + (input.value || 'this seat'));
        picker.dataset.seat = id;
        picker.innerHTML = swatchButtons(skins[id], null);
        row.appendChild(picker);
      }
      namesBox.appendChild(row);
    });
  };
  // Only the seat being edited shows its colours, so a four-player sheet stays short.
  const openRow = (id) => {
    openSeat = id;
    namesBox.querySelectorAll('.setup-name').forEach((row) => row.classList.toggle('is-open', row.dataset.row === id));
  };
  const onNameFocus = (event) => { const row = event.target.closest('.setup-name'); if (row) openRow(row.dataset.row); };
  const onNameClick = (event) => { const row = event.target.closest('.setup-name'); if (row && event.target.closest('.seat-dot')) openRow(row.dataset.row); };
  namesBox.addEventListener('focusin', onNameFocus);
  namesBox.addEventListener('click', onNameClick);
  paintOptions();
  paintNames();

  dialog.showModal();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      namesBox.removeEventListener('focusin', onNameFocus);
      namesBox.removeEventListener('click', onNameClick);
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onOption = (event) => {
      const option = event.target.closest('.seat-option');
      if (option) { count = Number(option.dataset.count); paintOptions(); paintNames(); return; }
      const swatch = event.target.closest('.swatch[data-skin]');
      if (swatch) {
        const holder = swatch.closest('[data-seat]');
        if (holder) { chooseSkin(holder.dataset.seat, swatch.dataset.skin); paintNames(); }
        return;
      }
      const tier = event.target.closest('#setup-difficulty button');
      if (tier) { difficulty = tier.dataset.difficulty; paintOptions(); }
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const names = {};
      namesBox.querySelectorAll('input[data-seat]').forEach((input) => { names[input.dataset.seat] = cleanName(input.value) || 'Player'; });
      const chosen = {};
      E.PLAYER_IDS.slice(0, count).forEach((id) => { chosen[id] = skins[id]; });
      saveSkin(skins[E.PLAYER_IDS[0]]);
      dialog.close();
      finish({ count, names, difficulty, skins: chosen });
    };
    const onClose = () => finish(null);
    dialog.addEventListener('click', onOption);
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

/** Generic confirmation dialog. Resolves true when confirmed. */
function confirmAction({ eyebrow = 'ARE YOU SURE', heading = 'Are you sure?', body = '', confirm = 'Confirm', danger = false } = {}) {
  const dialog = $('confirm-dialog');
  const form = $('confirm-form');
  $('confirm-eyebrow').textContent = eyebrow;
  $('confirm-heading').textContent = heading;
  $('confirm-body').textContent = body;
  const ok = $('confirm-ok');
  ok.textContent = confirm;
  ok.classList.toggle('button-primary', !danger);
  ok.classList.toggle('button-danger', danger);
  dialog.showModal();
  requestAnimationFrame(() => ok.focus());
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onSubmit = (event) => { event.preventDefault(); dialog.close(); finish(true); };
    const onClose = () => finish(false);
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

/* -------------------------------------------------------------- network -- */

function setNetwork(status) {
  const pill = $('connection-pill');
  const indicator = $('network-status');
  const label = $('network-label');
  const map = {
    idle: ['READY TO PLAY', 'CONNECTED', 'is-ready'],
    connecting: ['CONNECTING…', 'CONNECTING', 'is-reconnecting'],
    connected: ['CONNECTED', 'CONNECTED', 'is-online'],
    reconnecting: ['RECONNECTING…', 'RECONNECTING', 'is-reconnecting'],
    offline: ['OFFLINE', 'DISCONNECTED', 'is-offline'],
  };
  const [networkText, pillText, klass] = map[status] || map.idle;
  if (label) label.textContent = networkText;
  if (pill) { pill.innerHTML = '<i></i> ' + pillText; pill.className = 'connection-pill ' + klass; }
  if (indicator) indicator.className = 'online-indicator ' + klass;
}

function connect({ rejoin = false } = {}) {
  return new Promise((resolve, reject) => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) return resolve(state.socket);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/ws'); }
    catch { return reject(new Error('Could not connect to game server')); }
    state.socket = ws;
    setNetwork('connecting');
    let opened = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} if (!opened) reject(new Error('Connection timed out')); }, 6000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      state.reconnectAttempts = 0;
      setNetwork('connected');
      if (rejoin && state.room) {
        const token = localStorage.getItem('parcheesi:' + state.room.invite) || state.token;
        ws.send(JSON.stringify({ type: 'room.join', invite: state.room.invite, playerToken: token, name: playerName() }));
      }
      resolve(ws);
    };
    ws.onmessage = (event) => { try { message(JSON.parse(event.data)); } catch {} };
    ws.onclose = () => {
      clearTimeout(timer);
      if (state.intentionalClose) { setNetwork('idle'); return; }
      if (state.room) { setNetwork('reconnecting'); scheduleReconnect(); }
      else setNetwork('offline');
    };
    ws.onerror = () => { clearTimeout(timer); };
  });
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(900 * Math.pow(1.8, state.reconnectAttempts), 12000);
  state.reconnectAttempts += 1;
  state.reconnectTimer = setTimeout(() => {
    connect({ rejoin: true }).catch(() => scheduleReconnect());
  }, delay);
}

function send(type, data = {}) {
  const payload = JSON.stringify({ type, ...data });
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(payload);
    return true;
  }
  if (state.room) {
    setNetwork('reconnecting');
    scheduleReconnect();
    toast('Still reconnecting — try again in a moment', 'error');
  } else {
    toast('Not connected to the game server', 'error');
  }
  return false;
}

function rememberRoom(invite) {
  writeJSON('parcheesi.lastRoom', { invite, at: Date.now() });
  $('resume-room').hidden = false;
  $('resume-detail').textContent = 'Room ' + invite;
}

function message(m) {
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'voice.state' || m.type === 'voice.signal') { if (V) V.handle(m); return; }
  // Drop frames that a slower connection delivered out of order.
  if (typeof m.sequence === 'number') {
    if (m.sequence < state.sequence) return;
    state.sequence = m.sequence;
  }

  if (m.type === 'room.created' || m.type === 'room.joined') {
    state.room = m.room;
    state.seenLen = null;
    state.token = m.playerToken;
    state.color = m.playerColor;
    state.local = false;
    state.gameMode = 'friends';
    try { localStorage.setItem('parcheesi:' + m.invite, m.playerToken); } catch {}
    state.inviteUrl = location.origin + '/room/' + m.invite;
    rememberRoom(m.invite);
    closeJoinDialog();
    if (V) V.onRoom();
    if (m.room.status === 'playing' || m.room.status === 'finished') {
      // The table is already running. A reconnect — after a dropped signal, a
      // reload or a screenshot — has to land back in the game, not in the lobby.
      state.game = m.room.state;
      renderGame();
      if (m.room.status === 'finished') result();
      else { view('game-view'); maybeAutoMove(); }
    } else {
      state.resultRecorded = false;
      state.finishedSeen = [];
      renderLobby();
      view('lobby-view');
    }
    return;
  }

  if (m.type === 'room.snapshot') {
    if (!state.room) return;
    state.room = m.room;
    if (m.room.status === 'playing' || m.room.status === 'finished') {
      state.game = m.room.state;
      state.local = false;
      renderGame();
      if (m.room.status === 'finished') result();
      else { view('game-view'); maybeAutoMove(); }
    } else {
      renderLobby();
      view('lobby-view');
    }
    return;
  }

  if (m.type === 'game.started' || m.type === 'game.update') {
    state.room = m.room;
    state.game = m.room.state;
    if (m.event && m.event.type === 'roll') { if (!state.diceAnim) startDiceTumble(); landDice(m.event.roll); }
    if (m.type === 'game.started') { state.resultRecorded = false; state.finishedSeen = []; }
    renderGame();
    if (state.game.status === 'finished') result();
    else if (m.type === 'game.started') view('game-view');
    else maybeAutoMove();
    return;
  }

  if (m.type === 'room.error') {
    stopDice();
    if (state.pendingJoin) { showJoinError(m.error || 'That invitation did not work'); return; }
    if (state.resuming) {
      // The saved seat is gone. Clear it so the player is not pulled into a room
      // that no longer exists on every page load.
      state.resuming = false;
      $('resume-room').hidden = true;
      toast('That table has closed', 'error');
      return;
    }
    toast(m.error || 'Something went wrong', 'error');
    return;
  }

  if (m.type === 'room.closed') { resetRoom(); view('home-view'); toast('The table was closed', 'error'); return; }
  if (m.type === 'room.kicked') { resetRoom(); view('home-view'); toast('You were removed from the table', 'error'); return; }
  if (m.type === 'chat.message') {
    addChat(m.text, m.player, m.color, m.player === playerName());
  }
}

function resetRoom() {
  state.fx = null;
  state.lastTurn = null;
  inflight.clear();
  state.room = null;
  state.game = null;
  state.token = null;
  state.color = null;
  state.seenLen = null;
  state.local = false;
  state.sequence = -1;
  state.resultRecorded = false;
  state.chat = [];
  renderChat();
  if (V) V.reset();
  clearTimeout(state.autoMoveTimer);
  layoutCache.clear();
}

/* ------------------------------------------------------------ dialogs flow -- */

function openJoinDialog(code) {
  const dialog = $('join-dialog');
  $('join-code').value = code || $('join-code').value || '';
  $('player-name').value = playerName();
  setDialogError('join-error', '');
  $('join-confirm').disabled = false;
  $('join-confirm').textContent = 'Join room →';
  dialog.showModal();
  requestAnimationFrame(() => $('join-code').focus());
}

function showJoinError(message) {
  if (!state.pendingJoin) { toast(message, 'error'); return; }
  setDialogError('join-error', message);
  const button = $('join-confirm');
  button.disabled = false;
  button.textContent = 'Join room →';
  $('join-code').focus();
}

function closeJoinDialog() {
  state.pendingJoin = false;
  const dialog = $('join-dialog');
  if (dialog.open) dialog.close();
}

/* ------------------------------------------------------------ rendering -- */

const layoutCache = new Map();

function renderLobby() {
  const room = state.room;
  if (!room) return;
  $('room-code').textContent = room.invite;
  $('lobby-status').textContent = room.status.toUpperCase();
  const ready = room.players.filter((p) => p.ready).length;
  $('lobby-hint').textContent = room.players.length + ' of 4 seats filled · ' + ready + ' ready';
  const me = room.players.find((p) => p.color === state.color);
  const isHost = room.host === me?.id;
  $('start-game').disabled = !(isHost && room.players.length >= 2 && room.players.every((p) => p.ready));
  $('toggle-ready').textContent = me?.ready ? 'Not ready' : 'Ready up';
  $('toggle-ready').disabled = !me;
  $('rename-self').disabled = !me;

  const grid = $('player-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const player = room.players[i];
    const seat = document.createElement('div');
    seat.className = 'player-seat' + (!player ? ' seat-empty' : '');
    if (player) {
      seat.dataset.color = player.color;
      seat.dataset.skin = player.skin || player.color;
      const kick = isHost && !player.host
        ? `<button class="seat-kick" data-kick="${esc(player.id)}" aria-label="Remove ${esc(player.name)}" title="Remove">×</button>`
        : '';
      seat.innerHTML =
        '<span class="seat-dot color-' + (player.skin || player.color) + '"></span>' +
        '<div class="seat-info"><b>' + esc(player.name) + (player.host ? ' · HOST' : '') + '</b>' +
        '<small>' + (player.connected ? 'CONNECTED' : 'RECONNECTING') + ' · ' + SKIN_NAMES[player.skin || player.color].toUpperCase() + '</small></div>' +
        '<span class="seat-ready">' + (player.ready ? 'READY' : 'NOT READY') + '</span>' + kick;
    } else {
      seat.innerHTML = '<span class="seat-dot color-muted"></span><div class="seat-info"><b>Open seat</b><small>INVITE A FRIEND</small></div>';
    }
    grid.appendChild(seat);
  }
  renderSkinPicker();
  if (V) V.decorate();
}

function renderSkinPicker() {
  const room = state.room;
  const box = $('skin-picker');
  if (!room || !box) return;
  const me = room.players.find((p) => p.color === state.color);
  $('skin-block').hidden = !me || room.status !== 'lobby';
  if (!me) return;
  const mine = me.skin || me.color;
  box.innerHTML = swatchButtons(mine, (key) => {
    const owner = room.players.find((p) => p.id !== me.id && (p.skin || p.color) === key);
    return owner ? owner.name : null;
  });
}

// Every seat wears a colour. Empty seats borrow whichever colours nobody else uses.
function skinMap(game) {
  const map = {};
  const used = new Set();
  game.players.forEach((p) => { map[p.id] = skinOf(p.id); used.add(map[p.id]); });
  const free = SKINS.filter((key) => !used.has(key));
  E.PLAYER_IDS.forEach((id) => { if (!map[id]) map[id] = free.shift() || id; });
  return map;
}

// The square a token stands on at a given progress (ignores stacking offsets).
function coordFor(seat, progress) {
  if (progress >= E.FINISH_PROGRESS) return [7, 7];
  if (progress >= E.HOME_ENTRY_PROGRESS) return E.HOME_COORDS[seat][progress - E.HOME_ENTRY_PROGRESS];
  return E.TRACK_COORDS[E.globalTrackIndex(seat, progress)];
}

// A walk of n squares takes about a second at most, however long it is.
function hopTiming(steps) {
  const step = Math.max(110, Math.min(200, 1100 / Math.max(1, steps)));
  return { step, total: step * steps };
}

// Where a token would stand after a given amount of progress (same coordinates the tokens use).
function cellFor(playerId, progress) {
  if (progress === E.FINISH_PROGRESS) return [7, 7];
  if (progress >= E.HOME_ENTRY_PROGRESS) return E.HOME_COORDS[playerId][progress - E.HOME_ENTRY_PROGRESS];
  return E.TRACK_COORDS[E.globalTrackIndex(playerId, progress)];
}

function computeLayout(game, interactive) {
  const turn = game.players[game.currentPlayer];
  const legal = interactive && game.awaitingMove ? E.legalMoves(game) : [];
  const items = [];
  game.players.forEach((player) => player.tokens.forEach((progress, index) => {
    let x, y, r = 0.36, done = false;
    if (progress === -1) { [x, y] = BASE[player.id][index]; r = 0.4; }
    else if (progress === E.FINISH_PROGRESS) {
      const d = DIR[player.id], k = (index - 1.5) * 0.22;
      x = 7 + d[0] * 0.55 - d[1] * k; y = 7 + d[1] * 0.55 + d[0] * k; r = 0.17; done = true;
    } else if (progress >= E.HOME_ENTRY_PROGRESS) {
      [x, y] = E.HOME_COORDS[player.id][progress - E.HOME_ENTRY_PROGRESS];
    } else {
      [x, y] = E.TRACK_COORDS[E.globalTrackIndex(player.id, progress)];
    }
    items.push({
      player, index, x, y, r, progress, share: progress >= 0 && !done,
      can: player.id === turn?.id && legal.includes(index),
      dim: legal.length > 0 && player.id === turn?.id && !legal.includes(index),
      dest: player.id === turn?.id && legal.includes(index) && progress + game.dice <= E.FINISH_PROGRESS
        ? cellFor(player.id, progress === -1 ? 0 : progress + game.dice) : null,
      homeward: progress >= E.HOME_ENTRY_PROGRESS && progress < E.FINISH_PROGRESS,
    });
  }));
  const groups = {};
  items.forEach((item) => { if (item.share) (groups[item.x + ',' + item.y] = groups[item.x + ',' + item.y] || []).push(item); });
  Object.values(groups).forEach((group) => {
    if (group.length > 1) group.forEach((item, n) => {
      const offset = STACK_OFFSETS[Math.min(n + 1, 4)];
      item.x += offset[0]; item.y += offset[1]; item.r *= 0.72;
    });
  });
  return items;
}

/* ------------------------------------------------------- token motion -- */

const inflight = new Map(); // token key -> the motion in progress, so a redraw can pick it up again

function planMotion(prev, item) {
  if (!prev) return null;
  const moved = Math.abs(prev.x - item.x) > 0.001 || Math.abs(prev.y - item.y) > 0.001;
  if (!moved) return null;
  const seat = item.player.id;
  const a = prev.progress, b = item.progress;
  if (a >= 0 && b > a && b - a <= 6) {
    // Walk it square by square, hopping.
    const pts = [[prev.x, prev.y]];
    for (let p = a + 1; p < b; p++) pts.push(coordFor(seat, p));
    pts.push([item.x, item.y]);
    const timing = hopTiming(pts.length - 1);
    return { kind: 'hop', pts, duration: timing.total, delay: 0 };
  }
  if (a === -1 && b === 0) return { kind: 'hop', pts: [[prev.x, prev.y], [item.x, item.y]], duration: 520, delay: 0, big: true };
  if (b === -1 && a >= 0) return { kind: 'home', pts: [[prev.x, prev.y], [item.x, item.y]], duration: 720, delay: 0 };
  return { kind: 'glide', pts: [[prev.x, prev.y], [item.x, item.y]], duration: 420, delay: 0 };
}

function runMotion(group, body, shadow, plan, elapsed) {
  const n = plan.pts.length - 1;
  const opts = { duration: plan.duration, delay: plan.delay || 0, fill: 'backwards' };
  const ease = plan.kind === 'hop' ? 'cubic-bezier(.4,.1,.6,.9)' : 'cubic-bezier(.3,.7,.2,1)';
  const running = [group.animate(plan.pts.map((p, i) => ({
    offset: i / n, transform: 'translate(' + p[0] + 'px, ' + p[1] + 'px)', easing: ease,
  })), opts)];
  if (plan.kind === 'hop') {
    const lift = plan.big ? 0.9 : 0.4;
    const bodyFrames = [], shadowFrames = [];
    for (let i = 0; i < n; i++) {
      bodyFrames.push({ offset: i / n, transform: 'translateY(0px) scale(1, 1)' });
      bodyFrames.push({ offset: (i + 0.45) / n, transform: 'translateY(' + -lift + 'px) scale(1.14, 1.14)' });
      bodyFrames.push({ offset: (i + 0.88) / n, transform: 'translateY(0px) scale(1.1, .86)' });
      shadowFrames.push({ offset: i / n, transform: 'scale(1)', opacity: 1 });
      shadowFrames.push({ offset: (i + 0.45) / n, transform: 'scale(.62)', opacity: 0.45 });
      shadowFrames.push({ offset: (i + 0.88) / n, transform: 'scale(1.08)', opacity: 1 });
    }
    bodyFrames.push({ offset: 1, transform: 'translateY(0px) scale(1, 1)' });
    shadowFrames.push({ offset: 1, transform: 'scale(1)', opacity: 1 });
    running.push(body.animate(bodyFrames, opts), shadow.animate(shadowFrames, opts));
  } else if (plan.kind === 'home') {
    running.push(body.animate([
      { offset: 0, transform: 'rotate(0deg) scale(1)', opacity: 1 },
      { offset: 0.4, transform: 'rotate(190deg) scale(1.3)', opacity: 1 },
      { offset: 1, transform: 'rotate(420deg) scale(1)', opacity: 1 },
    ], opts));
  }
  if (elapsed > 0) running.forEach((anim) => { anim.currentTime = elapsed; });
}

function board(target, game, interactive) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-.5 -.5 15 15');
  svg.setAttribute('class', 'board-svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Parcheesi board. Select a highlighted token to move it.');
  svg.innerHTML = '<defs><radialGradient id="tok-gloss" cx=".34" cy=".28" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".62"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient></defs>';

  const make = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  };
  const el = (tag, attrs, text) => { const node = make(tag, attrs, text); svg.appendChild(node); return node; };

  const skins = skinMap(game);
  const active = new Set(game.players.map((p) => p.id));
  el('rect', { x: -0.5, y: -0.5, width: 15, height: 15, rx: 0.6, class: 'b-board' });
  E.PLAYER_IDS.forEach((color) => {
    const [x, y] = YARD[color];
    const idle = active.has(color) ? '' : ' is-idle';
    el('rect', { x, y, width: 6, height: 6, rx: 0.6, class: 'b-yard c-' + skins[color] + idle });
    el('rect', { x: x + 0.7, y: y + 0.7, width: 4.6, height: 4.6, rx: 0.5, class: 'b-yard-in' + idle });
    BASE[color].forEach(([cx, cy]) => el('circle', { cx, cy, r: 0.62, class: 'b-pad' + idle }));
  });
  E.TRACK_COORDS.forEach(([x, y], i) => {
    const start = E.PLAYER_IDS.find((c) => E.START_OFFSETS[c] === i);
    const safe = E.SAFE_TRACK.has(i);
    el('rect', { x: x - 0.46, y: y - 0.46, width: 0.92, height: 0.92, rx: 0.14, class: 'b-cell' + (safe ? ' is-safe' : '') + (start ? ' is-start c-' + skins[start] : '') });
    if (safe) el('text', { x, y: y + 0.03, class: 'b-star' + (start ? ' on-start' : '') }, '✦');
  });
  E.PLAYER_IDS.forEach((color) => E.HOME_COORDS[color].slice(0, 5).forEach(([x, y]) => {
    el('rect', { x: x - 0.46, y: y - 0.46, width: 0.92, height: 0.92, rx: 0.14, class: 'b-lane c-' + skins[color] });
  }));
  [['red', '5.5,5.5 7,7 5.5,8.5'], ['green', '5.5,5.5 8.5,5.5 7,7'], ['yellow', '8.5,5.5 8.5,8.5 7,7'], ['blue', '5.5,8.5 8.5,8.5 7,7']].forEach(([color, points]) => {
    el('polygon', { points, class: 'b-tri c-' + skins[color] });
  });

  // The home square of whoever is on turn wears a bold frame.
  const onTurn = game.status === 'playing' ? game.players[game.currentPlayer] : null;
  if (onTurn) {
    const [ax, ay] = YARD[onTurn.id];
    el('rect', { x: ax - 0.1, y: ay - 0.1, width: 6.2, height: 6.2, rx: 0.7, class: 'b-yard-frame' });
    el('rect', { x: ax - 0.02, y: ay - 0.02, width: 6.04, height: 6.04, rx: 0.64, class: 'b-yard-frame-inner c-' + skins[onTurn.id] + ' b-yard-frame-pulse' });
  }

  // The squares the last token walked over glow for a moment, one after another.
  const now = performance.now();
  const fx = state.fx && now - state.fx.at < 2000 ? state.fx : null;
  if (fx && !prefs.motion) {
    const elapsed = (now - fx.at) / 1000;
    fx.trail.forEach(([x, y], i) => {
      const cell = el('rect', { x: x - 0.46, y: y - 0.46, width: 0.92, height: 0.92, rx: 0.14, class: 'b-trail c-' + fx.skin });
      cell.style.animationDelay = (i * fx.step / 1000 - elapsed).toFixed(3) + 's';
    });
  }

  const items = computeLayout(game, interactive);
  const plans = new Map();
  items.forEach((item) => {
    const plan = planMotion(layoutCache.get(item.player.id + ':' + item.index), item);
    if (plan && !prefs.motion) plans.set(item.player.id + ':' + item.index, plan);
  });
  // A token sent home waits until the capturing token has landed.
  const lead = Math.max(0, ...[...plans.values()].filter((p) => p.kind !== 'home').map((p) => p.duration));
  plans.forEach((plan) => { if (plan.kind === 'home') plan.delay = lead; });

  // Show where each movable token would land, under the tokens.
  items.forEach((item) => { if (item.dest) svg.appendChild(make('circle', { cx: item.dest[0], cy: item.dest[1], r: 0.3, class: 'b-dest' })); });

  const nextLayout = new Map();
  items.sort((a, b) => a.can - b.can).forEach((item) => {
    const key = item.player.id + ':' + item.index;
    nextLayout.set(key, { x: item.x, y: item.y, progress: item.progress });
    const group = make('g', { class: 'token-g' + (item.dim ? ' is-dim' : '') });
    const shadow = make('ellipse', { cx: 0, cy: item.r * 0.62, rx: item.r * 0.92, ry: item.r * 0.4, class: 'token-shadow' });
    group.appendChild(shadow);
    if (item.can) {
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.13, class: 'b-ring b-ring-dark' }));
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.13, class: 'b-ring' }));
    }
    if (item.homeward) {
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.18, class: 'b-ring b-homeward' }));
    }
    const body = make('g', { class: 'token-body' });
    body.appendChild(make('circle', { cx: 0, cy: 0, r: item.r, class: 'token c-' + skins[item.player.id] }));
    body.appendChild(make('circle', { cx: 0, cy: 0, r: item.r * 0.62, class: 'token-ring' }));
    body.appendChild(make('circle', { cx: 0, cy: 0, r: item.r, class: 'token-gloss' }));
    const shape = MARK_SHAPES[skins[item.player.id]] || MARK_SHAPES.red;
    const k = item.r * 0.4;
    if (shape[0] === 'circle') body.appendChild(make('circle', { cx: 0, cy: 0, r: k * 0.8, class: 'token-mark' }));
    else if (shape[0] === 'polygon') body.appendChild(make('polygon', { points: shape[1].map((n) => +(n * k).toFixed(3)).join(' '), class: 'token-mark' }));
    else body.appendChild(make('path', { d: shape[1].replace(/-?\d*\.?\d+/g, (n) => +(parseFloat(n) * k).toFixed(3)), class: 'token-mark-line' }));
    group.appendChild(body);
    if (item.can) {
      group.appendChild(make('circle', {
        cx: 0, cy: 0, r: 0.62, class: 'hit', 'data-token': item.index, tabindex: 0, role: 'button',
        'aria-label': item.player.name + ' token ' + (item.index + 1) + (item.bonus ? ', bonus move' : ''),
      }));
    }
    group.style.transform = 'translate(' + item.x + 'px, ' + item.y + 'px)';
    svg.appendChild(group);

    if (!prefs.motion) {
      const plan = plans.get(key);
      const live = inflight.get(key);
      if (plan) {
        inflight.set(key, { start: now, plan, progress: item.progress });
        runMotion(group, body, shadow, plan, 0);
      } else if (live && live.progress === item.progress && now - live.start < live.plan.duration + live.plan.delay) {
        // The board was redrawn mid-walk; carry on from where the token was.
        runMotion(group, body, shadow, live.plan, now - live.start);
      } else if (live) {
        inflight.delete(key);
      }
    }
  });
  layoutCache.clear();
  nextLayout.forEach((value, key) => layoutCache.set(key, value));

  // A capture lands with a ring that spreads from the square.
  if (fx && fx.burst && !prefs.motion) {
    const ring = el('circle', { cx: fx.burst[0], cy: fx.burst[1], r: 0.5, class: 'b-burst c-' + fx.skin });
    ring.style.animationDelay = (fx.hop / 1000 - (now - fx.at) / 1000).toFixed(3) + 's';
  }

  target.replaceChildren(svg);
  svg.addEventListener('click', (event) => {
    const hit = event.target.closest('[data-token]');
    if (hit) move(Number(hit.dataset.token));
  });
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const hit = event.target.closest('[data-token]');
    if (!hit) return;
    event.preventDefault();
    move(Number(hit.dataset.token));
  });
}

function describeHistory(entry, game) {
  const player = game.players.find((p) => p.id === entry.player);
  const name = player ? player.name : entry.player;
  switch (entry.type) {
    case 'roll': return `${name} rolled a ${entry.roll}.`;
    case 'move': {
      if (entry.captured && entry.captured.length) return `${name} moved token ${entry.token + 1} and sent ${entry.captured.length} token home — another roll.`;
      if (entry.enteredHome) return `${name} walked token ${entry.token + 1} into the home lane.`;
      if (entry.finished) return `${name} brought token ${entry.token + 1} home to the triangle — one more move.`;
      if (entry.completedPlayer) return `${name} brought every token home.`;
      return `${name} moved token ${entry.token + 1}.`;
    }
    case 'three-sixes-penalty': return `${name} rolled three sixes — the turn is cancelled and the tokens go back.`;
    case 'no-move': return `${name} rolled a ${entry.roll} but had no legal move.`;
    default: return `${name} played.`;
  }
}

function renderGame() {
  const game = state.game;
  if (!game) return;
  const player = game.players[game.currentPlayer];
  if (!player) return;

  const over = game.status === 'finished';
  const champion = over ? game.players.find((p) => p.id === game.winner) : null;

  $('game-mode-label').textContent = state.mode || 'PRIVATE ROOM';
  $('game-title').textContent = state.local ? 'The table is yours.' : 'Room ' + (state.room?.invite || '');
  $('connection-pill').style.display = state.local ? 'none' : 'flex';
  $('turn-text').textContent = over
    ? (champion ? champion.name.toUpperCase() + ' WINS' : 'GAME OVER')
    : player.name.toUpperCase() + ' TO PLAY';
  $('turn-banner').querySelector('.turn-dot').className = 'turn-dot color-' + skinOf(over ? (game.winner || player.id) : player.id);
  $('turn-banner').dataset.skin = skinOf(over ? (game.winner || player.id) : player.id);
  $('turn-banner').classList.toggle('is-waiting', !over && !state.local && player.id !== state.color);

  // The die travels to the home square of whoever is on turn.
  const seatFor = over ? (game.winner || player.id) : player.id;
  const overlay = $('dice-overlay');
  if (overlay.dataset.seat !== seatFor) overlay.dataset.seat = seatFor;

  overlay.style.setProperty('--die-accent', 'var(--' + skinOf(seatFor) + ')');
  if (!state.diceAnim) setDieFace(game.dice || 5);

  // A soft chime when the dice come to you.
  if (!over && state.lastTurn !== player.id) {
    if (state.lastTurn !== null && !state.local && player.id === state.color) sfx.turn();
    state.lastTurn = player.id;
  }
  $('dice-caption').textContent = over ? 'DONE' : game.awaitingMove ? 'PICK' : 'ROLL';

  const mine = state.local ? player.kind === 'human' : player.id === state.color;

  // The side panel follows the mode: chat only where there is a human table to talk to.
  $('chat-box').hidden = state.local;
  $('ai-panel').hidden = !state.ai;
  if (state.ai) {
    const tier = { easy: 'Relaxed', normal: 'Classic', hard: 'Ruthless' }[state.aiDifficulty] || 'Classic';
    $('ai-level').textContent = tier.toUpperCase();
    $('ai-title').textContent = 'Computer · ' + tier;
    $('ai-status').textContent = over ? 'Good game.' : player.kind === 'ai' ? player.name + ' is thinking…' : 'Your move.';
  }
  $('roll-dice').disabled = !mine || game.awaitingMove || over;
  const cta = $('roll-cta');
  if (cta) {
    cta.disabled = $('roll-dice').disabled;
    cta.textContent = over ? 'Game over' : game.awaitingMove ? 'Choose a token' : mine ? 'Roll the dice' : player.name + ' is playing…';
  }
  const playsItself = !over && game.awaitingMove && E.autoMoveToken(game) !== null;
  $('move-hint').textContent = over
    ? 'Nicely played.'
    : game.awaitingMove
      ? (playsItself ? 'Playing itself.' : 'Select a highlighted token.')
      : mine ? 'Your turn. Give it a roll.' : player.name + ' is thinking…';

  $('game-players').innerHTML = game.players.map((entry) => {
    const home = entry.tokens.filter((t) => t === E.FINISH_PROGRESS).length;
    const active = entry.id === player.id && !over;
    const you = !state.local && entry.id === state.color;
    const done = E.hasFinished(game, entry.id);
    const pips = [0, 1, 2, 3].map((n) => '<i' + (n < home ? ' class="on"' : '') + '></i>').join('');
    return '<div class="game-player' + (active ? ' active' : '') + (done ? ' finished' : '') + '" data-color="' + esc(entry.id) + '" data-skin="' + skinOf(entry.id) + '">' +
      '<span class="seat-dot color-' + skinOf(entry.id) + '"></span>' +
      '<div><b>' + esc(entry.name) + (you ? ' · YOU' : '') + (done ? ' · HOME' : '') + '</b>' +
      '<span class="home-pips" role="img" aria-label="' + home + ' of 4 tokens home">' + pips + '</span>' +
      '<small>' + home + '/4 HOME · ' + entry.captures + ' CAPT</small></div>' +
      (active ? '<span class="turn-flag">TURN</span>' : '') + '</div>';
  }).join('');
  if (V) V.decorate();

  cues(game);
  board($('game-board'), game, mine && !over);
  noticeFinishes(game);

  const history = game.history.slice(-9).reverse();
  $('activity-list').innerHTML = history.length
    ? history.map((entry) => '<div class="activity-item"><small>' + entry.type.toUpperCase() + '</small>' + esc(describeHistory(entry, game)) + '</div>').join('')
    : '<p class="empty-activity">Every great game starts with a roll.</p>';
}

// Celebrate and announce every player who brings all four tokens home.
function noticeFinishes(game) {
  const finished = game.finishOrder || [];
  for (const id of finished) {
    if (state.finishedSeen.indexOf(id) !== -1) continue;
    state.finishedSeen.push(id);
    const player = game.players.find((p) => p.id === id);
    const place = finished.indexOf(id) + 1;
    confetti.celebrate('finish');
    if (prefs.sound) sfx.finish();
    toast((player ? player.name : id) + ' has brought every token home', 'success');
    if (state.gameMode === 'friends' && !state.local) { /* the table carries on */ }
    void place;
  }
}

function result() {
  const game = state.game;
  if (!game) return;
  const standings = E.standings(game);
  const champion = standings[0];
  const won = !state.local && game.winner === state.color;

  $('result-eyebrow').textContent = won ? 'YOU TOOK THE TABLE' : 'A GAME WELL PLAYED';
  $('result-title').textContent = champion ? champion.name + ' wins.' : 'A draw.';
  const playedOn = game.players.length > 2 && (game.finishOrder || []).length > 1;
  $('result-subtitle').textContent = won
    ? (playedOn ? 'A fine piece of play. The table played on, and you took it.' : 'A fine piece of play. The table is yours — for now.')
    : (playedOn ? 'The table played on until everyone was home. Another time.' : 'The table has a champion. Shame about the runner-up.');

  const podium = $('result-podium');
  const top = standings.slice(0, 3);
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top;
  podium.innerHTML = order.map((entry) => {
    const place = standings.indexOf(entry) + 1;
    return '<div class="podium-item podium-' + place + '">' +
      '<span class="podium-medal">' + ['1ST', '2ND', '3RD'][place - 1] + '</span>' +
      '<span class="seat-dot color-' + skinOf(entry.id) + '"></span>' +
      '<b>' + esc(entry.name) + '</b>' +
      '<small>' + entry.home + '/4 HOME · ' + entry.captures + ' CAPT</small></div>';
  }).join('');

  $('result-stats').innerHTML = standings.map((entry) =>
    '<div class="rule-line"><span>' + esc(entry.name.toUpperCase()) + '</span><b>' + entry.home + '/4 HOME · ' + entry.captures + ' CAPTURES</b></div>'
  ).join('');

  $('play-again').textContent = state.local ? 'Deal again →' : 'Rematch →';
  view('result-view');

  const recordKey = 'parcheesi.recorded:' + (state.room?.invite || 'local');
  const signature = (game.finishOrder || []).join(',') + '#' + (game.turnNumber || 0);
  const alreadyRecorded = state.local ? state.resultRecorded : readJSON(recordKey, '') === signature;
  if (!state.resultRecorded && !alreadyRecorded) {
    state.resultRecorded = true;
    if (!state.local) writeJSON(recordKey, signature);
    if (state.local) {
      if (state.ai) recordMatch('computer', game.winner === 'red' ? 'won' : 'lost', game.players.length - 1, 'Against the computer');
      else recordMatch('friends', null, game.players.length - 1, 'Pass & play');
    } else {
      recordMatch('friends', game.winner === state.color ? 'won' : 'lost', game.players.length - 1, 'Online table');
    }
    confetti.celebrate('win');
  }
}

function addActivity(text, label, color) {
  const node = document.createElement('div');
  node.className = 'activity-item is-new';
  node.innerHTML = '<small>' + esc(label) + '</small>' + (color ? '<span class="seat-dot color-' + skinOf(color) + '"></span> ' : '') + esc(text);
  $('activity-list').prepend(node);
  setTimeout(() => node.classList.remove('is-new'), 400);
}

// Chat is kept apart from the board story so a redraw never eats a message,
// and the newest line is always scrolled into view where it can be read.
function addChat(text, name, color, mine) {
  state.chat.push({ text, name, color: color || '', mine: !!mine, at: Date.now() });
  if (state.chat.length > 60) state.chat.shift();
  renderChat();
  if (!mine) markChatUnread();
}

function renderChat() {
  const list = $('chat-list');
  if (!list) return;
  if (!state.chat.length) {
    list.innerHTML = '<p class="empty-chat">Say hello to the table.</p>';
    return;
  }
  list.innerHTML = state.chat.map((line) =>
    '<div class="chat-line' + (line.mine ? ' is-mine' : '') + '">' +
      (line.color ? '<span class="seat-dot color-' + skinOf(line.color) + '"></span>' : '') +
      '<b>' + esc(line.name) + '</b><span>' + esc(line.text) + '</span></div>'
  ).join('');
  list.scrollTop = list.scrollHeight;
}

function markChatUnread() {
  state.chatUnread += 1;
  const badge = $('chat-badge');
  if (!badge) return;
  badge.textContent = String(state.chatUnread);
  badge.hidden = false;
}
function clearChatUnread() {
  state.chatUnread = 0;
  const badge = $('chat-badge');
  if (badge) { badge.textContent = '0'; badge.hidden = true; }
}

/* ----------------------------------------------------------------- dice -- */

// The die is a real cube: six faces of pips that turn in 3D.
function buildDie() {
  const die = $('dice-face');
  if (!die || die.firstChild) return;
  const cube = document.createElement('span');
  cube.className = 'cube';
  cube.id = 'die-cube';
  for (let value = 1; value <= 6; value++) {
    const face = document.createElement('i');
    face.className = 'face f' + value;
    for (let cell = 1; cell <= 9; cell++) {
      const pip = document.createElement('b');
      if (DIE_PIPS[value].includes(cell)) pip.className = 'pip';
      face.appendChild(pip);
    }
    cube.appendChild(face);
  }
  die.appendChild(cube);
  setDieFace(5);
}
function dieTransform(value) {
  const turn = DIE_TURN[value] || DIE_TURN[5];
  return 'rotateX(' + turn[0] + 'deg) rotateY(' + turn[1] + 'deg)';
}
function setDieFace(value) {
  const cube = $('die-cube');
  if (!cube) return;
  cube.getAnimations().forEach((anim) => anim.cancel());
  cube.style.transform = dieTransform(value);
}

function startDiceTumble() {
  stopDice();
  sfx.roll();
  const cube = $('die-cube');
  const die = $('dice-face');
  state.diceAnim = { target: null, start: performance.now(), anims: [], timer: null };
  if (prefs.motion || !cube) return;
  $('roll-dice').classList.add('rolling');
  const a = Math.floor(Math.random() * 360), b = Math.floor(Math.random() * 360);
  state.diceAnim.anims = [
    cube.animate([
      { transform: 'rotateX(' + a + 'deg) rotateY(' + b + 'deg) rotateZ(0deg)' },
      { transform: 'rotateX(' + (a + 540) + 'deg) rotateY(' + (b + 720) + 'deg) rotateZ(180deg)' },
    ], { duration: 620, iterations: Infinity, easing: 'linear' }),
    die.animate([
      { transform: 'translateY(0)' }, { transform: 'translateY(-16%)' }, { transform: 'translateY(0)' },
    ], { duration: 310, iterations: Infinity, easing: 'ease-in-out' }),
  ];
}
function landDice(value) {
  const anim = state.diceAnim;
  if (!anim) { setDieFace(value); return; }
  anim.target = value;
  if (anim.timer) return;
  // Let it tumble long enough to feel thrown, even when the answer is already known.
  const wait = Math.max(0, TUMBLE_MIN - (performance.now() - anim.start));
  anim.timer = setTimeout(() => settleDice(value), wait);
}
function settleDice(value) {
  const anim = state.diceAnim;
  if (!anim) return;
  const cube = $('die-cube');
  const die = $('dice-face');
  if (prefs.motion || !cube) { finishDice(value); return; }
  const from = getComputedStyle(cube).transform;
  anim.anims.forEach((item) => item.cancel());
  anim.anims = [
    cube.animate([
      { transform: from && from !== 'none' ? from : dieTransform(value) },
      { transform: dieTransform(value) },
    ], { duration: SETTLE_MS, easing: 'cubic-bezier(.2,.9,.3,1.12)', fill: 'forwards' }),
    die.animate([
      { offset: 0, transform: 'translateY(0) scale(1)' },
      { offset: 0.3, transform: 'translateY(-26%) scale(1.06)' },
      { offset: 0.55, transform: 'translateY(0) scale(.96, 1.04)' },
      { offset: 0.76, transform: 'translateY(-7%) scale(1)' },
      { offset: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: SETTLE_MS + 120, easing: 'ease-out' }),
  ];
  setTimeout(() => sfx.land(), SETTLE_MS * 0.5);
  anim.timer = setTimeout(() => finishDice(value), SETTLE_MS + 80);
}
function finishDice(value) {
  stopDice();
  setDieFace(value);
  if (value === 6) sfx.six();
  const button = $('roll-dice');
  button.classList.add('landed');
  setTimeout(() => button.classList.remove('landed'), 420);
}
function stopDice() {
  const anim = state.diceAnim;
  if (anim) { clearTimeout(anim.timer); anim.anims.forEach((item) => item.cancel()); }
  state.diceAnim = null;
  $('roll-dice').classList.remove('rolling');
}

// Local and computer rolls hold back the result until the die has landed.
function afterDice(fn) {
  state.rolling = true;
  const wait = prefs.motion ? 0 : TUMBLE_MIN + SETTLE_MS + 40;
  setTimeout(() => { state.rolling = false; if (state.game) fn(); }, wait);
}

/* ---------------------------------------------------------------- audio cues -- */

function cues(game) {
  const length = game.history.length;
  if (state.seenLen == null || length < state.seenLen) { state.seenLen = length; return; }
  if (length === state.seenLen) return;
  const entry = game.history[length - 1];
  state.seenLen = length;
  const over = game.status === 'finished';

  if (entry.type === 'move') {
    const entering = entry.from === -1;
    const steps = entering ? 1 : Math.max(1, entry.to - entry.from);
    const timing = entering ? { step: 520, total: 520 } : hopTiming(steps);
    const seat = entry.player;
    const trail = [];
    if (entering) trail.push(coordFor(seat, 0));
    else for (let p = entry.from + 1; p <= entry.to; p++) if (p < E.FINISH_PROGRESS) trail.push(coordFor(seat, p));
    const captured = !!(entry.captured && entry.captured.length);
    state.fx = {
      at: performance.now(), skin: skinOf(seat), trail, step: timing.step, hop: timing.total,
      burst: captured && trail.length ? trail[trail.length - 1] : null,
    };
    const calm = prefs.motion;
    if (entering) sfx.enter();
    else if (!calm) for (let i = 0; i < steps; i++) setTimeout(() => sfx.step(i), (i + 0.86) * timing.step);
    const end = calm ? 0 : timing.total;
    setTimeout(() => {
      if (captured) { sfx.capture(); sfx.sentHome(); }
      else if (entry.finished) sfx.finish();
      else if (entry.enteredHome) sfx.bonus();
      else if (!entering && entry.to < E.HOME_ENTRY_PROGRESS && E.SAFE_TRACK.has(E.globalTrackIndex(seat, entry.to))) sfx.safe();
      if (over) setTimeout(() => sfx.win(), 500);
    }, end);
    return;
  }
  if (over) { sfx.win(); return; }
  if (entry.type === 'three-sixes-penalty') sfx.penalty();
  else if (entry.type === 'no-move') sfx.noMove();
}

/* --------------------------------------------------------------- actions -- */

async function createRoom() {
  const name = await askName({ heading: 'What should we call you?', note: 'Pick a name before you open the table.', voiceOption: true });
  if (!name) return;
  const voice = $('name-voice').checked;
  setPlayerName(name);
  const button = $('create-room');
  button.classList.add('is-busy');
  try {
    await connect();
    send('room.create', { name, voice, skin: savedSkin() });
  } catch (error) {
    toast(error.message || 'Could not reach the game server', 'error');
  } finally {
    setTimeout(() => button.classList.remove('is-busy'), 400);
  }
}

async function joinRoomFlow(code) {
  const raw = (code || $('join-code').value || '').trim();
  const invite = raw.toUpperCase().replace(/.*\/room\//, '').replace(/[^A-Z0-9]/g, '');
  if (!invite) { showJoinError('Enter the invitation code from your friend'); return; }
  const typedName = cleanName($('player-name').value) || playerName();
  setPlayerName(typedName);
  $('join-code').value = invite;
  $('join-confirm').disabled = true;
  $('join-confirm').textContent = 'Joining…';
  state.pendingJoin = true;
  try {
    await connect();
    const token = localStorage.getItem('parcheesi:' + invite);
    send('room.join', { invite, playerToken: token, name: typedName, skin: savedSkin() });
  } catch (error) {
    showJoinError(error.message || 'Could not reach the game server');
  }
}

async function startLocalGame(mode) {
  const setup = await askSetup(mode);
  if (!setup) return;
  const ids = E.PLAYER_IDS.slice(0, setup.count);
  const kinds = {};
  const difficulties = {};
  const names = {};
  ids.forEach((id, index) => {
    const isAi = mode === 'ai' && index > 0;
    kinds[id] = isAi ? 'ai' : 'human';
    difficulties[id] = isAi ? setup.difficulty : 'normal';
    names[id] = setup.names[id] || (isAi ? E.pickAiNames(1)[0] : 'Player ' + (index + 1));
  });
  state.local = true;
  state.ai = mode === 'ai';
  state.gameMode = mode === 'ai' ? 'computer' : 'friends';
  state.aiDifficulty = setup.difficulty;
  state.seenLen = null;
  state.mode = mode === 'ai' ? 'PLAY VS AI' : 'PASS & PLAY';
  state.room = null;
  state.color = 'red';
  state.resultRecorded = false;
  state.finishedSeen = [];
  state.skins = setup.skins || {};
  state.fx = null;
  state.lastTurn = null;
  state.rolling = false;
  layoutCache.clear();
  inflight.clear();
  state.game = E.initialState({ players: ids, names, kinds, difficulties });
  state.activity = [];
  renderGame();
  view('game-view');
  maybeAutoMove();
  maybeAI();
}

// A single token on the board moves itself.
function maybeAutoMove() {
  clearTimeout(state.autoMoveTimer);
  const game = state.game;
  if (!game || !game.awaitingMove || game.status !== 'playing') return;
  const player = game.players[game.currentPlayer];
  if (!player) return;
  const mine = state.local ? player.kind === 'human' : player.id === state.color;
  if (!mine) return;
  const token = E.autoMoveToken(game);
  if (token === null || token === undefined) return;
  state.autoMoveTimer = setTimeout(() => {
    if (!state.game || !state.game.awaitingMove) return;
    move(token);
  }, 420);
}

function move(index) {
  if (!state.game?.awaitingMove) return;
  if (state.local) {
    try {
      state.game = E.applyMove(state.game, index);
      renderGame();
      if (state.game.status === 'finished') result();
      else { maybeAutoMove(); maybeAI(); }
    } catch (error) { toast(error.message || 'That move is not allowed', 'error'); }
    return;
  }
  if (Date.now() - state.moveLock < 350) return;
  state.moveLock = Date.now();
  send('game.move', { token: index });
}

function roll() {
  if ($('roll-dice').disabled || state.rolling) return;
  if (state.local) {
    const value = 1 + Math.floor(Math.random() * 6);
    startDiceTumble();
    try {
      state.game = E.applyRoll(state.game, value);
    } catch (error) {
      stopDice();
      toast(error.message || 'You cannot roll right now', 'error');
      return;
    }
    landDice(value);
    afterDice(() => { renderGame(); maybeAutoMove(); maybeAI(); });
    return;
  }
  startDiceTumble();
  if (!send('game.roll')) stopDice();
}

let aiTimer;
function maybeAI() {
  clearTimeout(aiTimer);
  if (!state.local || !state.ai || !state.game || state.game.status !== 'playing') return;
  const player = state.game.players[state.game.currentPlayer];
  if (!player || player.kind !== 'ai') return;
  const delay = state.aiDifficulty === 'hard' ? 900 : state.aiDifficulty === 'easy' ? 520 : 680;
  aiTimer = setTimeout(() => {
    if (!state.game || state.game.status !== 'playing') return;
    const finish = () => {
      renderGame();
      if (state.game.status === 'finished') result();
      else { maybeAutoMove(); maybeAI(); }
    };
    let rolled = false;
    try {
      if (state.game.awaitingMove) {
        const choice = E.chooseAIMove(state.game, Math.random, state.aiDifficulty);
        if (choice !== null) state.game = E.applyMove(state.game, choice);
      } else {
        const value = 1 + Math.floor(Math.random() * 6);
        startDiceTumble();
        state.game = E.applyRoll(state.game, value);
        landDice(value);
        rolled = true;
      }
    } catch { /* the table changed under us; the next tick will sort it out */ }
    if (rolled) afterDice(finish); else finish();
  }, delay);
}

async function leaveGame() {
  const ok = await confirmAction({
    eyebrow: 'LEAVE THE TABLE',
    heading: 'Leave this game?',
    body: state.local ? 'Your game will be cleared and the table folded away.' : 'Your seat will be released. You can rejoin later with the same link.',
    confirm: 'Leave',
    danger: true,
  });
  if (!ok) return;
  state.intentionalClose = true;
  clearTimeout(aiTimer);
  clearTimeout(state.autoMoveTimer);
  stopDice();
  if (!state.local) send('room.leave');
  try { state.socket?.close(); } catch {}
  state.socket = null;
  state.intentionalClose = false;
  resetRoom();
  setNetwork('idle');
  view('home-view');
  toast('You left the table');
}

function copyInvite() {
  if (!state.inviteUrl) return;
  const done = () => toast('Invitation link copied', 'success');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(state.inviteUrl).then(done).catch(() => toast(state.inviteUrl));
  else toast(state.inviteUrl);
}
function copyCode() {
  const code = state.room?.invite;
  if (!code) return;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(() => toast('Room code copied', 'success')).catch(() => toast(code));
  else toast(code);
}
function shareInvite() {
  if (!state.inviteUrl) return;
  if (navigator.share) navigator.share({ url: state.inviteUrl, title: 'Join my PARCHEESI game' }).catch(() => {});
  else copyInvite();
}

function chat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (state.local) addChat(text, playerName(), 'red', true);
  else send('chat.send', { text });
  input.value = '';
  input.focus();
}

/* ---------------------------------------------------------------- wiring -- */

$('create-room').onclick = createRoom;
$('join-room').onclick = () => openJoinDialog();
$('join-form').addEventListener('submit', (event) => { event.preventDefault(); joinRoomFlow(); });
$('join-cancel').onclick = () => $('join-dialog').close();
$('join-dialog').addEventListener('close', () => {
  state.pendingJoin = false;
  $('join-confirm').disabled = false;
  $('join-confirm').textContent = 'Join room →';
});
$('join-code').addEventListener('input', (event) => {
  const start = event.target.selectionStart;
  const upper = event.target.value.toUpperCase();
  event.target.value = upper;
  if (start != null) event.target.setSelectionRange(start, start);
  setDialogError('join-error', '');
});
$('play-ai').onclick = () => startLocalGame('ai');
$('play-local').onclick = () => startLocalGame('local');
$('copy-invite').onclick = copyInvite;
$('copy-code').onclick = copyCode;
$('share-invite').onclick = shareInvite;
$('rename-self').onclick = async () => {
  const name = await askName({ eyebrow: 'YOUR SEAT', heading: 'Change your name', note: 'Everyone at the table will see the new name.', confirm: 'Save', value: playerName() });
  if (!name) return;
  setPlayerName(name);
  if (state.room) send('lobby.rename', { name });
};
$('toggle-ready').onclick = () => {
  const player = state.room?.players.find((p) => p.color === state.color);
  if (player) send('lobby.ready', { ready: !player.ready });
};
$('start-game').onclick = () => send('lobby.start');
$('player-grid').addEventListener('click', async (event) => {
  const kick = event.target.closest('[data-kick]');
  if (!kick) return;
  const target = state.room?.players.find((p) => p.id === kick.dataset.kick);
  if (!target) return;
  const ok = await confirmAction({
    eyebrow: 'REMOVE A PLAYER',
    heading: 'Remove ' + target.name + '?',
    body: 'They will lose their seat and need a new invitation to return.',
    confirm: 'Remove',
    danger: true,
  });
  if (ok) send('lobby.kick', { playerId: target.id });
});
$('roll-dice').onclick = roll;
$('roll-cta').onclick = roll;
$('leave-game').onclick = leaveGame;
$('play-again').onclick = async () => {
  if (state.local) { startLocalGame(state.ai ? 'ai' : 'local'); return; }
  send('game.rematch');
};
$('chat-send').onclick = chat;
$('chat-input').onkeydown = (event) => { if (event.key === 'Enter') chat(); };

// On a phone the story and chat panels fold away so the board stays in reach.
(() => {
  const phone = window.matchMedia('(max-width: 980px)');
  const panels = [...document.querySelectorAll('.story-panel, .chat-panel')];
  const sync = () => panels.forEach((panel) => {
    const head = panel.querySelector('.panel-heading');
    if (phone.matches) {
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
    } else {
      head.removeAttribute('role'); head.removeAttribute('tabindex'); head.removeAttribute('aria-expanded');
      panel.classList.remove('is-collapsed');
    }
  });
  const toggle = (panel) => {
    if (!phone.matches) return;
    panel.classList.toggle('is-collapsed');
    panel.querySelector('.panel-heading').setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
  };
  panels.forEach((panel) => {
    const head = panel.querySelector('.panel-heading');
    head.addEventListener('click', () => toggle(panel));
    head.addEventListener('keydown', (event) => {
      if (phone.matches && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(panel); }
    });
    if (phone.matches) panel.classList.add('is-collapsed');
  });
  sync();
  phone.addEventListener('change', () => { if (phone.matches) panels.forEach((panel) => panel.classList.add('is-collapsed')); sync(); });
})();
$('chat-input').onfocus = clearChatUnread;
$('settings-open').onclick = openSettings;
$('settings-save').onclick = () => { $('settings-dialog').close(); };
// Settings save the moment they change, the same way the Chess page does.
let savedTimer = 0;
$('settings-dialog').addEventListener('change', () => {
  savePrefs(readForm());
  $('settings-status').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('settings-status').textContent = ''; }, 1600);
});
$('settings-dialog').addEventListener('close', () => { $('settings-status').textContent = ''; fillForm(prefs); });
$('how-to-play').onclick = () => $('help-dialog').showModal();
$('game-menu').onclick = () => { $('menu-dialog').showModal(); };
$('avatar-button').onclick = openProfile;
$('name-random').onclick = () => {
  const names = E.AI_NAMES;
  const pick = names[Math.floor(Math.random() * names.length)];
  $('name-input').value = pick;
  $('name-count').textContent = String(pick.length);
  setDialogError('name-error', '');
};
$('name-input').oninput = (event) => { $('name-count').textContent = String(event.target.value.length); };
$('profile-save').onclick = () => { saveProfile(); $('profile-dialog').close(); };
$('profile-reset').onclick = async () => {
  const ok = await confirmAction({
    eyebrow: 'START FRESH',
    heading: 'Reset your profile?',
    body: 'Your name, photo and match history will be cleared from this browser.',
    confirm: 'Reset',
    danger: true,
  });
  if (!ok) return;
  P.reset();
  syncAvatar();
  $('profile-dialog').close();
  toast('Profile reset');
};
$('profile-photo-btn').onclick = () => $('profile-photo-input').click();
$('profile-photo-remove').onclick = () => {
  P.setPhoto('');
  paintProfileAvatar('', $('profile-name').value);
  $('profile-photo-remove').hidden = true;
};
$('profile-photo-input').onchange = async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await P.readPhoto(file);
    P.setPhoto(dataUrl);
    paintProfileAvatar(dataUrl, $('profile-name').value);
    $('profile-photo-remove').hidden = false;
    toast('Photo added', 'success');
  } catch (error) {
    toast(error.message || 'Could not use that picture', 'error');
  }
  event.target.value = '';
};
document.querySelectorAll('[data-go-home]').forEach((button) => {
  button.onclick = async () => {
    if (state.room) { await leaveGame(); return; }
    view('home-view');
  };
});
document.querySelectorAll('.modal-close').forEach((button) => {
  button.onclick = (event) => { event.preventDefault(); event.target.closest('dialog').close(); };
});
document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});
$('menu-copy').onclick = () => { copyInvite(); $('menu-dialog').close(); };
$('menu-rules').onclick = () => { $('menu-dialog').close(); $('help-dialog').showModal(); };
$('menu-sound').onclick = () => {
  const next = { ...prefs, sound: !prefs.sound };
  savePrefs(next);
  fillForm(prefs);
  if (prefs.sound) sfx.enter();
};
$('menu-motion').onclick = () => {
  const next = { ...prefs, motion: !prefs.motion };
  savePrefs(next);
  fillForm(prefs);
};
$('menu-fullscreen').onclick = () => {
  $('menu-dialog').close();
  const target = document.documentElement;
  if (!document.fullscreenElement) target.requestFullscreen?.().catch(() => toast('Full screen was blocked by the browser', 'error'));
  else document.exitFullscreen?.();
};
$('menu-leave').onclick = () => { $('menu-dialog').close(); leaveGame(); };
$('setup-cancel').onclick = () => $('setup-dialog').close();

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape') {
    const open = [...document.querySelectorAll('dialog[open]')].pop();
    if (open) { open.close(); return; }
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 'r' && !$('roll-dice').disabled) { event.preventDefault(); roll(); }
  if (['1', '2', '3', '4'].includes(event.key) && state.game?.awaitingMove) {
    const index = Number(event.key) - 1;
    const hits = [...document.querySelectorAll('#game-board .hit')];
    if (hits.some((node) => Number(node.dataset.token) === index)) { event.preventDefault(); move(index); }
  }
});

// A local game lives only in this tab, so warn before it is lost. A room game
// is server-side and reconnects on its own, so it is left alone.
window.addEventListener('beforeunload', (event) => {
  if (state.local && state.game && state.game.status === 'playing') {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ------------------------------------------------------------------ init -- */

function preview() {
  const game = E.initialState();
  game.players[0].tokens = [-1, -1, 9, 33];
  game.players[1].tokens = [-1, 22, -1, 41];
  game.players[2].tokens = [-1, -1, 47, 12];
  game.players[3].tokens = [-1, 5, 28, -1];
  board($('preview-board'), game, false);
}

function init() {
  if (V) {
    V.init({
      room: () => state.room,
      color: () => state.color,
      isLocal: () => state.local,
      toast,
      // Quiet sender: voice signalling must never trigger the "reconnecting" toasts.
      send: (type, data) => {
        const ws = state.socket;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
      },
    });
  }
  applyPrefs(prefs);
  fillForm(prefs);
  syncAvatar();
  confetti.init();
  buildDie();
  preview();

  // Pick a token colour in the lobby.
  $('skin-picker').addEventListener('click', (event) => {
    const swatch = event.target.closest('.swatch[data-skin]');
    if (!swatch || swatch.disabled) return;
    saveSkin(swatch.dataset.skin);
    send('lobby.skin', { skin: swatch.dataset.skin });
  });
  // A soft tap under every button, except the dice and the board which make their own noise.
  document.addEventListener('click', (event) => {
    const control = event.target.closest('button, .menu-item');
    if (!control || control.id === 'roll-dice' || control.disabled) return;
    sfx.click();
  });

  const last = readJSON('parcheesi.lastRoom', null);
  const linked = location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);
  if (last && last.invite && Date.now() - last.at < 24 * 60 * 60 * 1000) {
    try {
      if (localStorage.getItem('parcheesi:' + last.invite)) {
        $('resume-room').hidden = false;
        $('resume-detail').textContent = 'Room ' + last.invite;
      }
    } catch {}
  }
  $('resume-room').onclick = () => openJoinDialog(last?.invite || '');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  if (linked) {
    $('join-code').value = linked[1].toUpperCase();
    $('player-name').value = playerName();
    openJoinDialog(linked[1].toUpperCase());
    view('home-view');
    setNetwork('idle');
    return;
  }

  view('home-view');
  setNetwork('idle');

  // A table that is still live is picked up again on its own. Reloading the page,
  // switching apps or taking a screenshot should never end a game in progress.
  if (last && last.invite && Date.now() - last.at < 24 * 60 * 60 * 1000) {
    let token = null;
    try { token = localStorage.getItem('parcheesi:' + last.invite); } catch {}
    if (token) resumeRoom(last.invite, token);
  }
}

// Reclaims a seat with the token this browser was given.
async function resumeRoom(invite, token) {
  state.resuming = true;
  try {
    await connect();
    send('room.join', { invite, playerToken: token, name: playerName(), skin: savedSkin() });
  } catch {
    state.resuming = false;
  }
}

init();
