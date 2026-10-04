import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { handleActivityTicks, flushActivity, localDay, FLUSH_AT_SECONDS } = await import('../activity-sync.js');
const { flush } = await import('../outbox.js');

const NOW = new Date(2026, 9, 3, 15, 0, 0).getTime();
const slice = (ms) => Math.floor(ms / 5000);
// n consecutive 5s slices; by default they all end just before NOW (slices from the future are rejected)
const run = (n, startMs = NOW - (n + 1) * 5000) => Array.from({ length: n }, (_, i) => slice(startMs) + i);
const activity = () => env.calls.flatMap(c => c.body?.events ?? []).filter(e => e.type === 'activity.time').map(e => e.payload);
const send = async (msg, now = NOW) => { const r = await handleActivityTicks(msg, now); await flush(); return r; };

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

test('slices accumulate locally and nothing is sent below the threshold', async () => {
  assert.deepEqual(await send({ slices: run(6) }), { counted: 6 });
  assert.equal(activity().length, 0);
  assert.equal(env.store.activityState.pending[localDay(NOW)], 30);
});

test('reaching 5 minutes sends one delta per day and resets the counter', async () => {
  await send({ slices: run(FLUSH_AT_SECONDS / 5) });
  assert.deepEqual(activity(), [{ day: '2026-10-03', activeSeconds: 300 }]);
  assert.deepEqual(env.store.activityState.pending, {});
  await send({ slices: run(4, NOW - 20_000) });
  assert.equal(activity().length, 1, 'next batch starts from zero (deltas, not running totals)');
});

test('leaving or closing a tab (final) sends immediately, even for a short visit', async () => {
  await send({ slices: run(3), final: true });
  assert.deepEqual(activity(), [{ day: '2026-10-03', activeSeconds: 15 }]);
});

test('two tabs reporting the same time slices count once', async () => {
  const same = run(10);
  await send({ slices: same });
  await send({ slices: same });                                   // second visible tab, same moments
  await send({ slices: [...same, ...run(2, NOW - 5000)] });      // overlap plus two genuinely new slices (-5s and 0s)
  assert.equal(env.store.activityState.pending[localDay(NOW)], 60);
});

test('slices that cross midnight are split across days', async () => {
  const before = new Date(2026, 9, 3, 23, 59, 50).getTime();
  await send({ slices: run(6, before), final: true }, new Date(2026, 9, 4, 0, 5).getTime());
  assert.deepEqual(activity().sort((a, b) => a.day.localeCompare(b.day)), [
    { day: '2026-10-03', activeSeconds: 10 },
    { day: '2026-10-04', activeSeconds: 20 }
  ]);
});

test('free tier: activity is not recorded at all', async () => {
  delete env.store.connection;
  assert.deepEqual(await send({ slices: run(100), final: true }), { counted: 0 });
  assert.ok(!('activityState' in env.store));
  assert.equal(env.calls.length, 0);
});

test('seconds from before connecting are never counted (nothing is kept while Free)', async () => {
  delete env.store.connection;
  await send({ slices: run(50) });
  env.connect('m1', 'tok');
  await send({ slices: run(2, NOW - 10_000), final: true });
  assert.deepEqual(activity(), [{ day: '2026-10-03', activeSeconds: 10 }]);
});

test('a different member on the same browser never inherits the previous member\'s seconds', async () => {
  await send({ slices: run(20) });                                // m1: 100s pending
  env.connect('m2', 'tok2');
  await send({ slices: run(2, NOW - 10_000), final: true });
  assert.deepEqual(activity(), [{ day: '2026-10-03', activeSeconds: 10 }]);
  assert.equal(env.store.activityState.memberId, 'm2');
});

test('invalid, future and ancient slices are ignored', async () => {
  const r = await send({ slices: [1.5, -3, NaN, 'x', null, slice(NOW + 3_600_000), slice(NOW - 3 * 86_400_000), slice(NOW - 5000)] });
  assert.deepEqual(r, { counted: 1 });
});

test('a flood of slices in one message is capped', async () => {
  const r = await send({ slices: run(5000, NOW - 20_000_000) });
  assert.ok(r.counted <= 200);
});

test('the 5-minute alarm flushes what is pending; nothing pending sends nothing', async () => {
  await flushActivity();
  assert.equal(activity().length, 0);
  await send({ slices: run(8) });
  assert.equal(activity().length, 0);
  await flushActivity(); await flush();
  assert.deepEqual(activity(), [{ day: '2026-10-03', activeSeconds: 40 }]);
  await flushActivity(); await flush();
  assert.equal(activity().length, 1, 'already sent: not sent twice');
});

test('rapid concurrent messages are serialised without losing or double counting slices', async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => handleActivityTicks({ slices: run(5, NOW - 300_000 + i * 25_000) }, NOW)));
  await flushActivity(); await flush();
  assert.equal(activity().reduce((n, a) => n + a.activeSeconds, 0), 250);
});

test('localDay formats the member\'s local calendar day', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 9).getTime()), '2026-01-05');
  assert.equal(localDay(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31');
});
