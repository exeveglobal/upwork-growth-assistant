import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, json, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { enqueue, flush, pendingCount } = await import('../outbox.js');
const { getConnection, getConnectionLost } = await import('../connection.js');

beforeEach(() => env.reset());

const errorLog = () => env.store.errorLog ?? [];
const payload = (n = 1) => ({ jobId: '~0221000000000000' + n, title: 'T' + n });

test('free tier: enqueue records nothing and sends nothing', async () => {
  assert.equal(await enqueue('job.scored', payload()), false);
  assert.equal(env.queued().length, 0);
  assert.equal(env.calls.length, 0);
});

test('connected: queues an enveloped event and sends it with the bearer token', async () => {
  env.connect('m1', 'ege_tok');
  env.responder = acceptAll;
  assert.equal(await enqueue('job.scored', payload(), { scoringVersion: '1' }), true);
  await flush();

  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, 'https://engine.test/v1/events');
  assert.equal(env.calls[0].init.headers.Authorization, 'Bearer ege_tok');
  const [e] = env.calls[0].body.events;
  assert.match(e.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { type: e.type, extensionVersion: e.extensionVersion, scoringVersion: e.scoringVersion, payload: e.payload },
    { type: 'job.scored', extensionVersion: '9.9.9', scoringVersion: '1', payload: payload() }
  );
  assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
  assert.equal(await pendingCount(), 0, 'removed after the engine accepted it');
});

test('offline: events stay queued, then are re-sent with the SAME eventId', async () => {
  env.connect();
  env.responder = () => { throw new TypeError('Failed to fetch'); };
  await enqueue('job.scored', payload());
  assert.equal((await flush()).stopped, 'offline');
  assert.equal(await pendingCount(), 1);
  const firstId = env.calls[0].body.events[0].eventId;

  env.responder = acceptAll;
  assert.equal((await flush()).sent, 1);
  assert.equal(env.calls.at(-1).body.events[0].eventId, firstId);
  assert.equal(await pendingCount(), 0);
});

test('429 and 5xx keep the queue for a later retry', async () => {
  env.connect();
  for (const status of [429, 500, 503]) {
    env.responder = () => json(status, {});
    await enqueue('job.scored', payload());
    assert.equal((await flush()).stopped, 'retry');
  }
  assert.equal(await pendingCount(), 3);
  assert.equal(errorLog().length, 0);
});

test('a garbled 200 is treated as retry, not as success', async () => {
  env.connect();
  env.responder = () => new Response('<html>proxy error</html>', { status: 200 });
  await enqueue('job.scored', payload());
  assert.equal((await flush()).stopped, 'retry');
  assert.equal(await pendingCount(), 1);
});

test('400/413 drop the batch (it can never succeed) and log it; the queue does not jam', async () => {
  env.connect();
  env.responder = () => json(400, { error: 'invalid_request' });
  await enqueue('job.scored', payload());
  await flush();
  assert.equal(await pendingCount(), 0);
  assert.match(errorLog().at(-1).context, /batch refused/);
});

test('events the engine rejects are dropped and logged without their contents', async () => {
  env.connect();
  env.responder = (_u, init) => {
    const { events } = JSON.parse(init.body);
    return json(200, { results: events.map(e => ({ eventId: e.eventId, status: 'rejected', error: 'invalid_event: title: Required' })) });
  };
  await enqueue('job.scored', { jobId: '~022100000000000000', title: 'Secret client title' });
  await flush();
  assert.equal(await pendingCount(), 0);
  const entry = errorLog().at(-1);
  assert.match(entry.message, /job\.scored: invalid_event/);
  assert.ok(!JSON.stringify(entry).includes('Secret client title'));
});

test('401 ends the connection but KEEPS the queue; same member reconnecting resumes it', async () => {
  env.connect('m1', 'old_tok');
  env.responder = () => json(401, { error: 'device_revoked' });
  await enqueue('job.scored', payload());
  const r = await flush();
  assert.equal(r.stopped, 'not_connected');
  assert.equal(await getConnection(), null);
  assert.equal((await getConnectionLost()).reason, 'device_revoked');
  assert.equal(await pendingCount(), 1);

  env.connect('m1', 'new_tok');           // same member, new key
  env.responder = acceptAll;
  assert.equal((await flush()).sent, 1);
  assert.equal(env.calls.at(-1).init.headers.Authorization, 'Bearer new_tok');
});

