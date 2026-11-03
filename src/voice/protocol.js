'use strict';

/*
 * Voice chat — the signalling vocabulary shared by the browser and the server.
 *
 * The server never sees or touches the audio. It only carries the small
 * handshake messages that let two browsers agree how to open a direct line.
 *
 *   hello  — broadcast: "I have joined voice, who else is here?"
 *   here   — targeted:  "I am in voice too."
 *   offer  — targeted:  a WebRTC offer for one pair of players
 *   answer — targeted:  the reply to that offer
 *   ice    — targeted:  one network candidate for that pair
 *   state  — targeted:  "I have muted my microphone"
 *   bye    — broadcast: "I have left voice."
 */

const BROADCAST_KINDS = new Set(['hello', 'bye']);
const TARGETED_KINDS = new Set(['here', 'offer', 'answer', 'ice', 'state']);
const KINDS = new Set([...BROADCAST_KINDS, ...TARGETED_KINDS]);
// An SDP offer is a few kilobytes; anything much larger is not a handshake.
const MAX_DATA_BYTES = 8192;

/**
 * Validate an incoming voice signal.
 * `seats` is the list of seat colours currently at the table.
 * Returns { kind, to, data } or throws.
 */
function parseVoiceSignal(msg, seats) {
  if (!msg || typeof msg !== 'object') throw new Error('Invalid voice message');
  const kind = String(msg.kind || '');
  if (!KINDS.has(kind)) throw new Error('Unknown voice message');
  const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
  let size = 0;
  try { size = JSON.stringify(data).length; } catch { throw new Error('Invalid voice message'); }
  if (size > MAX_DATA_BYTES) throw new Error('Voice message is too large');
  if (BROADCAST_KINDS.has(kind)) return { kind, to: null, data };
  const to = String(msg.to || '');
  if (!seats.includes(to)) throw new Error('That seat is not at this table');
  return { kind, to, data };
}

const api = { BROADCAST_KINDS, TARGETED_KINDS, KINDS, MAX_DATA_BYTES, parseVoiceSignal };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ParcheesiVoiceProtocol = api;
