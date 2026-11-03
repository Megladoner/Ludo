'use strict';

/* ==========================================================================
   PARCHEESI — client
   Sections: state · utils · preferences · audio · profile · dialogs
             network · board · rendering · actions · wiring
   ========================================================================== */

const E = window.LudoEngine;
const P = window.ParcheesiProfile;
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
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
const DEFAULT_PREFS = { motion: false, sound: true, theme: 'noir' };
let prefs = (() => {
  const stored = readJSON('parcheesi.settings', {});
  const merged = { ...DEFAULT_PREFS, ...stored };
  if (!THEMES.includes(merged.theme)) merged.theme = 'noir';
  return merged;
})();

function applyPrefs(next) {
  const root = document.documentElement;
  root.dataset.theme = next.theme;
  root.classList.toggle('reduced-motion', !!next.motion);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#08090b');
  const soundState = $('menu-sound-state');
  if (soundState) soundState.textContent = next.sound ? 'On' : 'Off';
  const motionState = $('menu-motion-state');
  if (motionState) motionState.textContent = next.motion ? 'On' : 'Off';
}
function readForm() {
  const theme = document.querySelector('input[name="theme"]:checked');
  return { motion: $('motion-setting').checked, sound: $('sound-setting').checked, theme: theme ? theme.value : 'noir' };
}
function fillForm(settings) {
  $('motion-setting').checked = !!settings.motion;
  $('sound-setting').checked = !!settings.sound;
  const option = document.querySelector(`input[name="theme"][value="${settings.theme}"]`) || document.querySelector('input[name="theme"][value="noir"]');
  if (option) option.checked = true;
}
function savePrefs(settings) {
  prefs = { motion: !!settings.motion, sound: !!settings.sound, theme: THEMES.includes(settings.theme) ? settings.theme : 'noir' };
  writeJSON('parcheesi.settings', prefs);
  applyPrefs(prefs);
}
function openSettings() {
  fillForm(prefs);
  $('settings-dialog').showModal();
}

/* --------------------------------------------------------------- audio -- */

