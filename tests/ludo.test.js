'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine/ludo');
function pending(state, playerIndex=0, roll=1) { state.currentPlayer=playerIndex; state.dice=roll; state.awaitingMove=true; return state; }
test('initial state has four players and sixteen tokens in base',()=>{ const s=E.initialState(); assert.equal(s.players.length,4); assert.equal(s.players.reduce((n,p)=>n+p.tokens.filter(x=>x===-1).length,0),16); assert.equal(s.currentPlayer,0); });
test('a six releases a token and grants another roll after moving',()=>{ let s=E.initialState();s=E.applyRoll(s,6);assert.deepEqual(E.legalMoves(s),[0,1,2,3]);s=E.applyMove(s,0);assert.equal(s.players[0].tokens[0],0);assert.equal(s.currentPlayer,0);assert.equal(s.dice,null); });
test('a non-six with no legal moves passes the turn',()=>{ const s=E.applyRoll(E.initialState(),3);assert.equal(s.currentPlayer,1);assert.equal(s.awaitingMove,false);assert.equal(s.dice,null); });
test('three consecutive sixes cause a turn penalty',()=>{ const s=E.initialState();s.consecutiveSixes=2;const n=E.applyRoll(s,6);assert.equal(n.currentPlayer,1);assert.equal(n.consecutiveSixes,0);assert.ok(n.history.some(x=>x.type==='three-sixes-penalty')); });
test('exact roll is required to finish',()=>{ let s=E.initialState();s.players[0].tokens[0]=56;s=pending(s,0,2);assert.deepEqual(E.legalMoves(s),[]);s=pending(s,0,1);assert.deepEqual(E.legalMoves(s),[0]);const n=E.applyMove(s,0);assert.equal(n.players[0].tokens[0],57); });
test('finishing the fourth token wins the game',()=>{ let s=E.initialState();s.players[0].tokens=[57,57,57,56];s=pending(s,0,1);const n=E.applyMove(s,3);assert.equal(n.status,'finished');assert.equal(n.winner,'red'); });
test('an opponent is captured on a non-safe square',()=>{ let s=E.initialState();s.players[0].tokens[0]=0;s.players[1].tokens[0]=40;s=pending(s,0,1);const n=E.applyMove(s,0);assert.equal(n.players[1].tokens[0],-1);assert.equal(n.players[0].captures,1); });
test('safe squares prevent captures',()=>{ let s=E.initialState();s.players[0].tokens[0]=3;s.players[1].tokens[0]=43;s=pending(s,0,1);const n=E.applyMove(s,0);assert.equal(n.players[1].tokens[0],43);assert.equal(n.players[0].captures,0); });
test('movement wraps around the 52-square track',()=>{ assert.equal(E.globalTrackIndex('red',4),0);assert.equal(E.globalTrackIndex('green',43),0); });
test('two-player games are supported by the pure engine',()=>{ const s=E.initialState({players:['red','yellow']});assert.equal(s.players.length,2);const n=E.applyRoll(s,2);assert.equal(n.currentPlayer,1); });
test('illegal actions are rejected',()=>{ const s=E.initialState();assert.throws(()=>E.applyMove(s,0),/No move is pending/);assert.throws(()=>E.applyRoll(s,7),/Invalid dice/); });
test('each player enters their own home lane from the final shared-track cell',()=>{ const entries={red:46,green:7,yellow:20,blue:33};for(const [player,cell] of Object.entries(entries)){assert.equal(E.globalTrackIndex(player,50),cell);assert.equal(E.globalTrackIndex(player,51),null);} });
test('AI returns a legal token action for the current state',()=>{ let s=E.applyRoll(E.initialState(),6);const token=E.chooseAIMove(s,()=>0.25);assert.ok(E.legalMoves(s).includes(token));const next=E.applyMove(s,token);assert.equal(next.players[0].tokens[token],0); });
test('canonical board coordinates align with each home-lane entry',()=>{ const entries={red:46,green:7,yellow:20,blue:33};assert.equal(E.TRACK_COORDS.length,52);for(const [player,index] of Object.entries(entries)){const [x,y]=E.TRACK_COORDS[index];const [hx,hy]=E.HOME_COORDS[player][0];assert.equal(Math.abs(x-hx)+Math.abs(y-hy),1);} });
