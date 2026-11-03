'use strict';

const PLAYER_IDS = ['red', 'green', 'yellow', 'blue'];
const START_OFFSETS = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_TRACK = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
// Classic cross-shaped board on a 15x15 grid (cells 0..14). 52 shared track cells, clockwise from red's start square.
const TRACK_COORDS = (() => { const cells = []; const run = (x, y, dx, dy, n) => { for (let i = 0; i < n; i++) cells.push([x + dx * i, y + dy * i]); };
  run(1, 6, 1, 0, 5); run(6, 5, 0, -1, 6); run(7, 0, 1, 0, 2); run(8, 1, 0, 1, 5);
  run(9, 6, 1, 0, 6); run(14, 7, 0, 1, 2); run(13, 8, -1, 0, 5); run(8, 9, 0, 1, 6);
  run(7, 14, -1, 0, 2); run(6, 13, 0, -1, 5); run(5, 8, -1, 0, 6); run(0, 7, 0, -1, 2);
  return cells; })();
const HOME_COORDS = { red: [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]], green: [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]], yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]], blue: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]] };
const TOKENS_PER_PLAYER = 4;
const HOME_ENTRY_PROGRESS = 51;
const FINISH_PROGRESS = 57;

function initialState(options = {}) {
  const players = (options.players || PLAYER_IDS).map((id) => ({
    id, name: options.names?.[id] || id[0].toUpperCase() + id.slice(1),
    kind: options.kinds?.[id] || 'human', difficulty: options.difficulties?.[id] || 'normal',
    tokens: Array(TOKENS_PER_PLAYER).fill(-1), captures: 0, finishedAt: null,
  }));
  return { version: 1, ruleset: 'standard', status: 'playing', players, currentPlayer: 0, dice: null, consecutiveSixes: 0, awaitingMove: false, winner: null, turnNumber: 1, moveNumber: 0, history: [] };
}
function playerAt(state, playerId) { return state.players.findIndex((p) => p.id === playerId); }
function globalTrackIndex(playerId, progress) { if (progress < 0 || progress >= HOME_ENTRY_PROGRESS) return null; return (START_OFFSETS[playerId] + progress) % 52; }
function canMoveToken(state, playerIndex, tokenIndex, roll) {
  const player = state.players[playerIndex];
  if (!player || !Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= TOKENS_PER_PLAYER) return false;
  const progress = player.tokens[tokenIndex];
  if (progress === FINISH_PROGRESS) return false;
  if (progress === -1) return roll === 6;
  return progress + roll <= FINISH_PROGRESS;
}
function legalMoves(state, roll = state.dice) {
  if (state.status !== 'playing' || !Number.isInteger(roll) || roll < 1 || roll > 6) return [];
  const player = state.players[state.currentPlayer];
  return player.tokens.flatMap((_, tokenIndex) => canMoveToken(state, state.currentPlayer, tokenIndex, roll) ? [tokenIndex] : []);
}
function cloneState(state) { return structuredClone(state); }
function applyRoll(state, roll) {
  if (state.status !== 'playing') throw new Error('Game is not active');
  if (state.awaitingMove) throw new Error('A move is already pending');
  if (!Number.isInteger(roll) || roll < 1 || roll > 6) throw new Error('Invalid dice result');
  const next = cloneState(state);
  if (roll === 6) next.consecutiveSixes += 1; else next.consecutiveSixes = 0;
  const current = next.players[next.currentPlayer]; next.dice = roll;
  next.history.push({ type: 'roll', player: current.id, roll, turn: next.turnNumber });
  if (next.consecutiveSixes === 3) {
    next.history.push({ type: 'three-sixes-penalty', player: current.id, roll, turn: next.turnNumber });
    next.dice = null; next.awaitingMove = false; next.consecutiveSixes = 0; advanceTurn(next); return next;
  }
  const moves = legalMoves(next, roll);
  if (moves.length === 0) { if (roll !== 6) advanceTurn(next); else next.dice = null; }
  else next.awaitingMove = true;
  return next;
}
function advanceTurn(state) {
  state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
  state.turnNumber += 1; state.moveNumber += 1; state.dice = null; state.awaitingMove = false; state.consecutiveSixes = 0;
}
function applyMove(state, tokenIndex) {
  if (state.status !== 'playing' || !state.awaitingMove || !state.dice) throw new Error('No move is pending');
  if (!legalMoves(state).includes(tokenIndex)) throw new Error('Illegal token move');
  const next = cloneState(state); const player = next.players[next.currentPlayer];
  const oldProgress = player.tokens[tokenIndex]; const newProgress = oldProgress === -1 ? 0 : oldProgress + next.dice;
  player.tokens[tokenIndex] = newProgress; const captured = []; const landedTrack = globalTrackIndex(player.id, newProgress);
  if (landedTrack !== null && !SAFE_TRACK.has(landedTrack)) {
    for (const opponent of next.players) {
      if (opponent.id === player.id) continue;
      opponent.tokens.forEach((progress, index) => {
        if (progress >= 0 && progress < HOME_ENTRY_PROGRESS && globalTrackIndex(opponent.id, progress) === landedTrack) {
          opponent.tokens[index] = -1; player.captures += 1; captured.push({ player: opponent.id, token: index });
        }
      });
    }
  }
  const finished = newProgress === FINISH_PROGRESS;
  if (player.tokens.every((p) => p === FINISH_PROGRESS)) { player.finishedAt = next.turnNumber; next.status = 'finished'; next.winner = player.id; }
  next.history.push({ type: 'move', player: player.id, token: tokenIndex, from: oldProgress, to: newProgress, roll: next.dice, captured, finished, turn: next.turnNumber });
  const extraTurn = next.dice === 6 && next.status === 'playing'; next.dice = null; next.awaitingMove = false;
  if (!extraTurn) advanceTurn(next); else next.moveNumber += 1;
  return next;
}
function legalActions(state, roll = state.dice) { return legalMoves(state, roll).map((token) => ({ type: 'move', token })); }
function chooseAIMove(state, random = Math.random) {
  const player = state.players[state.currentPlayer]; const moves = legalMoves(state); if (!moves.length) return null;
  let best = moves[0], bestScore = -Infinity;
  for (const tokenIndex of moves) {
    const from = player.tokens[tokenIndex]; const to = from === -1 ? 0 : from + state.dice; let score = random() * 2;
    if (from === -1) score += 18; if (to === FINISH_PROGRESS) score += 100; if (to >= HOME_ENTRY_PROGRESS) score += 25;
    if (to >= 0 && to < HOME_ENTRY_PROGRESS) {
      const cell = globalTrackIndex(player.id, to); if (SAFE_TRACK.has(cell)) score += 8;
      for (const opponent of state.players.filter((p) => p.id !== player.id)) opponent.tokens.forEach((progress) => { if (progress >= 0 && progress < HOME_ENTRY_PROGRESS && globalTrackIndex(opponent.id, progress) === cell) score += 45; });
      for (const opponent of state.players.filter((p) => p.id !== player.id)) opponent.tokens.forEach((progress) => {
        if (progress >= 0 && progress < HOME_ENTRY_PROGRESS) { const distance = (globalTrackIndex(player.id, to) - globalTrackIndex(opponent.id, progress) + 52) % 52; if (distance > 0 && distance <= 6) score -= Math.max(0, 7 - distance) * 2; }
      });
    }
    score += to * 0.18; if (score > bestScore) { bestScore = score; best = tokenIndex; }
  }
  return best;
}
function tokenTrackCell(playerId, progress) { const index = globalTrackIndex(playerId, progress); return index === null ? null : index; }
const api = { PLAYER_IDS, START_OFFSETS, SAFE_TRACK, TRACK_COORDS, HOME_COORDS, TOKENS_PER_PLAYER, HOME_ENTRY_PROGRESS, FINISH_PROGRESS, initialState, playerAt, globalTrackIndex, canMoveToken, legalMoves, legalActions, applyRoll, applyMove, chooseAIMove, tokenTrackCell };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.LudoEngine = api;
