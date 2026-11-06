/* ==========================================================================
   Stockfish in a Web Worker (the single-threaded "lite" WebAssembly build, which
   needs no special server headers). The page never blocks: every search is a
   message to the worker and a promise back.
   ========================================================================== */

export const ENGINE_URL = '/chess/engine/stockfish-19-lite-single.js';

// Seven strengths. The three lowest use Stockfish's own "Skill Level" with a depth cap
// (it deliberately plays imperfect moves); the rest use UCI_LimitStrength with a target
// Elo, so the engine genuinely plays at that level instead of just thinking less.
export const LEVELS = [
  { id: 1, name: 'Rookie', blurb: 'Learning the pieces', rating: '≈ 400', opts: { 'Skill Level': 0 }, depth: 1, movetime: 60 },
  { id: 2, name: 'Beginner', blurb: 'Knows the basics', rating: '≈ 800', opts: { 'Skill Level': 3 }, depth: 2, movetime: 120 },
  { id: 3, name: 'Intermediate', blurb: 'Club newcomer', rating: '≈ 1400', opts: { UCI_LimitStrength: true, UCI_Elo: 1400 }, movetime: 400 },
  { id: 4, name: 'Advanced', blurb: 'Solid club player', rating: '≈ 1800', opts: { UCI_LimitStrength: true, UCI_Elo: 1800 }, movetime: 600 },
  { id: 5, name: 'Expert', blurb: 'Tournament regular', rating: '≈ 2300', opts: { UCI_LimitStrength: true, UCI_Elo: 2300 }, movetime: 900 },
  { id: 6, name: 'Master', blurb: 'Titled strength', rating: '≈ 2800', opts: { UCI_LimitStrength: true, UCI_Elo: 2800 }, movetime: 1300 },
  { id: 7, name: 'Grandmaster', blurb: 'Full strength', rating: '3000+', opts: { UCI_LimitStrength: false, 'Skill Level': 20 }, movetime: 2200 },
];
const RESET = { UCI_LimitStrength: false, 'Skill Level': 20 };

export class Engine {
  constructor(url = ENGINE_URL) {
    this.url = url;
    this.worker = null;
    this.readyPromise = null;
    this.waiters = [];
    this.current = null;
    this.chain = Promise.resolve();
    this.options = {};
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(this.url); } catch (error) { reject(error); return; }
      this.worker = worker;
      worker.onmessage = (e) => this.line(String(e.data));
      worker.onerror = (e) => {
        const err = new Error('The chess engine could not start');
        reject(err);
        if (this.current) { this.current.reject(err); this.current = null; }
      };
      this.expect('uciok').then(() => {
        this.send('setoption name Hash value 16');
        this.send('isready');
        return this.expect('readyok');
      }).then(resolve, reject);
      this.send('uci');
    });
    this.readyPromise.catch(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  send(cmd) { if (this.worker) this.worker.postMessage(cmd); }
  expect(prefix) {
    return new Promise((resolve) => this.waiters.push({ prefix, resolve }));
  }

  line(text) {
    for (let i = 0; i < this.waiters.length; i++) {
      if (text.startsWith(this.waiters[i].prefix)) { const w = this.waiters.splice(i, 1)[0]; w.resolve(text); break; }
    }
    const cur = this.current;
    if (!cur) return;
    if (text.startsWith('info ') && text.includes(' score ')) {
      const m = /score (cp|mate) (-?\d+)/.exec(text);
      const d = /\bdepth (\d+)/.exec(text);
      const pv = / pv (.+)$/.exec(text);
      const mp = /multipv (\d+)/.exec(text);
      if (m && (!mp || mp[1] === '1')) {
        cur.info = { kind: m[1], value: Number(m[2]), depth: d ? Number(d[1]) : 0, pv: pv ? pv[1].split(' ') : [] };
      }
    } else if (text.startsWith('bestmove')) {
      const parts = text.split(' ');
      this.current = null;
      cur.resolve({ best: parts[1] && parts[1] !== '(none)' ? parts[1] : null, ponder: parts[3] || null, info: cur.info || null });
    }
  }

  async setOptions(opts) {
    for (const [name, value] of Object.entries(opts)) {
      if (this.options[name] === value) continue;
      this.options[name] = value;
      this.send('setoption name ' + name + ' value ' + value);
    }
  }

  // Resolves with { best, info: { kind: 'cp'|'mate', value, depth, pv } } where the score is for the side to move.
  go({ fen, movetime, depth, options }) {
    const run = async () => {
      await this.start();
      await this.setOptions(Object.assign({}, RESET, options || {}));
      this.send('isready');
      await this.expect('readyok');
      return new Promise((resolve, reject) => {
        this.current = { resolve, reject, info: null };
        this.send('position fen ' + fen);
        this.send('go ' + (depth ? 'depth ' + depth + ' ' : '') + 'movetime ' + Math.max(10, Math.round(movetime || 500)));
      });
    };
    const task = this.chain.then(run, run);
    this.chain = task.catch(() => {});
    return task;
  }

  // Ends the running search early (it still answers with its best move so far).
  stop() { if (this.current) this.send('stop'); }
  newGame() { this.send('ucinewgame'); }
  terminate() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.readyPromise = null; this.current = null; this.waiters = []; this.options = {};
  }
}

// Moves for one engine turn at a level, kept inside what the clock can afford.
export function budgetFor(level, remainingMs) {
  let t = level.movetime;
  if (remainingMs != null) t = Math.min(t, Math.max(40, remainingMs / 25));
  return { movetime: t, depth: level.depth };
}
