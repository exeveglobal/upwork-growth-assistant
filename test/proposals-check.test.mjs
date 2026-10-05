import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { computeNudge, applyCheck, CHECK_EVERY_MS } = await import('../proposals-check.js');
const { handleProposalsRows } = await import('../proposals-sync.js');
const { flush } = await import('../outbox.js');

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime();
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const log = (over = {}) => ({ id: 'l', jobId: '~J1', title: 'Website redesign', submittedAt: ago(5), status: 'applied', connects: 14, boost: 'none', ...over });
const beats = () => env.calls.flatMap(c => c.body?.events ?? []).filter(e => e.type === 'proposals.checked');

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

test('nothing to check without open proposals', () => {
  assert.equal(computeNudge([], {}, NOW), null);
  assert.equal(computeNudge([log({ status: 'hired' }), log({ jobId: '~J2', status: 'rejected' }), log({ jobId: '~J3', status: 'archived' })], {}, NOW), null);
});

test('a proposal sent a moment ago is not nagged about; one never checked for 3 days is', () => {
  assert.equal(computeNudge([log({ submittedAt: ago(0.1) })], {}, NOW), null);
  assert.equal(computeNudge([log({ submittedAt: ago(2.9) })], {}, NOW), null);
  const n = computeNudge([log({ submittedAt: ago(4) })], {}, NOW);
  assert.deepEqual([n.kind, n.never, n.count, n.url], ['stale', true, 1, 'https://www.upwork.com/nx/proposals/']);
});

test('the 3 day clock restarts whenever the Proposals page is looked at', () => {
  const logs = [log({ submittedAt: ago(20) })];
  assert.equal(computeNudge(logs, { activeAt: NOW - 2 * DAY }, NOW), null);
  const n = computeNudge(logs, { activeAt: NOW - CHECK_EVERY_MS }, NOW);
  assert.equal(n.kind, 'stale');
  assert.equal(n.days, 3);
  assert.equal(n.never, false);
});

test('proposals that dropped off the Active list ask for a look at Archived, until it is looked at', () => {
  const logs = [log({ submittedAt: ago(6) }), log({ jobId: '~J2', submittedAt: ago(6) })];
  const check = { activeAt: NOW - 1000, missingJobIds: ['~J1'] };
  const n = computeNudge(logs, check, NOW);
  assert.deepEqual([n.kind, n.count, n.url], ['archive', 1, 'https://www.upwork.com/nx/proposals/archived']);
  assert.deepEqual([n.titles, n.more], [['Website redesign'], 0], 'names what to look for in the (paged) Archived list');
  assert.equal(computeNudge(logs, { ...check, archivedAt: NOW }, NOW), null, 'archive visited after the active check');
  assert.equal(computeNudge([log({ status: 'rejected', submittedAt: ago(6) }), logs[1]], check, NOW), null, 'closed by hand meanwhile');
});

test('applyCheck: an empty Active list marks every older open proposal as gone, but not a fresh one', () => {
  const logs = [log({ submittedAt: ago(5) }), log({ jobId: '~J2', submittedAt: ago(0.2) }), log({ jobId: '~J3', status: 'hired', submittedAt: ago(9) })];
  const c = applyCheck({}, { page: 'active', matchedJobIds: [], logs, now: NOW });
  assert.deepEqual(c.missingJobIds, ['~J1']);
  assert.equal(c.activeAt, NOW);
  const c2 = applyCheck(c, { page: 'active', matchedJobIds: ['~J1'], logs, now: NOW + 1000 });
  assert.deepEqual(c2.missingJobIds, [], 'still on the Active list');
  const c3 = applyCheck(c, { page: 'archived', matchedJobIds: ['~J1'], logs, now: NOW + 1000 });
  assert.equal(c3.archivedAt, NOW + 1000);
  assert.deepEqual(c3.missingJobIds, []);
});

test('looking at an empty Active page records the check, stores the reminder and tells the engine once', async () => {
  env.store.logs = [log({ submittedAt: ago(5) })];
  await handleProposalsRows([], NOW, 'active');
  await flush();
  assert.equal(env.store.proposalsCheck.activeAt, NOW);
  assert.equal(env.store.nudge.kind, 'archive', 'its proposal is no longer in Active');
  assert.equal(beats().length, 1);
  assert.deepEqual(beats()[0].payload, { page: 'active', rows: 0, matched: 0 });

  await handleProposalsRows([], NOW + 60_000, 'active');
  await flush();
  assert.equal(beats().length, 1, 'no second heartbeat within 30 minutes');
  await handleProposalsRows([], NOW + 31 * 60_000, 'active');
  await flush();
  assert.equal(beats().length, 2);

  await handleProposalsRows([], NOW + 40 * 60_000, 'archived');
  assert.equal(env.store.nudge, null, 'Archived looked at: the reminder clears');
});

test('without a key nothing is tracked or nagged', async () => {
  delete env.store.connection;
  env.store.logs = [log({ submittedAt: ago(9) })];
  await handleProposalsRows([], NOW, 'active');
  assert.equal(env.store.proposalsCheck, undefined);
  assert.equal(env.store.nudge, undefined);
});

test('the archive reminder names at most three proposals and counts the rest', () => {
  const logs = ['A', 'B', 'C', 'D', 'E'].map((x, i) => log({ jobId: '~J' + i, title: 'Job ' + x, submittedAt: ago(6) }));
  const n = computeNudge(logs, { activeAt: NOW - 1000, missingJobIds: logs.map(l => l.jobId) }, NOW);
  assert.deepEqual([n.titles, n.more, n.count], [['Job A', 'Job B', 'Job C'], 2, 5]);
});
