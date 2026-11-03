'use strict';
/*
 * PARCHEESI — local profile.
 * Everything here stays in this browser: no account, no server, no upload.
 * The profile records how many tables you have played, split between the
 * computer and friends, and holds a small photo for your seat.
 */
(function (global) {
  const PROFILE_KEY = 'parcheesi.profile';
  const PHOTO_KEY = 'parcheesi.profile.photo';
  const HISTORY_LIMIT = 40;
  const PHOTO_SIZE = 256;

  function emptyStats() {
    return {
      total: { played: 0, won: 0, lost: 0 },
      computer: { played: 0, won: 0, lost: 0 },
      friends: { played: 0, won: 0, lost: 0 },
    };
  }

  function blank() {
    return { name: '', createdAt: Date.now(), stats: emptyStats(), history: [] };
  }

  function read() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return blank();
      const profile = { ...blank(), ...parsed };
      const stats = { ...emptyStats(), ...(parsed.stats || {}) };
      for (const key of ['total', 'computer', 'friends']) {
        stats[key] = { played: 0, won: 0, lost: 0, ...(stats[key] || {}) };
      }
      profile.stats = stats;
      if (!Array.isArray(profile.history)) profile.history = [];
      return profile;
    } catch {
      return blank();
    }
  }

  function write(profile) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* private mode */ }
    return profile;
  }

  function getPhoto() {
    try { return localStorage.getItem(PHOTO_KEY) || ''; } catch { return ''; }
  }

  function setPhoto(dataUrl) {
    try {
      if (dataUrl) localStorage.setItem(PHOTO_KEY, dataUrl);
      else localStorage.removeItem(PHOTO_KEY);
    } catch { /* private mode */ }
  }

  function setName(name) {
    const profile = read();
    profile.name = String(name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20);
    return write(profile);
  }

  /*
   * Record a finished match.
   * mode: 'computer' | 'friends'
   * outcome: 'won' | 'lost' | null (pass & play has no single winner for the device)
   */
  function recordMatch({ mode, outcome, opponents, label }) {
    const profile = read();
    const bucket = mode === 'computer' ? 'computer' : 'friends';
    profile.stats.total.played += 1;
    profile.stats[bucket].played += 1;
    if (outcome === 'won') { profile.stats.total.won += 1; profile.stats[bucket].won += 1; }
    else if (outcome === 'lost') { profile.stats.total.lost += 1; profile.stats[bucket].lost += 1; }
    profile.history.unshift({
      at: Date.now(), mode, outcome: outcome || null,
      opponents: opponents || 0, label: label || '',
    });
    if (profile.history.length > HISTORY_LIMIT) profile.history.length = HISTORY_LIMIT;
    return write(profile);
  }

  function reset() {
    try { localStorage.removeItem(PROFILE_KEY); localStorage.removeItem(PHOTO_KEY); } catch { /* private mode */ }
    return blank();
  }

  // Turn an uploaded picture into a small square thumbnail that fits in localStorage.
  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file chosen'));
      if (!/^image\//.test(file.type || '')) return reject(new Error('That file is not an image'));
      if (file.size > 12 * 1024 * 1024) return reject(new Error('That picture is too large'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('Could not open that picture'));
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = PHOTO_SIZE; canvas.height = PHOTO_SIZE;
          const context = canvas.getContext('2d');
          const side = Math.min(image.width, image.height);
          const sx = (image.width - side) / 2;
          const sy = (image.height - side) / 2;
          context.drawImage(image, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
          try { resolve(canvas.toDataURL('image/jpeg', 0.82)); }
          catch { reject(new Error('Could not process that picture')); }
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  global.ParcheesiProfile = {
    get: read, save: write, getPhoto, setPhoto, setName, recordMatch, reset,
    readPhoto, emptyStats, blank,
  };
})(window);