test('a different member connecting never inherits the previous member\'s events', async () => {
  env.connect('m1', 'tok1');
  env.responder = () => { throw new TypeError('offline'); };
  await enqueue('job.scored', payload(1));
  await flush();
  assert.equal(await pendingCount(), 1);

  env.connect('m2', 'tok2');              // shared browser, new person
  env.responder = acceptAll;
  env.calls.length = 0;
  await flush();
  assert.equal(env.calls.length, 0, 'nothing was sent under m2\'s token');
  assert.equal(await pendingCount(), 0, 'm1\'s events were purged');
});

test('the connection changing between "pick events" and "send" cannot misattribute them', async () => {
  // The event belongs to m1. Switch to m2 at the exact moment the sender re-reads the connection.
  env.connect('m1', 'tok1');
  env.store['ob:000000000000001:000000:e1'] = { memberId: 'm1', event: { eventId: 'e1', type: 'job.scored', payload: {} } };
  env.responder = acceptAll;

  const realGet = chrome.storage.local.get;
  let connectionReads = 0;
  chrome.storage.local.get = (keys, fn) => {
    if (keys === 'connection' && ++connectionReads === 2) env.connect('m2', 'tok2'); // 1st = flush start, 2nd = send
    return realGet(keys, fn);
  };
  try {
    const r = await flush();
    assert.equal(env.calls.length, 0, 'refused to send m1\'s event under m2\'s token');
    assert.ok(r.stopped);
  } finally {
    chrome.storage.local.get = realGet;
  }
});

test('events are sent in the order they were queued, in batches of at most 50', async () => {
  env.connect();
  env.responder = () => { throw new TypeError('offline'); };
  for (let i = 0; i < 120; i++) await enqueue('job.scored', { n: i });
  env.calls.length = 0;

  env.responder = acceptAll;
  assert.equal((await flush()).sent, 120);
  assert.deepEqual(env.calls.map(c => c.body.events.length), [50, 50, 20]);
  const order = env.calls.flatMap(c => c.body.events.map(e => e.payload.n));
  assert.deepEqual(order, Array.from({ length: 120 }, (_, i) => i));
});

test('large events are split so no request exceeds the size budget', async () => {
  env.connect();
  env.responder = () => { throw new TypeError('offline'); };
  const big = 'x'.repeat(60_000);
  for (let i = 0; i < 20; i++) await enqueue('proposal.submitted', { n: i, coverLetter: big });
  env.calls.length = 0;

  env.responder = acceptAll;
  await flush();
  assert.ok(env.calls.length >= 3);
  for (const c of env.calls) assert.ok(c.init.body.length <= 400_000 + 70_000);
  assert.equal(env.calls.reduce((n, c) => n + c.body.events.length, 0), 20);
});

test('concurrent flushes share one request', async () => {
  env.connect();
  let release;
  env.responder = (u, init) => new Promise(res => { release = () => res(acceptAll(u, init)); });
  await enqueue('job.scored', payload());
  const a = flush();
  const b = flush();
  await new Promise(r => setTimeout(r, 20));
  release();
  await Promise.all([a, b]);
  assert.equal(env.calls.length, 1);
});

test('queue overflow drops the oldest events and logs it', async () => {
  env.connect();
  env.responder = () => { throw new TypeError('offline'); };
  // seed 2000 queued items directly (cheap), then enqueue one more
  for (let i = 0; i < 2000; i++) {
    env.store[`ob:${String(i).padStart(15, '0')}:seed${i}`] = { memberId: 'm1', event: { eventId: 'seed' + i, type: 'job.scored', payload: {} } };
  }
  await enqueue('job.scored', payload());
  assert.equal(await pendingCount(), 2000);
  assert.ok(!('ob:000000000000000:seed0' in env.store), 'oldest was dropped');
  assert.match(errorLog().at(-1).context, /overflow/);
});
