'use strict';

/* ==========================================================================
   PARCHEESI — voice chat

   Only rooms whose host switched "Voice chat" on use any of this. The audio
   travels straight between the players' browsers (WebRTC); the game server
   only passes along the small "hello, here is how to reach me" messages.
   Nothing is recorded and nothing is stored.

   Every voice message is one of:
     voice.state   { phase: announce | reply | update, joined, muted, to? }
     voice.signal  { kind: offer | answer, sid, sdp, to }

   Two players never both start the call: the one whose seat id sorts first
   makes the offer, the other answers. Candidates are bundled into the offer
   or answer (no trickling), so a call needs only two small messages.
   ========================================================================== */

(function () {
  // Free public STUN servers help two browsers find each other.
  // If some friends can never hear each other (strict mobile or school networks),
  // a TURN relay can be added to this list later. See VOICE-SETUP notes.
  var ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  var SPEAK_LEVEL = 0.03;     // how loud counts as "talking"
  var SPEAK_HOLD = 380;       // ms the glow lingers after the last sound
  var GATHER_TIMEOUT = 3500;  // ms to wait for network addresses before calling
  var MAX_RETRY = 2;

  var host = null;
  var v = {
    active: false, joining: false, muted: false,
    stream: null, ctx: null, selfMeter: null,
    known: new Map(),   // seat id -> { joined, muted }
    peers: new Map(),   // seat id -> { pc, sid, offerer, status, audio, meter, attempts }
    speaking: new Set(), warned: new Set(), timer: null, speakingKey: '',
  };

  var ICON = {
    mic: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    off: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>',
    eq: '<span class="voice-eq" aria-hidden="true"><i></i><i></i><i></i></span>',
  };

  /* ------------------------------------------------------------ helpers -- */

  function room() { return host ? host.room() : null; }
  function roomOn() {
    var r = room();
    return !!(r && r.voice === true && !host.isLocal());
  }
  function supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function myId() {
    var r = room();
    if (!r) return null;
    var me = r.players.find(function (p) { return p.color === host.color(); });
    return me ? me.id : null;
  }
  function playerName(id) {
    var r = room();
    var p = r && r.players.find(function (x) { return x.id === id; });
    return p ? p.name : 'A player';
  }
  function sid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function micMessage(error) {
    var name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow it in your browser settings, then try again.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
    if (name === 'NotReadableError') return 'The microphone is busy in another app.';
    return 'Could not start the microphone.';
  }

  /* -------------------------------------------------------- audio levels -- */

  function ensureContext() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!v.ctx || v.ctx.state === 'closed') v.ctx = new AC();
      if (v.ctx.state === 'suspended') v.ctx.resume().catch(function () {});
    } catch (error) { v.ctx = null; }
  }
  function makeMeter(stream) {
    if (!v.ctx) return null;
    try {
      var source = v.ctx.createMediaStreamSource(stream);
      var analyser = v.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return { source: source, analyser: analyser, buffer: new Uint8Array(analyser.fftSize), last: 0 };
    } catch (error) { return null; }
  }
  function dropMeter(meter) {
    if (!meter) return;
    try { meter.source.disconnect(); } catch (error) {}
  }
  function isLoud(meter, now) {
    if (!meter) return false;
    meter.analyser.getByteTimeDomainData(meter.buffer);
    var sum = 0;
    for (var i = 0; i < meter.buffer.length; i++) {
      var d = (meter.buffer[i] - 128) / 128;
      sum += d * d;
    }
    if (Math.sqrt(sum / meter.buffer.length) > SPEAK_LEVEL) meter.last = now;
    return now - meter.last < SPEAK_HOLD;
  }
  function tick() {
    var now = Date.now();
    var next = new Set();
    var me = myId();
    if (v.active && !v.muted && me && isLoud(v.selfMeter, now)) next.add(me);
    v.peers.forEach(function (peer, id) {
      if (peer.status === 'connected' && isLoud(peer.meter, now)) next.add(id);
    });
    var key = Array.from(next).sort().join('|');
    if (key !== v.speakingKey) {
      v.speakingKey = key;
      v.speaking = next;
      decorate();
    }
  }
  function startTimer() { if (!v.timer) v.timer = setInterval(tick, 120); }
  function stopTimer() { clearInterval(v.timer); v.timer = null; }

  /* ---------------------------------------------------------- the calls -- */

  function gathered(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      var timer = null;
      var done = function () {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      var check = function () { if (pc.iceGatheringState === 'complete') done(); };
      timer = setTimeout(done, GATHER_TIMEOUT);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function closePeer(id) {
    var peer = v.peers.get(id);
    if (!peer) return;
    v.peers.delete(id);
    v.speaking.delete(id);
    clearTimeout(peer.retryTimer);
    try {
      peer.pc.onconnectionstatechange = null;
      peer.pc.ontrack = null;
      peer.pc.close();
    } catch (error) {}
    if (peer.audio) {
      try { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); } catch (error) {}
    }
    dropMeter(peer.meter);
  }
  function closeAllPeers() {
    Array.from(v.peers.keys()).forEach(closePeer);
  }

  function attachAudio(peer, stream) {
    if (peer.audio) return;
    var el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    (document.getElementById('voice-audio') || document.body).appendChild(el);
    var started = el.play();
    if (started && started.catch) started.catch(function () {});
    peer.audio = el;
    peer.meter = makeMeter(stream);
  }

  function createPeer(id, callId, offerer, attempts) {
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    var peer = { pc: pc, sid: callId, offerer: offerer, status: 'connecting', audio: null, meter: null, attempts: attempts || 0, retryTimer: null };
    v.peers.set(id, peer);
    v.stream.getAudioTracks().forEach(function (track) { pc.addTrack(track, v.stream); });
    pc.ontrack = function (event) {
      if (v.peers.get(id) !== peer) return;
      attachAudio(peer, event.streams[0] || new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = function () {
      if (v.peers.get(id) !== peer) return;
      var state = pc.connectionState;
      if (state === 'connected') { peer.status = 'connected'; peer.attempts = 0; }
      else if (state === 'failed') { onFailed(id, peer); return; }
      else if (state === 'disconnected' || state === 'new' || state === 'connecting') peer.status = 'connecting';
      decorate();
    };
    return peer;
  }

  function onFailed(id, peer) {
    peer.status = 'failed';
    if (peer.offerer && peer.attempts < MAX_RETRY && v.active) {
      var attempts = peer.attempts + 1;
      peer.status = 'connecting';
      peer.retryTimer = setTimeout(function () {
        if (v.peers.get(id) === peer && v.active) startOffer(id, attempts);
      }, 1500);
    } else if (!peer.offerer || peer.attempts >= MAX_RETRY) {
      if (!v.warned.has(id)) {
        v.warned.add(id);
        host.toast("Couldn't connect voice with " + playerName(id) + ". One of your networks may be blocking voice chat.", 'error');
      }
    }
    decorate();
  }

  async function startOffer(id, attempts) {
    if (!v.active || !v.stream) return;
    closePeer(id);
    var callId = sid();
    var peer = createPeer(id, callId, true, attempts);
    try {
      var offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await gathered(peer.pc);
      if (v.peers.get(id) !== peer || !v.active) return;
      host.send('voice.signal', { to: id, kind: 'offer', sid: callId, sdp: peer.pc.localDescription.sdp });
    } catch (error) {
      if (v.peers.get(id) === peer) onFailed(id, peer);
    }
    decorate();
  }

  async function onOffer(from, callId, sdp) {
    if (!v.active || !v.stream) return;
    closePeer(from);
    var peer = createPeer(from, callId, false, 0);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: sdp });
      var answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await gathered(peer.pc);
      if (v.peers.get(from) !== peer || !v.active) return;
      host.send('voice.signal', { to: from, kind: 'answer', sid: callId, sdp: peer.pc.localDescription.sdp });
    } catch (error) {
      if (v.peers.get(from) === peer) onFailed(from, peer);
    }
    decorate();
  }

  async function onAnswer(from, callId, sdp) {
    var peer = v.peers.get(from);
    if (!peer || !peer.offerer || peer.sid !== callId || peer.pc.signalingState !== 'have-local-offer') return;
    try { await peer.pc.setRemoteDescription({ type: 'answer', sdp: sdp }); }
    catch (error) { if (v.peers.get(from) === peer) onFailed(from, peer); }
  }

  // Exactly one side of every pair makes the offer: the one whose seat id sorts first.
  function connectIfNeeded(id) {
    if (!v.active) return;
    var known = v.known.get(id);
    if (!known || !known.joined) return;
    var me = myId();
    if (!me || me > id) return;
    var peer = v.peers.get(id);
    if (peer && peer.status !== 'failed') return;
    startOffer(id, 0);
  }

  /* --------------------------------------------------------- messages in -- */

  function onState(m) {
    var id = m.from;
    if (typeof id !== 'string' || !id) return;
    v.known.set(id, { joined: !!m.joined, muted: !!m.muted });
    if (m.phase === 'announce') {
      // They have just arrived or reconnected, so any old link to them is stale.
      closePeer(id);
      v.warned.delete(id);
      if (v.active) host.send('voice.state', { to: id, phase: 'reply', joined: true, muted: v.muted });
    } else if (!m.joined) {
      closePeer(id);
    }
    if (m.joined) connectIfNeeded(id);
    decorate();
  }

  function handle(m) {
    if (!m || !roomOn()) return;
    if (m.type === 'voice.state') onState(m);
    else if (m.type === 'voice.signal' && typeof m.sdp === 'string') {
      if (m.kind === 'offer') onOffer(m.from, String(m.sid || ''), m.sdp);
      else if (m.kind === 'answer') onAnswer(m.from, String(m.sid || ''), m.sdp);
    }
  }

  /* -------------------------------------------------------- user actions -- */

  function announce() {
    host.send('voice.state', { phase: 'announce', joined: v.active, muted: v.muted });
  }

  async function join() {
    if (v.active || v.joining || !roomOn()) return;
    if (!supported()) {
      host.toast('Voice chat needs a newer browser (and a secure https page).', 'error');
      return;
    }
    v.joining = true;
    decorate();
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      v.joining = false;
      decorate();
      host.toast(micMessage(error), 'error');
      return;
    }
    if (!roomOn()) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      v.joining = false;
      decorate();
      return;
    }
    v.stream = stream;
    v.active = true;
    v.joining = false;
    v.muted = false;
    ensureContext();
    v.selfMeter = makeMeter(stream);
    startTimer();
    announce();
    decorate();
  }

  function teardown() {
    v.active = false;
    v.joining = false;
    v.muted = false;
    closeAllPeers();
    dropMeter(v.selfMeter);
    v.selfMeter = null;
    if (v.stream) v.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (error) {} });
    v.stream = null;
    stopTimer();
    v.speaking = new Set();
    v.speakingKey = '';
    if (v.ctx) { try { v.ctx.close(); } catch (error) {} v.ctx = null; }
  }

  function leave() {
    if (!v.active && !v.joining) return;
    var wasActive = v.active;
    teardown();
    if (wasActive && roomOn()) host.send('voice.state', { phase: 'update', joined: false, muted: false });
    decorate();
  }

  function toggleMute() {
    if (!v.active || !v.stream) return;
    v.muted = !v.muted;
    v.stream.getAudioTracks().forEach(function (track) { track.enabled = !v.muted; });
    host.send('voice.state', { phase: 'update', joined: true, muted: v.muted });
    tick();
    decorate();
  }

  // The table is gone (left, kicked or closed): stop the mic and forget everyone.
  function reset() {
    teardown();
    v.known.clear();
    v.warned.clear();
    decorate();
  }

  // Called when the seat joins or rejoins a room, including after a dropped connection.
  function onRoom() {
    if (!roomOn()) return;
    closeAllPeers();
    v.warned.clear();
    announce();
    decorate();
  }

  /* ------------------------------------------------------------- the UI -- */

  function statusOf(player) {
    var me = myId();
    if (player.id === me) {
      if (!v.active) return null;
      if (v.muted) return { kind: 'muted', title: 'You are muted' };
      return v.speaking.has(player.id) ? { kind: 'speaking', title: 'You are talking' } : { kind: 'live', title: 'You are on voice' };
    }
    var known = v.known.get(player.id);
    if (!known || !known.joined) return null;
    var peer = v.peers.get(player.id);
    if (v.active && peer && peer.status === 'failed') return { kind: 'failed', title: "Couldn't connect voice" };
    if (v.active && (!peer || peer.status !== 'connected')) return { kind: 'connecting', title: 'Connecting voice…' };
    if (known.muted) return { kind: 'muted', title: 'Muted' };
    if (v.active && v.speaking.has(player.id)) return { kind: 'speaking', title: 'Talking' };
    return { kind: 'live', title: 'On voice' };
  }

  function badgeHtml(kind) {
    if (kind === 'muted') return ICON.off;
    if (kind === 'failed') return ICON.warn;
    if (kind === 'speaking') return ICON.eq;
    return ICON.mic;
  }

  function paintBars(r) {
    var me = myId();
    var others = r.players.filter(function (p) {
      var k = v.known.get(p.id);
      return p.id !== me && k && k.joined;
    });
    var count = others.length + (v.active ? 1 : 0);
    var talkers = r.players.filter(function (p) { return v.speaking.has(p.id) && p.id !== me; }).map(function (p) { return p.name; });
    var title, sub;
    if (v.joining) { title = 'Joining voice…'; sub = 'Allow the microphone if asked'; }
    else if (v.active) {
      title = v.muted ? "You're muted" : "You're on voice";
      if (talkers.length) sub = talkers.join(', ') + (talkers.length > 1 ? ' are talking' : ' is talking');
      else sub = count > 1 ? count + ' on the call' : 'Waiting for others to join';
    } else {
      title = 'Voice chat';
      sub = count ? count + ' on the call · tap to join' : 'Talk with your table';
    }
    document.querySelectorAll('.voice-bar').forEach(function (bar) {
      bar.hidden = false;
      bar.classList.toggle('is-live', v.active && !v.muted);
      bar.classList.toggle('is-muted', v.active && v.muted);
      var t = bar.querySelector('[data-voice-title]');
      var s = bar.querySelector('[data-voice-sub]');
      if (t && t.textContent !== title) t.textContent = title;
      if (s && s.textContent !== sub) s.textContent = sub;
      var joinBtn = bar.querySelector('[data-voice="join"]');
      var muteBtn = bar.querySelector('[data-voice="mute"]');
      var leaveBtn = bar.querySelector('[data-voice="leave"]');
      if (joinBtn) {
        joinBtn.hidden = v.active;
        joinBtn.disabled = v.joining;
        if (joinBtn.dataset.state !== 'idle') { joinBtn.dataset.state = 'idle'; joinBtn.innerHTML = ICON.mic + '<span>Join voice</span>'; }
      }
      if (muteBtn) {
        muteBtn.hidden = !v.active;
        muteBtn.setAttribute('aria-pressed', v.muted ? 'true' : 'false');
        var want = v.muted ? 'unmute' : 'mute';
        if (muteBtn.dataset.state !== want) {
          muteBtn.dataset.state = want;
          muteBtn.innerHTML = (v.muted ? ICON.off : ICON.mic) + '<span>' + (v.muted ? 'Unmute' : 'Mute') + '</span>';
        }
      }
      if (leaveBtn) leaveBtn.hidden = !v.active;
    });
    var rule = document.getElementById('rule-voice');
    if (rule) rule.hidden = false;
  }

  function paintCards(r) {
    var cards = document.querySelectorAll('#player-grid .player-seat[data-color], #game-players .game-player[data-color]');
    cards.forEach(function (card) {
      var player = r.players.find(function (p) { return p.color === card.dataset.color; });
      var status = player ? statusOf(player) : null;
      var badge = null;
      for (var i = 0; i < card.children.length; i++) {
        if (card.children[i].classList.contains('voice-badge')) badge = card.children[i];
      }
      if (!status) {
        if (badge) badge.remove();
        card.classList.remove('is-speaking');
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'voice-badge';
        card.appendChild(badge);
      }
      if (badge.dataset.kind !== status.kind) {
        badge.dataset.kind = status.kind;
        badge.innerHTML = badgeHtml(status.kind);
      }
      if (badge.title !== status.title) badge.title = status.title;
      card.classList.toggle('is-speaking', status.kind === 'speaking');
    });
  }

  function decorate() {
    if (!host) return;
    var on = roomOn();
    if (!on) {
      document.querySelectorAll('.voice-bar').forEach(function (bar) { bar.hidden = true; });
      var rule = document.getElementById('rule-voice');
      if (rule) rule.hidden = true;
      document.querySelectorAll('.voice-badge').forEach(function (b) { b.remove(); });
      document.querySelectorAll('.is-speaking').forEach(function (c) { c.classList.remove('is-speaking'); });
      return;
    }
    var r = room();
    // Forget anyone who has left the table.
    var ids = new Set(r.players.map(function (p) { return p.id; }));
    Array.from(v.peers.keys()).forEach(function (id) { if (!ids.has(id)) closePeer(id); });
    Array.from(v.known.keys()).forEach(function (id) { if (!ids.has(id)) v.known.delete(id); });
    paintBars(r);
    paintCards(r);
  }

  /* ---------------------------------------------------------------- init -- */

  function resumePlayback() {
    if (v.ctx && v.ctx.state === 'suspended') v.ctx.resume().catch(function () {});
    v.peers.forEach(function (peer) {
      if (peer.audio && peer.audio.paused) {
        var p = peer.audio.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
  }

  function init(api) {
    host = api;
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-voice]');
      if (!button) return;
      var action = button.dataset.voice;
      if (action === 'join') join();
      else if (action === 'mute') toggleMute();
      else if (action === 'leave') leave();
    });
    // Browsers only start sound after a tap; any later tap wakes sleeping audio.
    document.addEventListener('pointerdown', resumePlayback, { passive: true });
    window.addEventListener('pagehide', function () { if (v.active) teardown(); });
  }

  window.ParcheesiVoice = { init: init, handle: handle, decorate: decorate, reset: reset, onRoom: onRoom };
})();
