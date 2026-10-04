// connection.js - Connection to the Exeve growth engine.
//
// Free tier  = no stored connection: job scoring only, nothing is sent anywhere.
// Connected  = a device token (issued in exchange for an admin-issued key) is stored.
//
// The extension is public source, so this is a UX gate, not security: the engine rejects
// every request without a valid token. Any 401 from the engine ends the connection here.

import { DEFAULT_ENGINE_URL, CONSENT_VERSION } from './config.js';

const CONNECTION_KEY = 'connection';   // { token, member, engineUrl, connectedAt, consentVersion, limits }
const LOST_KEY = 'connectionLost';     // { reason, at } set when the engine ended the connection
const DEV_URL_KEY = 'devEngineUrl';    // local-development override, localhost only

export class NotConnectedError extends Error {
  constructor(reason = 'not_connected') {
    super(reason);
    this.name = 'NotConnectedError';
    this.reason = reason;
  }
}

async function engineUrl() {
  const { [DEV_URL_KEY]: dev } = await chrome.storage.local.get(DEV_URL_KEY);
  if (dev) {
    try {
      const u = new URL(dev);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
    } catch { /* fall through to default */ }
  }
  return DEFAULT_ENGINE_URL.replace(/\/+$/, '');
}

export async function getConnection() {
  const { [CONNECTION_KEY]: conn } = await chrome.storage.local.get(CONNECTION_KEY);
  return conn && conn.token ? conn : null;
}

export async function getConnectionLost() {
  const { [LOST_KEY]: lost } = await chrome.storage.local.get(LOST_KEY);
  return lost || null;
}

/** Human-readable device label shown to the admin, e.g. "Chrome on macOS". */
export function deviceLabel() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

/**
 * Exchanges an admin-issued key for a device token and stores the connection.
 * Resolves { ok: true, member } or { ok: false, reason } where reason is one of:
 * invalid_code | member_disabled | device_limit | too_many_attempts | invalid_request | network | unknown
 */
export async function connectWithCode(code, label = deviceLabel()) {
  const base = await engineUrl();
  let res;
  try {
    res = await fetch(`${base}/v1/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceLabel: label, consentVersion: CONSENT_VERSION })
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok) return { ok: false, reason: body.error || 'unknown' };

  await chrome.storage.local.set({
    [CONNECTION_KEY]: {
      token: body.token,
      member: body.member,
      engineUrl: base,
      connectedAt: new Date().toISOString(),
      consentVersion: CONSENT_VERSION,
      limits: null
    }
  });
  await chrome.storage.local.remove(LOST_KEY);
  return { ok: true, member: body.member };
}

/** User-initiated disconnect. Returns to Free quietly (no "connection lost" notice). */
export async function disconnect() {
  await chrome.storage.local.remove([CONNECTION_KEY, LOST_KEY]);
}

// The engine said this token is no longer valid. Only drop it if it is still the stored one,
// so a late 401 for an old token can't wipe a connection the user just re-established.
async function dropConnection(reason, usedToken) {
  const current = await getConnection();
  if (!current || current.token !== usedToken) return;
  await chrome.storage.local.remove(CONNECTION_KEY);
  await chrome.storage.local.set({ [LOST_KEY]: { reason, at: new Date().toISOString() } });
}

/**
 * fetch() against the engine with the device token. Any 401 ends the connection and throws NotConnectedError.
 * `expectToken`: refuse to send (throws 'connection_changed', connection untouched) unless the
 * stored token is still this one, so data prepared for one member can't go out under another's.
 */
export async function authFetch(path, init = {}, { expectToken } = {}) {
  const conn = await getConnection();
  if (!conn) throw new NotConnectedError();
  if (expectToken && conn.token !== expectToken) throw new NotConnectedError('connection_changed');

  const res = await fetch(`${conn.engineUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${conn.token}` }
  });

  if (res.status === 401) {
    let reason = 'invalid_token';
    try { reason = (await res.clone().json()).error || reason; } catch { /* keep default */ }
    await dropConnection(reason, conn.token);
    throw new NotConnectedError(reason);
  }
  return res;
}

/**
 * Checks the stored token with the engine.
 * { state: 'free' }                      no connection (or it was just ended; `lost` says why)
 * { state: 'connected', member, limits } token valid
 * { state: 'offline' }                   engine unreachable: keep the connection, retry later
 */
export async function verifyConnection() {
  const conn = await getConnection();
  if (!conn) return { state: 'free' };

  try {
    const res = await authFetch('/v1/me');
    if (!res.ok) return { state: 'offline' };
    const me = await res.json();

    const latest = await getConnection();
    if (latest && latest.token === conn.token) {
      await chrome.storage.local.set({ [CONNECTION_KEY]: { ...latest, member: me.member, limits: me.limits } });
    }
    return { state: 'connected', member: me.member, limits: me.limits };
  } catch (err) {
    if (err instanceof NotConnectedError) return { state: 'free', lost: err.reason };
    return { state: 'offline' };
  }
}
