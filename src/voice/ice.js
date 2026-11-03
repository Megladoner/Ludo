'use strict';

/*
 * Voice chat — shared ICE configuration.
 *
 * The browser talks to other players directly (WebRTC, peer to peer). The only
 * piece that can cost money is the TURN relay that rescues connections behind
 * awkward NATs, and Cloudflare's own managed TURN carries a free tier of
 * 1,000 GB a month — roughly 71,000 relayed hours of voice, which a casual
 * table will never reach. STUN is free and unlimited.
 *
 * Without a TURN key the table still works for almost everyone: the browser
 * connects directly over STUN. The key only matters for players on strict
 * mobile or corporate networks, and it is set as a Worker secret so it never
 * reaches the browser.
 */

const STUN_URL = 'stun:stun.cloudflare.com:3478';
const TURN_CREDENTIALS_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';
// Cloudflare caps a TURN credential at 48 hours. Twelve is plenty for a
// session and leaves plenty of room under the cap.
const TURN_TTL_SECONDS = 12 * 60 * 60;
// The Cloudflare API is only asked for credentials when they are needed, so a
// short cache keeps a page reload from calling it every time.
const CACHE_MS = 5 * 60 * 1000;

let cached = null;

function stunOnly() {
  return { iceServers: [{ urls: [STUN_URL] }], relay: false, reason: 'no-turn-key' };
}

/**
 * Turn a TURN key into a short-lived set of iceServers.
 * The key stays on the server; the browser only ever sees the short-lived
 * credential that comes back.
 */
async function mintTurnIceServers(keyId, apiToken, ttl = TURN_TTL_SECONDS) {
  const response = await fetch(
    TURN_CREDENTIALS_URL + '/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers',
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiToken, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
    },
  );
  if (!response.ok) throw new Error('TURN credentials could not be generated (' + response.status + ')');
  const data = await response.json();
  if (!data || !Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error('TURN credentials came back empty');
  return data.iceServers;
}

/**
 * Build the iceServers list for the browser.
 * With a TURN key configured this returns a STUN entry plus a relay entry;
 * without one it returns STUN only, which still connects most of the internet.
 */
async function iceServers(env = {}) {
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_API_TOKEN;
  if (!keyId || !apiToken) return stunOnly();
  const now = Date.now();
  if (cached && cached.keyId === keyId && now - cached.at < CACHE_MS) return cached.value;
  try {
    const turn = await mintTurnIceServers(keyId, apiToken);
    const value = { iceServers: [{ urls: [STUN_URL] }].concat(turn), relay: true, reason: 'cloudflare-turn' };
    cached = { keyId, at: now, value };
    return value;
  } catch (error) {
    // A broken key must not take the table's voice down with it. The failure
    // is not cached, so a key that is fixed a moment later is picked up at once.
    return { iceServers: [{ urls: [STUN_URL] }], relay: false, reason: 'turn-unavailable' };
  }
}

const api = { STUN_URL, TURN_TTL_SECONDS, iceServers, mintTurnIceServers, stunOnly };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.ParcheesiIce = api;
