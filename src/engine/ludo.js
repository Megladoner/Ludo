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
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const AI_NAMES = ['Clover', 'Marlow', 'Atlas', 'Juniper', 'Basil', 'Wren', 'Sable', 'Rowan'];

function initialState(options = {}) {
  const players = (options.players || PLAYER_IDS).map((id) => ({
    id, name: options.names?.[id] || id[0].toUpperCase() + id.slice(1),
    kind: options.kinds?.[id] || 'human', difficulty: options.difficulties?.[id] || 'normal',
    tokens: Array(TOKENS_PER_PLAYER).fill(-1), captures: 0, finishedAt: null,
  }));
  return {
    version: 3, ruleset: 'standard', status: 'playing', players, currentPlayer: 0,
    dice: null, consecutiveSixes: 0, awaitingMove: false, winner: null,
    turnNumber: 1, moveNumber: 0, history: [],
    // Players who have brought all four tokens home, in the order they did it.
    finishOrder: [], lastFinish: null, bonusToken: null,
  };
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
/*
 * The roll belongs to a single token when the player has only one token in play.
 * With a lone token out on the board the dice are committed to it — there is no
 * choice to make, so the move is made for the player and nothing is ever asked.
 */
function legalMoves(state, roll = state.dice) {
  if (state.status !== 'playing' || !Number.isInteger(roll) || roll < 1 || roll > 6) return [];
  const player = state.players[state.currentPlayer];
  if (!player) return [];
  const committed = committedToken(player);
  return player.tokens.flatMap((_, tokenIndex) => {
    if (committed !== null && tokenIndex !== committed) return [];
    if (!canMoveToken(state, state.currentPlayer, tokenIndex, roll)) return [];
    // A bonus move belongs to one token only.
    if (state.bonusToken && state.bonusToken.player === player.id && state.bonusToken.token !== tokenIndex) return [];
    return [tokenIndex];
  });
}
function cloneState(state) { return structuredClone(state); }

// A player is done once every one of their tokens has reached home.
function isPlayerFinished(player) { return player.tokens.every((token) => token === FINISH_PROGRESS); }
function hasFinished(state, playerId) { return (state.finishOrder || []).indexOf(playerId) !== -1; }
function deployedCount(player) { return player.tokens.filter((token) => token >= 0).length; }
// Tokens still in play: out on the board or in the home lane, but not yet home.
function inPlayCount(player) { return player.tokens.filter((token) => token >= 0 && token < FINISH_PROGRESS).length; }
// The token a roll is committed to: the only one still in play, if there is only one.
function committedToken(player) {
  const live = player.tokens.map((token, index) => ({ token, index })).filter((entry) => entry.token >= 0 && entry.token < FINISH_PROGRESS);
  return live.length === 1 ? live[0].index : null;
}

// Removing a player (they left the table) forfeits their tokens and hands the turn on safely.
function removePlayer(state, playerId) {
  const index = state.players.findIndex((p) => p.id === playerId);
  if (index < 0) return state;
  const wasCurrent = state.currentPlayer === index;
  const wasLast = index === state.players.length - 1;
  state.players.splice(index, 1);
  state.finishOrder = (state.finishOrder || []).filter((id) => id !== playerId);
  if (!state.players.length) { state.currentPlayer = 0; state.awaitingMove = false; state.dice = null; return state; }
  if (wasCurrent) {
    state.currentPlayer = wasLast ? 0 : Math.min(index, state.players.length - 1);
    state.awaitingMove = false;
    state.dice = null;
  } else if (state.currentPlayer > index) {
    state.currentPlayer -= 1;
  }
  return state;
}

/*
 * Ending the table.
 * - Two players: the first to bring all four tokens home wins, as always.
 * - Three or four players: the game plays on so the rest of the table can finish too.
 *   The first player home is still the champion; the others are ranked by finishing order.
 */
function checkGameEnd(state) {
  const total = state.players.length;
  const finished = (state.finishOrder || []).length;
  const done = total <= 2 ? finished >= 1 : finished >= total;
  if (!done) return false;
  state.status = 'finished';
  state.winner = state.finishOrder[0] || null;
  return true;
}

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
    next.dice = null; next.awaitingMove = false; next.consecutiveSixes = 0; next.bonusToken = null;
    advanceTurn(next); return next;
  }
  const moves = legalMoves(next, roll);
  if (moves.length === 0) {
    // A six with nothing to move does not grant another turn — the turn passes, as on a real board.
    next.history.push({ type: 'no-move', player: current.id, roll, turn: next.turnNumber });
    next.dice = null; next.awaitingMove = false; next.bonusToken = null;
    advanceTurn(next); return next;
  }
  next.awaitingMove = true;
  next.bonusToken = null;
  return next;
}

