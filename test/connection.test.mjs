// Run with: npm test   (Node's built-in test runner, no dependencies)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── minimal chrome.storage.local fake ───────────────────────────────────────
let store;
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(list.filter(k => k in store).map(k => [k, structuredClone(store[k])]));
      },
      async set(obj) { Object.assign(store, structuredClone(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; }
    }
  }
};

// ── fetch fake: queue of responses, records requests ────────────────────────
let calls;
let responder;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return responder(url, init);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const {
  connectWithCode, disconnect, authFetch, verifyConnection, getConnection, getConnectionLost,
  NotConnectedError, deviceLabel
} = await import('../connection.js');

beforeEach(() => {
  store = {};
  calls = [];
  responder = () => json(500, {});
});

const OK_CONNECT = { token: 'ege_tok', member: { id: 'm1', name: 'Ayesha' } };

test('connect: sends code + consent version, stores connection', async () => {
  responder = () => json(200, OK_CONNECT);
  const res = await connectWithCode('  abcd-efgh-2345-wxyz ', 'Chrome on macOS');
  assert.deepEqual(res, { ok: true, member: OK_CONNECT.member });

  assert.equal(calls[0].url, 'https://ege.exeve.global/v1/connect');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    code: 'abcd-efgh-2345-wxyz', deviceLabel: 'Chrome on macOS', consentVersion: 1
  });
  const conn = await getConnection();
  assert.equal(conn.token, 'ege_tok');
  assert.equal(conn.member.name, 'Ayesha');
});

test('connect: clears an earlier "connection lost" notice on success', async () => {
  store.connectionLost = { reason: 'device_revoked', at: 'x' };
  responder = () => json(200, OK_CONNECT);
  await connectWithCode('code');
  assert.equal(await getConnectionLost(), null);
});

test('connect: maps engine errors to reasons and stores nothing', async () => {
  const cases = [
    [401, { error: 'invalid_code' }, 'invalid_code'],
    [403, { error: 'device_limit' }, 'device_limit'],
    [403, { error: 'member_disabled' }, 'member_disabled'],
    [429, { error: 'too_many_attempts' }, 'too_many_attempts'],
    [400, { error: 'invalid_request' }, 'invalid_request'],
    [502, {}, 'unknown']
  ];
  for (const [status, body, reason] of cases) {
    responder = () => json(status, body);
    assert.deepEqual(await connectWithCode('x'), { ok: false, reason });
  }
  assert.equal(await getConnection(), null);
});

test('connect: network failure and non-JSON error pages', async () => {
  responder = () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await connectWithCode('x'), { ok: false, reason: 'network' });
  responder = () => new Response('<html>Bad gateway</html>', { status: 502 });
  assert.deepEqual(await connectWithCode('x'), { ok: false, reason: 'unknown' });
});

test('dev engine URL override is honoured for localhost only', async () => {
  responder = () => json(401, { error: 'invalid_code' });
  store.devEngineUrl = 'http://localhost:8787/';
  await connectWithCode('x');
  assert.equal(calls.at(-1).url, 'http://localhost:8787/v1/connect');

  store.devEngineUrl = 'https://evil.example';
  await connectWithCode('x');
  assert.equal(calls.at(-1).url, 'https://ege.exeve.global/v1/connect');

  store.devEngineUrl = 'not a url';
  await connectWithCode('x');
  assert.equal(calls.at(-1).url, 'https://ege.exeve.global/v1/connect');
});

test('authFetch: throws NotConnectedError without a token and sends nothing', async () => {
  await assert.rejects(() => authFetch('/v1/me'), NotConnectedError);
  assert.equal(calls.length, 0);
});

test('authFetch: expectToken refuses to send when the stored token changed, and keeps the connection', async () => {
  store.connection = { token: 'new', member: {}, engineUrl: 'https://ege.exeve.global' };
  await assert.rejects(
    () => authFetch('/v1/events', {}, { expectToken: 'old' }),
    (e) => e instanceof NotConnectedError && e.reason === 'connection_changed'
  );
  assert.equal(calls.length, 0);
  assert.equal((await getConnection()).token, 'new');
  assert.equal(await getConnectionLost(), null);
});