let actx;
function tone(freq, duration, type, volume, delay) {
  if (!prefs.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + (delay || 0);
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume || 0.08, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain); gain.connect(actx.destination);
    osc.start(t); osc.stop(t + duration + 0.02);
  } catch {}
}
const sfx = {
  roll() { [0, 0.07, 0.14, 0.21].forEach((t, i) => tone(180 + i * 55, 0.06, 'square', 0.035, t)); },
  enter() { tone(440, 0.08, 'triangle', 0.06); tone(660, 0.1, 'triangle', 0.05, 0.07); },
  move() { tone(520, 0.1, 'triangle', 0.09); },
  capture() { tone(330, 0.12, 'sawtooth', 0.06); tone(165, 0.25, 'sawtooth', 0.06, 0.1); },
  pen() { tone(200, 0.25, 'sine', 0.08); },
  bonus() { [660, 880, 1170].forEach((f, i) => tone(f, 0.14, 'triangle', 0.07, i * 0.07)); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.08, i * 0.14)); },
  finish() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.22, 'sine', 0.07, i * 0.09)); },
};

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
  $('create-voice-option').hidden = !options.showVoiceToggle;
  $('create-voice-setting').checked = options.voiceEnabled === true;
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

  $('setup-eyebrow').textContent = mode === 'ai' ? 'CHALLENGE THE TABLE' : 'PASS & PLAY';
  $('setup-heading').textContent = mode === 'ai' ? 'How tough a table?' : 'How many players?';
  $('setup-note').textContent = mode === 'ai'
    ? 'You take the first seat. The rest of the table plays the house.'
    : 'Everyone shares this device. Pass it around when it is your turn.';
  $('setup-confirm').textContent = mode === 'ai' ? 'Take your seat →' : 'Deal the cards →';
  aiBlock.hidden = mode !== 'ai';

  const paintOptions = () => {
    options.forEach((option) => option.setAttribute('aria-checked', String(Number(option.dataset.count) === count)));
    difficulties.forEach((option) => option.setAttribute('aria-checked', String(option.dataset.difficulty === difficulty)));
  };
  const draft = {};
  const paintNames = () => {
    const ids = E.PLAYER_IDS.slice(0, count);
    const aiNames = mode === 'ai' ? E.pickAiNames(Math.max(0, count - 1)) : [];
    namesBox.innerHTML = '';
    ids.forEach((id, index) => {
      const isAi = mode === 'ai' && index > 0;
      const row = document.createElement('div');
      row.className = 'setup-name' + (isAi ? ' is-ai' : '');
      const dot = document.createElement('span');
      dot.className = 'seat-dot color-' + id;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.dataset.seat = id;
      input.value = draft[id] ?? (isAi ? aiNames[index - 1] : (index === 0 ? playerName() : 'Player ' + (index + 1)));
      input.readOnly = isAi;
      input.setAttribute('aria-label', 'Name for the ' + id + ' seat');
      input.addEventListener('input', () => { draft[id] = input.value; });
      row.append(dot, input);
      namesBox.appendChild(row);
    });
  };
  paintOptions();
  paintNames();

  dialog.showModal();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onOption = (event) => {
      const option = event.target.closest('.seat-option');
      if (option) { count = Number(option.dataset.count); paintOptions(); paintNames(); return; }
      const tier = event.target.closest('#setup-difficulty button');
      if (tier) { difficulty = tier.dataset.difficulty; paintOptions(); }
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const names = {};
      namesBox.querySelectorAll('input[data-seat]').forEach((input) => { names[input.dataset.seat] = cleanName(input.value) || 'Player'; });
      dialog.close();
      finish({ count, names, difficulty });
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

function updateVoiceUI(info = {}) {
  const enabled = !!state.room?.voiceEnabled && !state.local;
  ['lobby-voice-panel', 'game-voice-panel'].forEach((id) => { const panel = $(id); if (panel) panel.hidden = !enabled; });
  const status = info.error || (info.busy ? 'Requesting microphone access…' : info.micOn ? 'Your microphone is on. You can hear the table.' : info.joined ? 'Connected to room audio. Your microphone is off.' : 'Enable your microphone to join the conversation.');
  ['lobby-voice-status', 'game-voice-status'].forEach((id) => { const node = $(id); if (node) node.textContent = status; });
  const label = info.busy ? 'Connecting…' : info.micOn ? 'Mute my mic' : info.joined ? 'Turn my mic on' : 'Enable microphone';
  ['lobby-voice-toggle', 'game-voice-toggle'].forEach((id) => { const button = $(id); if (button) { button.textContent = label; button.disabled = !!info.busy || !enabled; button.setAttribute('aria-pressed', String(!!info.micOn)); } });
  document.querySelectorAll('[data-player-id]').forEach((node) => node.classList.toggle('is-speaking', !!voiceClient?.isSpeaking(node.dataset.playerId)));
}

const voiceClient = window.ParcheesiVoice.create({ send, onChange: updateVoiceUI });
function syncVoiceRoom() {
  const room = state.room;
  const self = room?.players.find((p) => p.color === state.color);
  if (!room || !room.voiceEnabled || state.local || room.status === 'finished') voiceClient.sync(null, null);
  else voiceClient.sync(room, self?.id || null);
  updateVoiceUI(voiceClient.getState());
}

function rememberRoom(invite) {
  writeJSON('parcheesi.lastRoom', { invite, at: Date.now() });
  $('resume-room').hidden = false;
  $('resume-detail').textContent = 'Room ' + invite;
}

function message(m) {
  if (!m || typeof m.type !== 'string') return;
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
    syncVoiceRoom();
    try { localStorage.setItem('parcheesi:' + m.invite, m.playerToken); } catch {}
    state.inviteUrl = location.origin + '/room/' + m.invite;
    rememberRoom(m.invite);
    closeJoinDialog();
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
    syncVoiceRoom();
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
    syncVoiceRoom();
    if (m.event && m.event.type === 'roll') { landDice(m.event.roll); }
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
  if (m.type === 'voice.signal') { voiceClient.handleSignal(m); return; }
  if (m.type === 'chat.message') {
    addChat(m.text, m.player, m.color, m.player === playerName());
  }
}

function resetRoom() {
  state.room = null;
  voiceClient.sync(null, null);
  updateVoiceUI(voiceClient.getState());
  state.game = null;
  state.token = null;
  state.color = null;
  state.seenLen = null;
  state.local = false;
  state.sequence = -1;
  state.resultRecorded = false;
  state.chat = [];
  renderChat();
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
    seat.className = 'player-seat' + (!player ? ' seat-empty' : (voiceClient.isSpeaking(player.id) ? ' is-speaking' : ''));
    if (player) {
      seat.dataset.playerId = player.id;
      const kick = isHost && !player.host
        ? `<button class="seat-kick" data-kick="${esc(player.id)}" aria-label="Remove ${esc(player.name)}" title="Remove">×</button>`
        : '';
      seat.innerHTML =
        '<span class="seat-dot color-' + player.color + '"></span>' +
        '<div class="seat-info"><b>' + esc(player.name) + (player.host ? ' · HOST' : '') + '</b>' +
        '<small>' + (player.connected ? 'CONNECTED' : 'RECONNECTING') + ' · ' + player.color.toUpperCase() + '</small></div>' +
        '<span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="seat-ready">' + (player.ready ? 'READY' : 'NOT READY') + '</span>' + kick;
    } else {
      seat.innerHTML = '<span class="seat-dot color-muted"></span><div class="seat-info"><b>Open seat</b><small>INVITE A FRIEND</small></div>';
    }
    grid.appendChild(seat);
  }
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
      player, index, x, y, r, share: progress >= 0 && !done,
      can: player.id === turn?.id && legal.includes(index),
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

function board(target, game, interactive) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-.5 -.5 15 15');
  svg.setAttribute('class', 'board-svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Parcheesi board. Select a highlighted token to move it.');

  const make = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  };
  const el = (tag, attrs, text) => { const node = make(tag, attrs, text); svg.appendChild(node); return node; };

  const active = new Set(game.players.map((p) => p.id));
  el('rect', { x: -0.5, y: -0.5, width: 15, height: 15, rx: 0.6, class: 'b-board' });
  E.PLAYER_IDS.forEach((color) => {
    const [x, y] = YARD[color];
    const idle = active.has(color) ? '' : ' is-idle';
    el('rect', { x, y, width: 6, height: 6, rx: 0.6, class: 'b-yard c-' + color + idle });
    el('rect', { x: x + 0.7, y: y + 0.7, width: 4.6, height: 4.6, rx: 0.5, class: 'b-yard-in' + idle });
    BASE[color].forEach(([cx, cy]) => el('circle', { cx, cy, r: 0.62, class: 'b-pad' + idle }));
  });
  E.TRACK_COORDS.forEach(([x, y], i) => {
    const start = E.PLAYER_IDS.find((c) => E.START_OFFSETS[c] === i);
    const safe = E.SAFE_TRACK.has(i);
    el('rect', { x: x - 0.46, y: y - 0.46, width: 0.92, height: 0.92, rx: 0.1, class: 'b-cell' + (safe ? ' is-safe' : '') + (start ? ' is-start c-' + start : '') });
    if (safe) el('text', { x, y: y + 0.03, class: 'b-star' + (start ? ' on-start' : '') }, '✦');
  });
  E.PLAYER_IDS.forEach((color) => E.HOME_COORDS[color].slice(0, 5).forEach(([x, y]) => {
    el('rect', { x: x - 0.46, y: y - 0.46, width: 0.92, height: 0.92, rx: 0.1, class: 'b-lane c-' + color });
  }));
  [['red', '5.5,5.5 7,7 5.5,8.5'], ['green', '5.5,5.5 8.5,5.5 7,7'], ['yellow', '8.5,5.5 8.5,8.5 7,7'], ['blue', '5.5,8.5 8.5,8.5 7,7']].forEach(([color, points]) => {
    el('polygon', { points, class: 'b-tri c-' + color });
  });

  // The home square of whoever is on turn wears a bold frame.
  const onTurn = game.status === 'playing' ? game.players[game.currentPlayer] : null;
  if (onTurn) {
    const [ax, ay] = YARD[onTurn.id];
    el('rect', { x: ax - 0.1, y: ay - 0.1, width: 6.2, height: 6.2, rx: 0.7, class: 'b-yard-frame' });
    el('rect', { x: ax - 0.02, y: ay - 0.02, width: 6.04, height: 6.04, rx: 0.64, class: 'b-yard-frame-inner c-' + onTurn.id + ' b-yard-frame-pulse' });
  }

  const items = computeLayout(game, interactive);
  const nextLayout = new Map();
  items.sort((a, b) => a.can - b.can).forEach((item) => {
    const key = item.player.id + ':' + item.index;
    nextLayout.set(key, { x: item.x, y: item.y });
    const group = make('g', { class: 'token-g' });
    if (item.can) {
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.13, class: 'b-ring b-ring-dark' }));
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.13, class: 'b-ring' }));
    }
    if (item.homeward) {
      group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r + 0.18, class: 'b-ring b-homeward' }));
    }
    group.appendChild(make('circle', { cx: 0, cy: 0, r: item.r, class: 'token c-' + item.player.id }));
    group.appendChild(make('circle', { cx: -item.r * 0.28, cy: -item.r * 0.3, r: item.r * 0.38, class: 'token-shine' }));
    if (item.can) {
      group.appendChild(make('circle', {
        cx: 0, cy: 0, r: 0.62, class: 'hit', 'data-token': item.index, tabindex: 0, role: 'button',
        'aria-label': item.player.name + ' token ' + (item.index + 1) + (item.bonus ? ', bonus move' : ''),
      }));
    }
    const previous = layoutCache.get(key);
    const moved = previous && (Math.abs(previous.x - item.x) > 0.001 || Math.abs(previous.y - item.y) > 0.001);
    if (moved && !prefs.motion) {
      group.classList.add('no-motion');
      group.style.transform = `translate(${previous.x}px, ${previous.y}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        group.classList.remove('no-motion');
        group.style.transform = `translate(${item.x}px, ${item.y}px)`;
      }));
    } else {
      group.style.transform = `translate(${item.x}px, ${item.y}px)`;
    }
    svg.appendChild(group);
  });
  layoutCache.clear();
  nextLayout.forEach((value, key) => layoutCache.set(key, value));

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
  $('turn-detail').textContent = over ? 'The game is complete' : game.awaitingMove ? 'Choose a token' : 'Roll the dice';
  $('turn-banner').querySelector('.turn-dot').className = 'turn-dot color-' + (over ? (game.winner || player.id) : player.id);
  $('turn-banner').classList.toggle('is-waiting', !over && !state.local && player.id !== state.color);

  // The die travels to the home square of whoever is on turn.
  const seatFor = over ? (game.winner || player.id) : player.id;
  const overlay = $('dice-overlay');
  if (overlay.dataset.seat !== seatFor) overlay.dataset.seat = seatFor;

  if (!state.diceAnim) $('dice-face').textContent = game.dice ? DICE_FACES[game.dice] : '⚄';
  $('dice-caption').textContent = over ? 'DONE' : game.awaitingMove ? 'PICK' : 'ROLL';
  $('dice-title').textContent = game.awaitingMove ? 'Choose your token' : 'Roll the dice';
  $('dice-subtitle').textContent = game.awaitingMove ? game.dice + ' spaces to move' : 'A six brings a token out';

  const mine = state.local ? player.kind === 'human' : player.id === state.color;
  $('roll-dice').disabled = !mine || game.awaitingMove || over;
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
    return '<div class="game-player' + (active ? ' active' : '') + (done ? ' finished' : '') + (voiceClient.isSpeaking(entry.id) ? ' is-speaking' : '') + '" data-player-id="' + esc(entry.id) + '">' +
      '<span class="seat-dot color-' + entry.id + '"></span>' +
      '<div><b>' + esc(entry.name) + (you ? ' · YOU' : '') + (done ? ' · HOME' : '') + '</b>' +
      '<small>' + home + '/4 HOME · ' + entry.captures + ' CAPTURES</small></div>' +
      '<span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i></span>' +
      (active ? '<span class="turn-flag">TURN</span>' : '') + '</div>';
  }).join('');

  board($('game-board'), game, mine && !over);
  cues(game);
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
      '<span class="seat-dot color-' + entry.id + '"></span>' +
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
  node.innerHTML = '<small>' + esc(label) + '</small>' + (color ? '<span class="seat-dot color-' + color + '"></span> ' : '') + esc(text);
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
      (line.color ? '<span class="seat-dot color-' + line.color + '"></span>' : '') +
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

function startDiceTumble() {
  stopDice();
  const button = $('roll-dice');
  button.classList.add('rolling');
  state.diceAnim = { target: null, landed: 0, timer: null };
  state.diceAnim.timer = setInterval(() => {
    const anim = state.diceAnim;
    if (!anim) return;
    if (anim.target != null) {
      anim.landed += 1;
      if (anim.landed >= 4) { finishDice(anim.target); return; }
    }
    $('dice-face').textContent = DICE_FACES[1 + Math.floor(Math.random() * 6)];
  }, 62);
}
function landDice(value) {
  if (!state.diceAnim) { $('dice-face').textContent = DICE_FACES[value] || '⚄'; return; }
  state.diceAnim.target = value;
}
function finishDice(value) {
  stopDice();
  $('dice-face').textContent = DICE_FACES[value] || '⚄';
  const button = $('roll-dice');
  button.classList.remove('rolling');
  button.classList.add('landed');
  setTimeout(() => button.classList.remove('landed'), 420);
}
function stopDice() {
  if (state.diceAnim?.timer) clearInterval(state.diceAnim.timer);
  state.diceAnim = null;
  $('roll-dice').classList.remove('rolling');
}

/* ---------------------------------------------------------------- audio cues -- */

function cues(game) {
  const length = game.history.length;
  if (state.seenLen == null || length < state.seenLen) { state.seenLen = length; return; }
  if (length === state.seenLen) return;
  const entry = game.history[length - 1];
  state.seenLen = length;
  if (!prefs.sound) return;
  if (game.status === 'finished') sfx.win();
  else if (entry.type === 'move') (entry.captured && entry.captured.length) ? sfx.capture() : (entry.enteredHome ? sfx.bonus() : sfx.move());
  else if (entry.type === 'roll') sfx.roll();
  else sfx.pen();
}

/* --------------------------------------------------------------- actions -- */

async function createRoom() {
  const name = await askName({ heading: 'What should we call you?', note: 'Pick a name before you open the table.', showVoiceToggle: true });
  if (!name) return;
  const voiceEnabled = $('create-voice-setting').checked;
  $('create-voice-option').hidden = true;
  setPlayerName(name);
  const button = $('create-room');
  button.classList.add('is-busy');
  try {
    await connect();
    send('room.create', { name, voiceEnabled });
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
    send('room.join', { invite, playerToken: token, name: typedName });
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
  layoutCache.clear();
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
  if ($('roll-dice').disabled) return;
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
    renderGame();
    maybeAutoMove();
    maybeAI();
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
    try {
      if (state.game.awaitingMove) {
        const choice = E.chooseAIMove(state.game, Math.random, state.aiDifficulty);
        if (choice !== null) state.game = E.applyMove(state.game, choice);
      } else {
        state.game = E.applyRoll(state.game, 1 + Math.floor(Math.random() * 6));
      }
    } catch { /* the table changed under us; the next tick will sort it out */ }
    renderGame();
    if (state.game.status === 'finished') result();
    else { maybeAutoMove(); maybeAI(); }
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
$('leave-game').onclick = leaveGame;
$('play-again').onclick = async () => {
  if (state.local) { startLocalGame(state.ai ? 'ai' : 'local'); return; }
  send('game.rematch');
};
$('chat-send').onclick = chat;
$('lobby-voice-toggle').onclick = () => voiceClient.toggle();
$('game-voice-toggle').onclick = () => voiceClient.toggle();
$('chat-input').onkeydown = (event) => { if (event.key === 'Enter') chat(); };
$('chat-input').onfocus = clearChatUnread;
$('settings-open').onclick = openSettings;
$('settings-save').onclick = () => { savePrefs(readForm()); $('settings-dialog').close(); toast('Preferences saved', 'success'); };
// Live preview inside the settings sheet; closing without saving restores the saved look.
$('settings-dialog').addEventListener('change', () => { applyPrefs(readForm()); });
$('settings-dialog').addEventListener('close', () => { applyPrefs(prefs); fillForm(prefs); });
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
  applyPrefs(prefs);
  fillForm(prefs);
  syncAvatar();
  confetti.init();
  preview();

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
    send('room.join', { invite, playerToken: token, name: playerName() });
  } catch {
    state.resuming = false;
  }
}

init();
