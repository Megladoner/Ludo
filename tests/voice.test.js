'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVoiceSignal, KINDS, MAX_DATA_BYTES } = require('../src/voice/protocol');
const ICE = require('../src/voice/ice');
const Voice = require('../public/voice.js');

const { initiatorFor, normalizeIce, isSpeaking, SEAT_ORDER, SPEAKING_RMS } = Voice;

// --- Who opens the line -----------------------------------------------------

test('exactly one side of every pair opens the line', () => {
  const seats = SEAT_ORDER;
  for (const a of seats) {
    for (const b of seats) {
      if (a === b) continue;
      assert.equal(initiatorFor(a, b), initiatorFor(b, a), a + ' and ' + b + ' must agree');
      assert.ok([a, b].includes(initiatorFor(a, b)));
    }
  }
});

test('the initiator is decided once and does not flip', () => {
  assert.equal(initiatorFor('red', 'green'), 'red');
  assert.equal(initiatorFor('green', 'red'), 'red');
  assert.equal(initiatorFor('yellow', 'blue'), 'yellow');
  // An unknown seat never wins the right to offer.
  assert.equal(initiatorFor('plum', 'green'), 'green');
  assert.equal(initiatorFor('red', 'plum'), 'red');
});

// --- The ICE configuration ---------------------------------------------------

test('only real STUN and TURN servers survive', () => {
  const clean = normalizeIce({
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'https://example.com/x'], username: 'u', credential: 'c' },
      { urls: ['https://example.com/not-ice'] },
      { urls: [] },
      null,
    ],
  });
  assert.equal(clean.length, 2);
  assert.deepEqual(clean[0].urls, ['stun:stun.cloudflare.com:3478']);
  assert.deepEqual(clean[1].urls, ['turn:turn.cloudflare.com:3478?transport=udp']);
  assert.equal(clean[1].username, 'u');
  assert.equal(clean[1].credential, 'c');
});

test('a broken configuration leaves the browser with nothing to complain about', () => {
  assert.deepEqual(normalizeIce(null), []);
  assert.deepEqual(normalizeIce({}), []);
  assert.deepEqual(normalizeIce({ iceServers: 'nope' }), []);
});

// --- Speaking ---------------------------------------------------------------

test('speech is counted above a threshold and quiet is not', () => {
  assert.equal(isSpeaking(0.5), true);
  assert.equal(isSpeaking(SPEAKING_RMS + 0.01), true);
  assert.equal(isSpeaking(SPEAKING_RMS - 0.01), false);
  assert.equal(isSpeaking(0), false);
  assert.equal(isSpeaking(NaN), false);
});

// --- The signalling vocabulary ----------------------------------------------

test('a broadcast needs no seat and a targeted message needs one', () => {
  const seats = ['red', 'green'];
  const hello = parseVoiceSignal({ kind: 'hello' }, seats);
  assert.equal(hello.kind, 'hello');
  assert.equal(hello.to, null);
  const offer = parseVoiceSignal({ kind: 'offer', to: 'green', data: { sdp: 'x' } }, seats);
  assert.equal(offer.to, 'green');
});

test('a signal for a seat that is not at the table is refused', () => {
  assert.throws(() => parseVoiceSignal({ kind: 'offer', to: 'yellow' }, ['red', 'green']), /not at this table/);
  assert.throws(() => parseVoiceSignal({ kind: 'offer' }, ['red', 'green']), /not at this table/);
});

test('an unknown kind is refused', () => {
  assert.throws(() => parseVoiceSignal({ kind: 'shout' }, ['red']), /Unknown voice message/);
  assert.throws(() => parseVoiceSignal({}, ['red']), /Unknown voice message/);
  assert.throws(() => parseVoiceSignal(null, ['red']), /Invalid voice message/);
});

test('a handshake that is far too large is refused', () => {
  const huge = { kind: 'ice', to: 'green', data: { candidate: 'x'.repeat(MAX_DATA_BYTES + 100) } };
  assert.throws(() => parseVoiceSignal(huge, ['red', 'green']), /too large/);
});

test('every kind in the vocabulary is a known kind', () => {
  for (const kind of ['hello', 'here', 'offer', 'answer', 'ice', 'bye']) assert.ok(KINDS.has(kind), kind);
});

// --- The relay ---------------------------------------------------------------

test('without a TURN key the table gets a free STUN server', async () => {
  const config = await ICE.iceServers({});
  assert.equal(config.relay, false);
  assert.equal(config.iceServers.length, 1);
  assert.match(config.iceServers[0].urls[0], /^stun:/);
});

test('with a TURN key the table gets a relay as well', async () => {
  const original = global.fetch;
  let called = null;
  global.fetch = async (url, options) => {
    called = { url, options };
    return { ok: true, status: 200, json: async () => ({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }) };
  };
  try {
    const config = await ICE.iceServers({ TURN_KEY_ID: 'key-123', TURN_API_TOKEN: 'token-abc' });
    assert.equal(config.relay, true);
    assert.equal(config.iceServers.length, 2);
    assert.match(config.iceServers[0].urls[0], /^stun:/);
    assert.match(config.iceServers[1].urls[0], /^turn:/);
    assert.ok(called.url.includes('key-123'));
    assert.equal(called.options.headers.authorization, 'Bearer token-abc');
    assert.ok(JSON.parse(called.options.body).ttl <= 48 * 60 * 60, 'the credential must live less than 48 hours');
  } finally {
    global.fetch = original;
  }
});

test('a TURN key that does not work must not take the voice down', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const config = await ICE.iceServers({ TURN_KEY_ID: 'key-broken', TURN_API_TOKEN: 'token-abc' });
    assert.equal(config.relay, false);
    assert.equal(config.iceServers.length, 1);
    assert.match(config.iceServers[0].urls[0], /^stun:/);
  } finally {
    global.fetch = original;
  }
});