// Hands the turn to the next player who still has tokens on the board.
function advanceTurn(state) {
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const index = (state.currentPlayer + step) % count;
    if (!hasFinished(state, state.players[index].id)) {
      state.currentPlayer = index;
      state.turnNumber += 1; state.moveNumber += 1;
      state.dice = null; state.awaitingMove = false; state.consecutiveSixes = 0;
      state.bonusToken = null;
      return;
    }
  }
  // Everybody left the board.
  state.status = 'finished';
  state.winner = (state.finishOrder || [])[0] || null;
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
  // Reaching the home lane is worth a bonus roll for the token that got there.
  const enteredHome = oldProgress < HOME_ENTRY_PROGRESS && newProgress >= HOME_ENTRY_PROGRESS;
  // The home triangle is the centre square: landing on it is the final step home.
  const finishedToken = newProgress === FINISH_PROGRESS;
  const completedPlayer = isPlayerFinished(player);
  if (completedPlayer && (next.finishOrder || []).indexOf(player.id) === -1) {
    next.finishOrder = next.finishOrder || [];
    next.finishOrder.push(player.id);
    player.finishedAt = next.turnNumber;
    next.lastFinish = player.id;
  }
  next.history.push({
    type: 'move', player: player.id, token: tokenIndex, from: oldProgress, to: newProgress,
    roll: next.dice, captured, finished: finishedToken, enteredHome, completedPlayer, turn: next.turnNumber,
  });
  // A six, a capture, or a token reaching the home triangle earns the player one
  // more move. The home lane itself grants nothing — the token simply walks home.
  const rollUsed = next.dice;
  const earnsBonus = !completedPlayer && (rollUsed === 6 || captured.length > 0 || finishedToken);
  next.dice = null; next.awaitingMove = false; next.bonusToken = null;
  if (checkGameEnd(next)) return next;
  if (earnsBonus) { next.moveNumber += 1; return next; }
  advanceTurn(next);
  return next;
}
function legalActions(state, roll = state.dice) { return legalMoves(state, roll).map((token) => ({ type: 'move', token })); }
function tokenTrackCell(playerId, progress) { const index = globalTrackIndex(playerId, progress); return index === null ? null : index; }
function homeCount(player) { return player.tokens.filter((t) => t === FINISH_PROGRESS).length; }
function tokenProgress(player) { return player.tokens.reduce((sum, t) => sum + (t < 0 ? 0 : t), 0); }
// Ranking for the results screen: players who finished come first, in finishing order.
function standings(state) {
  const order = state.finishOrder || [];
  return state.players
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, home: homeCount(p), progress: tokenProgress(p), captures: p.captures, finished: hasFinished(state, p.id) }))
    .sort((a, b) => {
      const aRank = order.indexOf(a.id); const bRank = order.indexOf(b.id);
      if (aRank !== bRank) {
        if (aRank === -1) return 1;
        if (bRank === -1) return -1;
        return aRank - bRank;
      }
      return b.home - a.home || b.progress - a.progress || b.captures - a.captures || a.name.localeCompare(b.name);
    });
}
function dangerScore(state, playerId, cell, limit = 6) {
  // How exposed is `cell` to opponents rolling soon? Higher means safer.
  let danger = 0;
  for (const opponent of state.players) {
    if (opponent.id === playerId) continue;
    for (const progress of opponent.tokens) {
      if (progress < 0 || progress >= HOME_ENTRY_PROGRESS) continue;
      const distance = (cell - globalTrackIndex(opponent.id, progress) + 52) % 52;
      if (distance > 0 && distance <= limit) danger += (limit - distance + 1) * 2;
    }
  }
  return danger;
}
function chooseAIMove(state, random = Math.random, difficulty = 'normal') {
  const player = state.players[state.currentPlayer]; const moves = legalMoves(state); if (!moves.length) return null;
  const tier = DIFFICULTIES.includes(difficulty) ? difficulty : 'normal';
  let best = moves[0], bestScore = -Infinity;
  for (const tokenIndex of moves) {
    const from = player.tokens[tokenIndex]; const to = from === -1 ? 0 : from + state.dice;
    let score;
    if (tier === 'easy') {
      // Mostly reactive: it releases tokens and nudges them home, but does not plan captures.
      score = random() * 12 + to * 0.05;
      if (from === -1) score += 6;
      if (to === FINISH_PROGRESS) score += 10;
    } else {
      score = random() * 2;
      if (from === -1) score += 18;
      if (to === FINISH_PROGRESS) score += 100;
      if (to >= HOME_ENTRY_PROGRESS) score += 25;
      if (to >= 0 && to < HOME_ENTRY_PROGRESS) {
        const cell = globalTrackIndex(player.id, to);
        if (SAFE_TRACK.has(cell)) score += 8;
        for (const opponent of state.players.filter((p) => p.id !== player.id)) {
          opponent.tokens.forEach((progress) => {
            if (progress >= 0 && progress < HOME_ENTRY_PROGRESS && globalTrackIndex(opponent.id, progress) === cell) score += 45;
          });
        }
      }
      score += to * 0.18;
      if (tier === 'hard') {
        const cell = to >= 0 && to < HOME_ENTRY_PROGRESS ? globalTrackIndex(player.id, to) : null;
        if (cell !== null) score -= dangerScore(state, player.id, cell) * 2.4;
      }
    }
    if (score > bestScore) { bestScore = score; best = tokenIndex; }
  }
  return best;
}
/*
 * Auto-play. The table never asks a question it does not have to ask:
 * - one token in play  -> the roll belongs to that token, and it moves by itself;
 * - nothing in play    -> a six releases a token, and the first one out is taken;
 * - two or more in play -> the player chooses, unless only one move is legal.
 */
