'use strict';
/* ==========================================================================
   PARCHEESI — sound
   Everything is synthesised with the Web Audio API: no files, no requests,
   nothing for the strict CSP to object to. Each effect is a few layered
   voices (tone, noise, bell) through one compressor and a small room reverb.
   ========================================================================== */
(function () {
  var ctx = null, bus = null, master = null, enabled = true, volume = 0.8, noiseBuf = null;

  function boot() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 4;
      comp.attack.value = 0.004; comp.release.value = 0.18;
      bus = ctx.createGain();
      bus.connect(comp);
      // A short synthetic room: decaying stereo noise.
      var len = Math.floor(ctx.sampleRate * 1.1);
      var impulse = ctx.createBuffer(2, len, ctx.sampleRate);
      for (var c = 0; c < 2; c++) {
        var data = impulse.getChannelData(c);
        for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      var verb = ctx.createConvolver();
      verb.buffer = impulse;
      var wet = ctx.createGain();
      wet.gain.value = 0.2;
      bus.connect(verb); verb.connect(wet); wet.connect(comp);
      comp.connect(master); master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var n = noiseBuf.getChannelData(0);
      for (var j = 0; j < n.length; j++) n[j] = Math.random() * 2 - 1;
    } catch (error) { ctx = null; }
    return ctx;
  }

  function ready() {
    if (!enabled) return false;
    if (!boot()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // One oscillator voice. f2 glides the pitch; lp closes a low-pass over the note.
  function tone(o) {
    var t = ctx.currentTime + (o.at || 0);
    var dur = o.dur || 0.2;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + dur * (o.glide || 0.9));
    if (o.detune) osc.detune.value = o.detune;
    var peak = o.vol == null ? 0.1 : o.vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var out = osc;
    if (o.lp) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, o.lp * 0.18), t + dur);
      osc.connect(f); out = f;
    }
    out.connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  // A burst of filtered noise: clicks, clacks, swooshes.
  function noise(o) {
    var t = ctx.currentTime + (o.at || 0);
    var dur = o.dur || 0.05;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f || 2000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
    f.Q.value = o.q || 1.2;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol == null ? 0.1 : o.vol, t + (o.attack || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.03);
  }

  // A struck bell: sine partials that are not whole multiples of the root.
  function bell(f, vol, at, dur) {
    var partials = [[1, 1], [2.76, 0.42], [5.4, 0.2], [8.93, 0.09]];
    for (var i = 0; i < partials.length; i++) {
      tone({ f: f * partials[i][0], dur: (dur || 1.1) / (1 + i * 0.7), vol: vol * partials[i][1], at: at || 0, attack: 0.003 });
    }
  }

  // A plucked note: bright start that darkens quickly.
  function pluck(f, vol, at, dur) {
    tone({ f: f, dur: dur || 0.34, type: 'triangle', vol: vol, at: at || 0, lp: 5200 });
    tone({ f: f * 2, dur: (dur || 0.34) * 0.5, type: 'sine', vol: vol * 0.35, at: at || 0 });
  }

  var jitter = function (x, amount) { return x * (1 + (Math.random() * 2 - 1) * amount); };

  var sfx = {
    // Soft tap for buttons and menus.
    click: function () {
      if (!ready()) return;
      noise({ f: 3200, q: 2, dur: 0.02, vol: 0.05 });
      tone({ f: 760, f2: 520, dur: 0.05, vol: 0.04, type: 'sine' });
    },
    // The die is shaken and thrown: a rattle of clacks that tightens up.
    roll: function () {
      if (!ready()) return;
      var gaps = [0, 0.055, 0.105, 0.15, 0.19, 0.228, 0.262, 0.294, 0.324, 0.352];
      for (var i = 0; i < gaps.length; i++) {
        var fall = 1 - i * 0.06;
        noise({ f: jitter(2300, 0.35), q: 2.2, dur: 0.028, vol: 0.085 * fall, at: gaps[i] });
        tone({ f: jitter(260, 0.25), f2: 150, dur: 0.05, vol: 0.06 * fall, at: gaps[i], type: 'triangle', lp: 1800 });
      }
    },
    // The die hits the table and bounces once or twice.
    land: function () {
      if (!ready()) return;
      tone({ f: 150, f2: 62, dur: 0.16, vol: 0.2, type: 'sine' });
      noise({ type: 'lowpass', f: 900, dur: 0.07, vol: 0.12 });
      noise({ f: 2600, q: 2, dur: 0.03, vol: 0.06 });
      tone({ f: 190, f2: 90, dur: 0.1, vol: 0.09, at: 0.13, type: 'sine' });
      noise({ f: 2400, q: 2, dur: 0.025, vol: 0.04, at: 0.13 });
      tone({ f: 210, f2: 110, dur: 0.07, vol: 0.045, at: 0.23, type: 'sine' });
    },
    // A six deserves a little sparkle.
    six: function () {
      if (!ready()) return;
      [784, 988, 1175, 1568].forEach(function (f, i) { bell(f, 0.035, 0.05 + i * 0.065, 0.7); });
    },
    // One hop of a token landing on a square. Later steps ring slightly higher.
    step: function (index) {
      if (!ready()) return;
      var f = jitter(330 * Math.pow(1.045, index || 0), 0.03);
      tone({ f: f, f2: f * 0.52, dur: 0.075, vol: 0.13, type: 'sine' });
      noise({ f: 2600, q: 1.6, dur: 0.016, vol: 0.07 });
    },
    // A token leaves the starting box.
    enter: function () {
      if (!ready()) return;
      noise({ f: 500, f2: 3200, q: 3, dur: 0.26, vol: 0.05, attack: 0.05 });
      pluck(392, 0.09, 0.02, 0.3);
      pluck(587, 0.09, 0.1, 0.36);
      pluck(784, 0.07, 0.19, 0.4);
    },
    // A token lands on a safe star.
    safe: function () {
      if (!ready()) return;
      bell(988, 0.05, 0, 0.8);
    },
    // A capture: a heavy knock, a crunch and a low sweep.
    capture: function () {
      if (!ready()) return;
      tone({ f: 130, f2: 42, dur: 0.3, vol: 0.28, type: 'sine' });
      noise({ type: 'lowpass', f: 1400, f2: 200, dur: 0.22, vol: 0.2 });
      noise({ f: 3800, q: 1, dur: 0.05, vol: 0.09 });
      tone({ f: 440, f2: 90, dur: 0.34, vol: 0.07, type: 'sawtooth', lp: 1400, at: 0.02 });
    },
    // The captured token tumbles back to its box.
    sentHome: function () {
      if (!ready()) return;
      tone({ f: 560, f2: 170, dur: 0.42, vol: 0.075, type: 'triangle', at: 0.12, lp: 2400 });
      noise({ f: 1800, f2: 300, q: 2, dur: 0.4, vol: 0.035, at: 0.12 });
    },
    // A token reaches its home lane, or earns another move.
    bonus: function () {
      if (!ready()) return;
      [523, 659, 784].forEach(function (f, i) { pluck(f, 0.09, i * 0.075, 0.3); });
      bell(1047, 0.04, 0.22, 0.9);
    },
    // A token reaches the centre triangle.
    finish: function () {
      if (!ready()) return;
      [523, 659, 784, 1047, 1319].forEach(function (f, i) { bell(f, 0.055, i * 0.085, 1.3); });
      noise({ f: 4000, f2: 9000, q: 1, dur: 0.5, vol: 0.02, at: 0.1, attack: 0.1 });
    },
    // The whole game is decided.
    win: function () {
      if (!ready()) return;
      var chords = [[262, 330, 392], [349, 440, 523], [392, 494, 587], [523, 659, 784, 1047]];
      chords.forEach(function (chord, i) {
        var at = i * 0.24;
        chord.forEach(function (f) {
          tone({ f: f, dur: i === 3 ? 1.6 : 0.34, type: 'triangle', vol: 0.065, at: at, lp: 3800 });
          tone({ f: f * 1.004, dur: i === 3 ? 1.6 : 0.34, type: 'sawtooth', vol: 0.016, at: at, lp: 2200 });
        });
      });
      bell(1568, 0.05, 0.72, 1.8); bell(2093, 0.035, 0.84, 1.8);
    },
    // It is your turn.
    turn: function () {
      if (!ready()) return;
      tone({ f: 659, dur: 0.18, vol: 0.06, type: 'sine' });
      tone({ f: 988, dur: 0.32, vol: 0.055, type: 'sine', at: 0.1 });
    },
    // Three sixes: the turn is lost.
    penalty: function () {
      if (!ready()) return;
      tone({ f: 220, f2: 140, dur: 0.22, vol: 0.09, type: 'square', lp: 900 });
      tone({ f: 165, f2: 98, dur: 0.34, vol: 0.09, type: 'square', lp: 700, at: 0.17 });
    },
    // A roll with nothing to move.
    noMove: function () {
      if (!ready()) return;
      tone({ f: 190, f2: 120, dur: 0.18, vol: 0.08, type: 'triangle', lp: 1200 });
    },
  };

  // Browsers keep audio locked until the first tap or key press.
  function unlock() {
    if (!enabled) return;
    boot();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (name) {
    window.addEventListener(name, unlock, { passive: true });
  });

  window.ParcheesiAudio = {
    sfx: sfx,
    setEnabled: function (on) { enabled = !!on; },
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, Number(v)));
      if (master) master.gain.value = volume;
    },
  };
})();