test('authFetch: attaches the bearer token to the stored engine URL', async () => {
  store.connection = { token: 'ege_tok', member: { id: 'm1', name: 'A' }, engineUrl: 'http://localhost:8787' };
  responder = () => json(200, { ok: true });
  await authFetch('/v1/events', { method: 'POST', headers: { 'X-Test': '1' } });
  assert.equal(calls[0].url, 'http://localhost:8787/v1/events');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ege_tok');
  assert.equal(calls[0].init.headers['X-Test'], '1');
});

test('authFetch: a 401 ends the connection, records why, and throws', async () => {
  store.connection = { token: 'ege_tok', member: {}, engineUrl: 'https://ege.exeve.global' };
  responder = () => json(401, { error: 'device_revoked' });
  await assert.rejects(() => authFetch('/v1/me'), (e) => e instanceof NotConnectedError && e.reason === 'device_revoked');
  assert.equal(await getConnection(), null);
  assert.equal((await getConnectionLost()).reason, 'device_revoked');
});

test('authFetch: other errors (5xx) keep the connection', async () => {
  store.connection = { token: 'ege_tok', member: {}, engineUrl: 'https://ege.exeve.global' };
  responder = () => json(503, {});
  const res = await authFetch('/v1/me');
  assert.equal(res.status, 503);
  assert.equal((await getConnection()).token, 'ege_tok');
  assert.equal(await getConnectionLost(), null);
});

test('a late 401 for an old token does not wipe a newer connection', async () => {
  store.connection = { token: 'old', member: {}, engineUrl: 'https://ege.exeve.global' };
  responder = async () => {
    // user reconnects while the old request is in flight
    store.connection = { token: 'new', member: {}, engineUrl: 'https://ege.exeve.global' };
    return json(401, { error: 'device_revoked' });
  };
  await assert.rejects(() => authFetch('/v1/me'), NotConnectedError);
  assert.equal((await getConnection()).token, 'new');
  assert.equal(await getConnectionLost(), null);
});

test('verify: free without a connection, connected refreshes member + limits', async () => {
  assert.deepEqual(await verifyConnection(), { state: 'free' });

  store.connection = { token: 'ege_tok', member: { id: 'm1', name: 'Old Name' }, engineUrl: 'https://ege.exeve.global' };
  responder = () => json(200, { member: { id: 'm1', name: 'New Name' }, limits: { weeklyConnectsBudget: 100, aiDailyLimit: null } });
  const r = await verifyConnection();
  assert.equal(r.state, 'connected');
  const conn = await getConnection();
  assert.equal(conn.member.name, 'New Name');
  assert.equal(conn.limits.weeklyConnectsBudget, 100);
});

test('verify: revoked/disabled → free with reason; offline/5xx keeps the connection', async () => {
  store.connection = { token: 'ege_tok', member: {}, engineUrl: 'https://ege.exeve.global' };
  responder = () => json(401, { error: 'member_disabled' });
  assert.deepEqual(await verifyConnection(), { state: 'free', lost: 'member_disabled' });
  assert.equal(await getConnection(), null);

  store.connection = { token: 'ege_tok', member: {}, engineUrl: 'https://ege.exeve.global' };
  responder = () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await verifyConnection(), { state: 'offline' });
  responder = () => json(500, {});
  assert.deepEqual(await verifyConnection(), { state: 'offline' });
  assert.equal((await getConnection()).token, 'ege_tok');
});

test('disconnect: clears the connection quietly', async () => {
  store.connection = { token: 'ege_tok', member: {}, engineUrl: 'x' };
  store.connectionLost = { reason: 'old', at: 'x' };
  await disconnect();
  assert.equal(await getConnection(), null);
  assert.equal(await getConnectionLost(), null);
});

test('deviceLabel is a readable string', () => {
  assert.match(deviceLabel(), /^\w+ on [\w ]+$/);
});
