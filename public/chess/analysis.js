import { Chess } from './vendor/chess.js';

/* ==========================================================================
   Post-game analysis. Every position of the game is searched by Stockfish at full
   strength; each move is then judged by how much winning chance it gave away,
   compared with the engine's best move in the position before it.
   ========================================================================== */

const MATE = 10000;

// Win probability (0-100) for the side the score is for, from centipawns.
export function winPct(cp) { return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); }

// Engine scores are for the side to move; analysis keeps everything from White's point of view.
export function whiteScore(info, fen) {
  if (!info) return 0;
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const raw = info.kind === 'mate' ? (info.value > 0 ? MATE - info.value : -MATE - info.value) : info.value;
  return raw * sign;
}

export function formatEval(cp) {
  if (Math.abs(cp) >= MATE - 200) {
    const n = MATE - Math.abs(cp);
    return (cp > 0 ? '+M' : '−M') + n;
  }
  const v = cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

export const MARKS = {
  best: { label: 'Best', sym: '★' },
  good: { label: 'Good', sym: '' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!' },
  mistake: { label: 'Mistake', sym: '?' },
  blunder: { label: 'Blunder', sym: '??' },
};
export function classify(loss, playedBest) {
  if (playedBest || loss < 1) return 'best';
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  if (loss < 15) return 'mistake';
  return 'blunder';
}

// fens: position before the first move, then after each move.
export async function analyzeGame(engine, moves, { movetime = 160, onProgress, isCancelled } = {}) {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const m of moves) { chess.move({ from: m.from, to: m.to, promotion: m.promotion }); fens.push(chess.fen()); }
  const positions = [];
  for (let i = 0; i < fens.length; i++) {
    if (isCancelled && isCancelled()) return null;
    const g = new Chess(fens[i]);
    let entry;
    if (g.isCheckmate()) entry = { cp: g.turn() === 'w' ? -MATE : MATE, best: null, mate: 0 };
    else if (g.isDraw() || g.isStalemate()) entry = { cp: 0, best: null };
    else {
      const res = await engine.go({ fen: fens[i], movetime, options: {} });
      entry = { cp: whiteScore(res.info, fens[i]), best: res.best, pv: res.info ? res.info.pv : [], depth: res.info ? res.info.depth : 0 };
    }
    positions.push(entry);
    if (onProgress) onProgress((i + 1) / fens.length, i);
  }
  const judged = moves.map((m, i) => {
    const white = i % 2 === 0;
    const before = positions[i].cp, after = positions[i + 1].cp;
    const lossRaw = white ? winPct(before) - winPct(after) : winPct(-before) - winPct(-after);
    const loss = Math.max(0, lossRaw);
    const uci = m.uci || (m.from + m.to + (m.promotion || ''));
    const playedBest = positions[i].best === uci;
    return { loss, kind: classify(loss, playedBest), best: positions[i].best, bestSan: positions[i].best ? sanOf(fens[i], positions[i].best) : null, playedBest };
  });
  return { fens, positions, judged, summary: summarize(judged) };
}

function sanOf(fen, uci) {
  try {
    const g = new Chess(fen);
    const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return m.san;
  } catch { return uci; }
}

function summarize(judged) {
  const blank = () => ({ best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, accuracy: 100, moves: 0 });
  const out = { white: blank(), black: blank() };
  const losses = { white: [], black: [] };
  judged.forEach((j, i) => {
    const side = i % 2 === 0 ? 'white' : 'black';
    out[side][j.kind]++; out[side].moves++;
    losses[side].push(103.1668 * Math.exp(-0.04354 * j.loss) - 3.1669);
  });
  for (const side of ['white', 'black']) {
    const arr = losses[side];
    out[side].accuracy = arr.length ? Math.max(0, Math.min(100, arr.reduce((a, b) => a + b, 0) / arr.length)) : 100;
  }
  return out;
}
