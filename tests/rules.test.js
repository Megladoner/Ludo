'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine/ludo');
const { inviteCode, normalizeInvite, CODE_ALPHABET } = require('../src/server/rooms');

function pending(state, playerIndex = 0, roll = 1) {
  state.currentPlayer = playerIndex; state.dice = roll; state.awaitingMove = true; return state;
}

// --- Bonus turns ------------------------------------------------------------

test('a capture earns the captor another roll', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [0, -1, -1, -1];
  state.players[1].tokens = [40, -1, -1, -1];
  // Red at 0 lands on green at 40's cell with a roll of 1.
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[1].tokens[0], -1, 'green was captured');
  assert.equal(next.currentPlayer, 0, 'red keeps the turn after a capture');
  assert.equal(next.dice, null);
  assert.equal(next.awaitingMove, false, 'red rolls again rather than moving again');
});

test('a capture by the second player also keeps their turn', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  // Green at 39 steps onto cell 1, where red is waiting.
  state.players[0].tokens = [1, -1, -1, -1];
  state.players[1].tokens = [39, -1, -1, -1];
  state = pending(state, 1, 1);
  assert.equal(E.globalTrackIndex('green', 40), E.globalTrackIndex('red', 1));
  const next = E.applyMove(state, 0);
  assert.equal(next.players[0].tokens[0], -1);
  assert.equal(next.currentPlayer, 1, 'green keeps the turn after capturing red');
});

test('entering the home lane is just a walk — no jump, no bonus', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [50, -1, -1, -1];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[0].tokens[0], 51, 'the token has entered the home lane');
  assert.equal(next.currentPlayer, 1, 'the turn passes as usual');
  assert.equal(next.awaitingMove, false, 'no extra move is pending');
  assert.equal(next.dice, null, 'no die is carried over');
});

test('the home lane never moves a token further than the die says', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [45, -1, -1, -1];
  state = pending(state, 0, 6);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[0].tokens[0], 51, 'the token stops at the lane entry');
  assert.notEqual(next.players[0].tokens[0], 57, 'it does not leap to the centre');
  assert.equal(next.awaitingMove, false);
});

test('a token in the lane walks on one square at a time', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [51, -1, -1, -1];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[0].tokens[0], 52);
  assert.equal(next.currentPlayer, 1);
});

test('reaching the home triangle earns one more move', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [56, 10, -1, -1];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[0].tokens[0], 57, 'the token reached the centre');
  assert.equal(next.currentPlayer, 0, 'the player keeps the table for another move');
  assert.equal(next.awaitingMove, false, 'and rolls again for it');
  assert.equal(next.history.at(-1).finished, true);
});

test('the extra move at the triangle does not apply to the final token', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [57, 57, 57, 56];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 3);
  assert.equal(next.players[0].tokens[3], 57, 'every token is home');
  assert.equal(next.status, 'finished', 'the table is done');
  assert.equal(next.winner, 'red');
});

test('a capture on the way home still earns the extra roll', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [0, -1, -1, -1];
  state.players[1].tokens = [40, -1, -1, -1];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 0);
  assert.equal(next.players[1].tokens[0], -1, 'green was captured');
  assert.equal(next.currentPlayer, 0, 'red keeps the table');
});

test('an ordinary move passes the turn', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, -1, -1, -1];
  state = pending(state, 0, 2);
  const next = E.applyMove(state, 0);
  assert.equal(next.currentPlayer, 1);
  assert.equal(next.bonusToken, null);
});

test('a six still earns another roll', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, -1, -1, -1];
  state = pending(state, 0, 6);
  const next = E.applyMove(state, 0);
  assert.equal(next.currentPlayer, 0);
});

// --- Finishing and the long game -------------------------------------------

test('finishing a player takes them out of the rotation', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow'] });
  state.players[0].tokens = [57, 57, 57, 56];
  state = pending(state, 0, 1);
  const next = E.applyMove(state, 3);
  assert.deepEqual(next.finishOrder, ['red']);
  assert.equal(next.status, 'playing');
  assert.equal(next.lastFinish, 'red');
  assert.equal(next.currentPlayer, 1);
  // Red is skipped on the following rotation.
  const afterGreen = E.applyRoll(next, 1);
  assert.equal(afterGreen.currentPlayer, 2, 'the finished player is skipped');
});

