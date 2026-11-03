'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine/ludo');
const { inviteCode, normalizeInvite, CODE_ALPHABET } = require('../src/server/rooms');

// --- Rules ------------------------------------------------------------------

test('a six with no legal move ends the turn instead of granting another roll', () => {
  const state = E.initialState();
  // Put every token where a six cannot move it: one short of home and the rest finished.
  state.players[0].tokens = [56, 57, 57, 57];
  const next = E.applyRoll(state, 6);
  assert.equal(next.awaitingMove, false);
  assert.equal(next.dice, null);
  assert.equal(next.currentPlayer, 1, 'the turn passes to the next player');
  assert.ok(next.history.some((entry) => entry.type === 'no-move'));
});

test('a six that can release a token still waits for a move', () => {
  const state = E.applyRoll(E.initialState(), 6);
  assert.equal(state.awaitingMove, true);
  assert.deepEqual(E.legalMoves(state), [0, 1, 2, 3]);
});

test('the winner keeps the turn when the game ends', () => {
  let state = E.initialState();
  state.players[0].tokens = [57, 57, 57, 56];
  state.currentPlayer = 0; state.dice = 1; state.awaitingMove = true;
  const next = E.applyMove(state, 3);
  assert.equal(next.status, 'finished');
  assert.equal(next.winner, 'red');
  assert.equal(next.currentPlayer, 0, 'the finished turn is not handed on');
});

test('a six after the game is over is rejected', () => {
  let state = E.initialState();
  state.players[0].tokens = [57, 57, 57, 56];
  state.currentPlayer = 0; state.dice = 1; state.awaitingMove = true;
  const finished = E.applyMove(state, 3);
  assert.throws(() => E.applyRoll(finished, 6), /Game is not active/);
});

// --- Removing a player ------------------------------------------------------

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
  // Red token 0 is one step behind green token 0 on the shared track.
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

test('the ruthless table steers away from tokens an opponent is about to reach', () => {
  let state = E.initialState();
  state.players[0].tokens = [10, 11, -1, -1];
  state.players[1].tokens = [40, -1, -1, -1];
  state.currentPlayer = 0; state.dice = 1; state.awaitingMove = true;
  const hard = E.chooseAIMove(state, () => 0.5, 'hard');
  assert.ok(E.legalMoves(state).includes(hard));
  const cell = E.globalTrackIndex('red', 11);
  assert.ok(!E.SAFE_TRACK.has(cell));
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