function autoMoveToken(state) {
  if (state.status !== 'playing' || !state.awaitingMove) return null;
  const player = state.players[state.currentPlayer];
  if (!player) return null;
  const moves = legalMoves(state);
  if (!moves.length) return null;
  const committed = committedToken(player);
  if (committed !== null) return moves.includes(committed) ? committed : null;
  if (inPlayCount(player) === 0 && state.dice === 6) {
    // Nothing on the board yet: bring a token out rather than making the player choose.
    const release = player.tokens.findIndex((token) => token === -1);
    return release === -1 ? null : release;
  }
  if (moves.length === 1) return moves[0];
  return null;
}
function pickAiNames(count, taken = []) {
  const pool = AI_NAMES.filter((n) => !taken.includes(n));
  const names = [];
  for (let i = 0; i < count; i++) names.push(pool[i % pool.length] + (i >= pool.length ? ' ' + (Math.floor(i / pool.length) + 1) : ''));
  return names;
}
const api = {
  PLAYER_IDS, START_OFFSETS, SAFE_TRACK, TRACK_COORDS, HOME_COORDS, TOKENS_PER_PLAYER,
  HOME_ENTRY_PROGRESS, FINISH_PROGRESS, DIFFICULTIES, AI_NAMES,
  initialState, playerAt, globalTrackIndex, canMoveToken, legalMoves, legalActions,
  applyRoll, applyMove, chooseAIMove, tokenTrackCell, homeCount, tokenProgress,
  standings, dangerScore, pickAiNames, removePlayer, autoMoveToken,
  isPlayerFinished, hasFinished, deployedCount, inPlayCount, committedToken, checkGameEnd,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.LudoEngine = api;