test('a three-player game ends when everybody has finished', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow'] });
  state.players[0].tokens = [57, 57, 57, 56];
  state.players[1].tokens = [57, 57, 57, 56];
  state.players[2].tokens = [57, 57, 57, 56];
  state = pending(state, 0, 1);
  let next = E.applyMove(state, 3);
  assert.equal(next.status, 'playing');
  next = pending(next, 1, 1);
  next = E.applyMove(next, 3);
  assert.equal(next.status, 'playing');
  next = pending(next, 2, 1);
  next = E.applyMove(next, 3);
  assert.equal(next.status, 'finished');
  assert.equal(next.winner, 'red', 'the first player home is the champion');
  assert.deepEqual(next.finishOrder, ['red', 'green', 'yellow']);
});

test('standings rank finishers first, in finishing order', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow'] });
  state.finishOrder = ['green', 'red'];
  state.players[0].tokens = [57, 57, 57, 57];
  state.players[1].tokens = [57, 57, 57, 57];
  state.players[2].tokens = [57, 57, 30, -1];
  const table = E.standings(state);
  assert.deepEqual(table.map((entry) => entry.id), ['green', 'red', 'yellow']);
  assert.equal(table[0].finished, true);
  assert.equal(table[2].finished, false);
});

test('a finished player is skipped when the turn cycles', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow', 'blue'] });
  state.finishOrder = ['red', 'blue'];
  state.currentPlayer = 1;
  state = E.applyRoll(state, 3); // green cannot move, so the turn passes
  assert.equal(state.currentPlayer, 2, 'red and blue are skipped');
  state = E.applyRoll(state, 3);
  assert.equal(state.currentPlayer, 1, 'the rotation wraps around the finished players');
});

// --- Auto play --------------------------------------------------------------

test('a single token in play is played automatically', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, -1, -1, -1];
  state = pending(state, 0, 3);
  assert.equal(E.autoMoveToken(state), 0, 'the only token moves itself');
});

test('a single token in play takes the roll even on a six', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, -1, -1, -1];
  state = pending(state, 0, 6);
  assert.equal(E.autoMoveToken(state), 0, 'the committed token moves, not a new one');
  assert.deepEqual(E.legalMoves(state), [0], 'nothing else may move');
});

test('a single token that cannot take the roll ends the turn', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [56, -1, -1, -1];
  assert.deepEqual(E.legalMoves(state, 5), [], 'the roll cannot be taken');
  const next = E.applyRoll(state, 5);
  assert.equal(next.awaitingMove, false);
  assert.equal(next.currentPlayer, 1, 'the turn passes');
  assert.equal(next.history.at(-1).type, 'no-move');
});

test('a six with nothing on the board brings a token out by itself', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [-1, -1, -1, -1];
  state = pending(state, 0, 6);
  assert.equal(E.autoMoveToken(state), 0, 'a token is released without asking');
});

test('auto play does not fire when several tokens are on the board', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, 12, -1, -1];
  state = pending(state, 0, 1);
  assert.equal(E.autoMoveToken(state), null);
  assert.equal(E.legalMoves(state).length, 2);
});

test('auto play fires when several tokens are out but only one can move', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [10, 56, -1, -1];
  state = pending(state, 0, 2);
  assert.deepEqual(E.legalMoves(state), [0], 'the token at 56 cannot take a two');
  assert.equal(E.autoMoveToken(state), 0);
});

test('tokens that are already home do not count as in play', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.players[0].tokens = [57, 57, 57, 10];
  assert.equal(E.inPlayCount(state.players[0]), 1);
  assert.equal(E.committedToken(state.players[0]), 3);
  state = pending(state, 0, 6);
  assert.equal(E.autoMoveToken(state), 3, 'the last token out moves, not a new one');
});

test('auto play is silent when no move is pending', () => {
  const state = E.initialState();
  assert.equal(E.autoMoveToken(state), null);
});

test('deployed tokens are counted correctly', () => {
  let state = E.initialState();
  state.players[0].tokens = [-1, 5, 57, -1];
  assert.equal(E.deployedCount(state.players[0]), 2);
  assert.equal(E.inPlayCount(state.players[0]), 1, 'a token that is home is not in play');
});

// --- Forfeits ---------------------------------------------------------------

test('removing the player on turn hands the turn on safely', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow'] });
  state.currentPlayer = 1;
  state.dice = 4; state.awaitingMove = true;
  const next = E.removePlayer(state, 'green');
  assert.equal(next.players.length, 2);
  assert.equal(next.currentPlayer, 1, 'the player after them takes over');
  assert.equal(next.awaitingMove, false, 'a pending move does not carry over');
  assert.equal(next.dice, null);
});

