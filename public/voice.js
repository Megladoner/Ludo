'use strict';

/* ==========================================================================
   PARCHEESI — voice chat
   A small mesh of direct browser-to-browser lines. The game server only
   carries the handshake; the audio itself never touches it.
   ========================================================================== */

(function (global) {
  const SEAT_ORDER = ['red', 'green', 'yellow', 'blue'];
  // Above this the voice is counted as speech. Low enough for a normal
  // speaking voice, high enough that a quiet room stays quiet.
  const SPEAKING_RMS = 0.02;
  const POLL_MS = 120;

  /* ------------------------------------------------------- pure helpers -- */

  // One side of every pair opens the line, so the two browsers never both
  // offer at the same time. The seat earlier in the table opens it.
  function initiatorFor(a, b) {
    const ia = SEAT_ORDER.indexOf(a);
    const ib = SEAT_ORDER.indexOf(b);
    if (ia < 0) return b;
    if (ib < 0) return a;
    return ia < ib ? a : b;
  }

  // Keep only what the browser can actually use.
  function normalizeIce(config) {
    const list = config && Array.isArray(config.iceServers) ? config.iceServers : [];
    const clean = [];
    for (const entry of list) {
      if (!entry) continue;
      const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
      const kept = urls.filter((url) => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url));
      if (!kept.length) continue;
      clean.push({ urls: kept, username: entry.username, credential: entry.credential });
    }
    return clean;
  }

  function isSpeaking(rms) {
    return Number.isFinite(rms) && rms > SPEAKING_RMS;
  }

  /* ------------------------------------------------------------- voice -- */

  class Voice {
    constructor(options = {}) {
      this.send = typeof options.send === 'function' ? options.send : () => {};
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.color = options.color || null;
      this.sinks = options.sinks || null;
      this.stream = null;
      this.track = null;
      this.iceServers = [];
      this.peers = new Map();
      this.meters = new Map();
      this.levels = new Map();
      this.audio = new Map();
      this.joined = false;
      this.muted = false;
      this.talking = false;
      this.session = null;
      this.context = null;
      this.timer = null;
      this.busy = false;
    }

    /* -- lifecycle -- */

    setColor(color) { this.color = color; }

    get active() { return this.joined; }

    // The seats this browser currently holds a line to.
    get seats() { return Array.from(this.peers.keys()); }

    async enable() {
      if (this.joined || this.busy) return false;
      if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('This browser cannot share a microphone');
      }
      this.busy = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        this.stream = stream;
        this.track = stream.getAudioTracks()[0] || null;
        if (!this.track) throw new Error('No microphone was found');
        this.iceServers = normalizeIce(await fetchIce());
        this.joined = true;
        this.muted = false;
        this.talking = false;
        this.session = sessionId();
        this.applyTrackState();
        this.meter(this.stream, this.color);
        // Tell the table we are here; everyone already talking answers.
        this.send('hello', null, { session: this.session });
        this.report();
        return true;
      } finally {
        this.busy = false;
      }
    }

    disable() {
      if (!this.joined) return;
      this.send('bye', null, {});
      this.closeAll();
      this.stopMeter(this.color);
      if (this.track) { try { this.track.stop(); } catch {} }
      this.stream = null;
      this.track = null;
      this.joined = false;
      this.muted = false;
      this.talking = false;
      this.session = null;
      this.levels.delete(this.color);
      this.report();
    }

    toggleMute() {
      if (!this.joined) return false;
      this.muted = !this.muted;
      this.applyTrackState();
      this.announceState();
      this.report();
      return this.muted;
    }

    // Push to talk: while the key is held the microphone opens, even when muted.
    setTalking(on) {
      const next = !!on;
      if (next === this.talking) return;
      this.talking = next;
      this.applyTrackState();
      this.announceState();
      this.report();
    }

    // The far end cannot hear whether a microphone is open or closed, so the
    // seat says so itself.
    announceState() {
      if (!this.joined) return;
      for (const color of this.peers.keys()) {
        this.send('state', color, { muted: this.muted && !this.talking });
      }
    }

    applyTrackState() {
      if (!this.track) return;
      this.track.enabled = this.talking || !this.muted;
    }

    /* -- the mesh -- */

    ensurePeer(color, session) {
      let peer = this.peers.get(color);
      // A seat that reopened its microphone starts a fresh session, so the
      // line from last time is no good.
      if (peer && peer.session && session && peer.session !== session) {
        this.closePeer(color);
        peer = null;
      }
      if (peer && peer.pc.connectionState !== 'closed') {
        if (session && !peer.session) peer.session = session;
        return peer;
      }
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      peer = { color, pc, madeOffer: false, pending: [], remoteTrack: null, session: session || null, remoteMuted: false };
      this.peers.set(color, peer);
      if (this.track) pc.addTrack(this.track, this.stream);
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const data = event.candidate.toJSON ? event.candidate.toJSON() : {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        };
        this.send('ice', color, data);
      };
      pc.ontrack = (event) => this.attachRemote(color, event);
      pc.onconnectionstatechange = () => {
        this.report();
        if (pc.connectionState === 'failed') this.restart(color);
      };
      this.report();
      return peer;
    }

    async connectTo(color, session) {
      if (!this.joined || color === this.color) return;
      const peer = this.ensurePeer(color, session);
      if (initiatorFor(this.color, color) !== this.color) return;
      if (peer.madeOffer) return;
      peer.madeOffer = true;
      try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.send('offer', color, { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp, session: this.session });
        this.send('state', color, { muted: this.muted && !this.talking });
      } catch {
        peer.madeOffer = false;
      }
    }

    async onOffer(from, data) {
      if (!this.joined || !data || typeof data.sdp !== 'string') return;
      const peer = this.ensurePeer(from, data.session);
      try {
        await peer.pc.setRemoteDescription({ type: data.type || 'offer', sdp: data.sdp });
        await this.flush(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.send('answer', from, { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp, session: this.session });
      } catch (error) {
        console.warn('The voice handshake did not complete', error && error.message);
      }
    }

    async onAnswer(from, data) {
      if (!data || typeof data.sdp !== 'string') return;
      const peer = this.peers.get(from);
      if (!peer) return;
      try {
        await peer.pc.setRemoteDescription({ type: data.type || 'answer', sdp: data.sdp });
        await this.flush(peer);
      } catch (error) {
        console.warn('The voice handshake did not complete', error && error.message);
      }
    }

    async onIce(from, data) {
      if (!data || typeof data.candidate !== 'string') return;
      const existing = this.peers.get(from);
      // A candidate from a line that has already been replaced is not wanted.
      if (existing && existing.session && data.session && existing.session !== data.session) return;
      const peer = this.ensurePeer(from, data.session);
      const candidate = { candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex, usernameFragment: data.usernameFragment };
      if (!peer.pc.remoteDescription) { peer.pending.push(candidate); return; }
      try { await peer.pc.addIceCandidate(candidate); } catch { /* ignore */ }
    }

    async flush(peer) {
      const queued = peer.pending.splice(0);
      for (const candidate of queued) {
        try { await peer.pc.addIceCandidate(candidate); } catch { /* ignore */ }
      }
    }

    attachRemote(color, event) {
      const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
      let audio = this.audio.get(color);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('aria-hidden', 'true');
        if (this.sinks) this.sinks.appendChild(audio);
        this.audio.set(color, audio);
      }
      audio.srcObject = stream;
      const played = audio.play();
      if (played && played.catch) played.catch(() => {});
      const peer = this.peers.get(color);
      if (peer) peer.remoteTrack = event.track;
      this.watchTrack(color, event.track);
      this.meter(stream, color);
      this.report();
    }

    // A remote muting their microphone shows up on the track itself.
    watchTrack(color, track) {
      if (!track || track.__parcheesiWatched === this) return;
      track.__parcheesiWatched = this;
      const tell = () => this.report();
      track.addEventListener('mute', tell);
      track.addEventListener('unmute', tell);
      track.addEventListener('ended', tell);
    }

    restart(color) {
      this.closePeer(color);
      if (this.joined) this.connectTo(color);
    }

    closePeer(color) {
      const peer = this.peers.get(color);
      if (peer) {
        try { peer.pc.close(); } catch {}
        this.peers.delete(color);
      }
      const audio = this.audio.get(color);
      if (audio) { audio.srcObject = null; audio.remove(); this.audio.delete(color); }
      this.stopMeter(color);
      this.levels.delete(color);
    }

    closeAll() {
      for (const color of Array.from(this.peers.keys())) this.closePeer(color);
    }

    /* -- the signal -- */

    handleSignal(message) {
      if (!message || typeof message !== 'object') return;
      const from = message.from;
      const kind = message.kind;
      const data = message.data || {};
      if (!from || from === this.color) return;
      if (kind === 'hello') {
        // Only a seat that is actually talking answers.
        if (!this.joined) return;
        this.send('here', from, { session: this.session });
        this.connectTo(from, data && data.session);
        return;
      }
      if (kind === 'here') { this.connectTo(from, data && data.session); return; }
      if (kind === 'offer') { this.onOffer(from, data); return; }
      if (kind === 'answer') { this.onAnswer(from, data); return; }
      if (kind === 'ice') { this.onIce(from, data); return; }
      if (kind === 'state') {
        const peer = this.peers.get(from);
        if (peer) { peer.remoteMuted = !!data.muted; this.report(); }
        return;
      }
      if (kind === 'bye') { this.closePeer(from); this.report(); }
    }

    // A seat that left the table takes its line with it.
    dropSeat(color) {
      if (this.peers.has(color) || this.audio.has(color)) {
        this.closePeer(color);
        this.report();
      }
    }

    /* -- levels -- */

    meter(stream, color) {
      if (!stream || this.meters.has(color)) return;
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) return;
      try {
        if (!this.context) this.context = new AudioContextClass();
        if (this.context.state === 'suspended') this.context.resume().catch(() => {});
        const source = this.context.createMediaStreamSource(stream);
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        this.meters.set(color, { source, analyser, data: new Uint8Array(analyser.fftSize) });
        if (!this.timer) this.timer = setInterval(() => this.sample(), POLL_MS);
      } catch { /* metering is a nicety, not a requirement */ }
    }

    stopMeter(color) {
      const meter = this.meters.get(color);
      if (!meter) return;
      try { meter.source.disconnect(); } catch {}
      this.meters.delete(color);
      if (!this.meters.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    sample() {
      let changed = false;
      for (const [color, meter] of this.meters) {
        meter.analyser.getByteTimeDomainData(meter.data);
        let sum = 0;
        for (let i = 0; i < meter.data.length; i++) {
          const value = (meter.data[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / meter.data.length);
        const speaking = isSpeaking(rms);
        const previous = this.levels.get(color);
        if (!previous || previous.speaking !== speaking) changed = true;
        this.levels.set(color, { rms, speaking });
      }
      if (changed) this.report();
    }

    /* -- what the interface draws -- */

    peerState(color) {
      if (color === this.color) {
        if (!this.joined) return 'off';
        return this.muted && !this.talking ? 'muted' : 'live';
      }
      const peer = this.peers.get(color);
      if (!peer) return 'off';
      const connection = peer.pc.connectionState;
      if (connection === 'connected' || connection === 'completed') {
        if (peer.remoteMuted) return 'muted';
        return 'live';
      }
      if (connection === 'connecting' || connection === 'new') return 'connecting';
      if (connection === 'failed' || connection === 'closed') return 'off';
      return 'connecting';
    }

    speaking(color) {
      const level = this.levels.get(color);
      return !!(level && level.speaking);
    }

    status() {
      const peers = {};
      for (const color of SEAT_ORDER) peers[color] = { state: this.peerState(color), speaking: this.speaking(color) };
      return { joined: this.joined, muted: this.muted, talking: this.talking, peers };
    }

    report() { this.onChange(this.status()); }

    destroy() {
      this.disable();
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.context) { try { this.context.close(); } catch {} this.context = null; }
    }
  }

  // A short, unique stamp for one visit to the voice channel.
  function sessionId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function fetchIce() {
    try {
      const response = await fetch('/api/voice/ice', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('ice request failed');
      return await response.json();
    } catch {
      // Without a configuration the browser can still try its own defaults.
      return { iceServers: [] };
    }
  }

  const api = { SEAT_ORDER, SPEAKING_RMS, initiatorFor, normalizeIce, isSpeaking, sessionId, Voice, fetchIce };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ParcheesiVoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