test('removing the last player on turn wraps the turn back to the start', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.currentPlayer = 1;
  const next = E.removePlayer(state, 'green');
  assert.equal(next.players.length, 1);
  assert.equal(next.currentPlayer, 0);
});

test('removing a player before the turn keeps the turn index correct', () => {
  let state = E.initialState({ players: ['red', 'green', 'yellow'] });
  state.currentPlayer = 2;
  const next = E.removePlayer(state, 'green');
  assert.equal(next.currentPlayer, 1, 'the index shifts down with the roster');
  assert.equal(next.players.map((p) => p.id).join(','), 'red,yellow');
});

test('removing a finished player drops them from the finishing order', () => {
  let state = E.initialState({ players: ['red', 'green'] });
  state.finishOrder = ['red'];
  const next = E.removePlayer(state, 'red');
  assert.deepEqual(next.finishOrder, []);
});

test('removing an unknown player changes nothing', () => {
  const state = E.initialState();
  const next = E.removePlayer(state, 'purple');
  assert.equal(next.players.length, 4);
  assert.equal(next.currentPlayer, 0);
});

// --- Standings --------------------------------------------------------------

test('standings rank by tokens home, then distance, then captures', () => {
  let state = E.initialState();
  state.players[0].tokens = [57, 57, 40, -1];
  state.players[1].tokens = [57, 30, 20, -1];
  state.players[2].tokens = [57, 57, 57, 57];
  state.players[3].tokens = [-1, -1, -1, -1];
  state.players[1].captures = 3;
  const table = E.standings(state);
  assert.equal(table[0].id, 'yellow');
  assert.equal(table[1].id, 'red');
  assert.equal(table[2].id, 'green');
  assert.equal(table[3].id, 'blue');
  assert.equal(table[2].captures, 3);
});

test('home counts use the finish progress value', () => {
  const state = E.initialState();
  state.players[0].tokens = [E.FINISH_PROGRESS, E.FINISH_PROGRESS, 10, -1];
  assert.equal(E.homeCount(state.players[0]), 2);
  assert.equal(E.standings(state)[0].home, 2);
});

// --- AI ---------------------------------------------------------------------

test('the AI always returns a legal move at every difficulty', () => {
  for (const difficulty of E.DIFFICULTIES) {
    let state = E.applyRoll(E.initialState(), 6);
    const choice = E.chooseAIMove(state, () => 0.25, difficulty);
    assert.ok(E.legalMoves(state).includes(choice), `difficulty ${difficulty}`);
    const next = E.applyMove(state, choice);
    assert.equal(next.players[0].tokens[choice], 0);
  }
});

test('a harder table takes the capture while a relaxed table plays it safe', () => {
  let state = E.initialState();
  state.players[0].tokens = [10, 45, -1, -1];
  state.players[1].tokens = [50, -1, -1, -1];
  state.currentPlayer = 0; state.dice = 1; state.awaitingMove = true;
  assert.equal(E.globalTrackIndex('red', 11), E.globalTrackIndex('green', 50));
  const hard = E.chooseAIMove(state, () => 0.99, 'hard');
  const easy = E.chooseAIMove(state, () => 0.99, 'easy');
  assert.equal(hard, 0, 'the ruthless table takes the capture');
  assert.notEqual(easy, 0, 'the relaxed table is happy to shuffle along');
  assert.ok(E.legalMoves(state).includes(easy));
});

test('the AI names are unique and plentiful', () => {
  const names = E.pickAiNames(4);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4);
});

// --- Invitation codes -------------------------------------------------------

test('invitation codes use an alphabet without look-alike characters', () => {
  for (let i = 0; i < 200; i++) {
    const code = inviteCode(8);
    assert.equal(code.length, 8);
    assert.equal(/^[A-HJ-KM-NP-Z2-9]+$/.test(code), true, `unexpected code ${code}`);
    assert.equal(/[IL01]/.test(code), false);
  }
});

test('invitation codes are normalised for forgiving entry', () => {
  assert.equal(normalizeInvite('abcd-2345'), 'ABCD2345');
  assert.equal(normalizeInvite('  abcd 2345 '), 'ABCD2345');
  assert.equal(normalizeInvite('ABCD/2345'), 'ABCD2345');
  assert.equal(normalizeInvite(''), '');
  assert.equal(normalizeInvite(null), '');
});

test('every alphabet character survives normalisation', () => {
  for (const character of CODE_ALPHABET) {
    assert.equal(normalizeInvite(character), character);
  }
});
