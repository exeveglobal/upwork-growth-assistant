import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, json } from './fake-chrome.mjs';

// One Chrome profile, several Exeve members over time: each only ever sees and syncs their own proposals.
const env = installChrome();
const { applyManualLog, upsertCapturedLog, visibleLogs, adoptLegacyLogs, markSyncIssue } = await import('../logs.js');
const { enqueue, flush } = await import('../outbox.js');
const { handleProposalsRows } = await import('../proposals-sync.js');
const { computeNudge } = await import('../proposals-check.js');
const { readDiag } = await import('../diag.js');

const NOW = new Date(2026, 9, 10, 15).getTime();
const row = (over = {}) => ({ id: 'x', jobId: '~J1', title: 'Website redesign', submittedAt: new Date(NOW - 5 * 86_400_000).toISOString(), status: 'applied', connects: 14, boost: 'none', ...over });

beforeEach(() => { env.reset(); env.connect('A', 'tok'); });

test('rows are only visible to the member who owns them', () => {
  const logs = [row({ memberId: 'A' }), row({ id: 'y', jobId: '~J2', memberId: 'B' }), row({ id: 'z', jobId: '~J3' })];
  assert.deepEqual(visibleLogs(logs, 'A').map(l => l.id), ['x']);
  assert.deepEqual(visibleLogs(logs, 'B').map(l => l.id), ['y']);
  assert.deepEqual(visibleLogs(logs, undefined), [], 'not connected: nothing');
});

test('older rows without an owner are adopted by whoever is connected, once', async () => {
  env.store.logs = [row(), row({ id: 'k', jobId: '~J9', memberId: 'B' })];
  await adoptLegacyLogs('A');
  assert.deepEqual(env.store.logs.map(l => l.memberId), ['A', 'B']);
  await adoptLegacyLogs('C');
  assert.deepEqual(env.store.logs.map(l => l.memberId), ['A', 'B'], 'rows that have an owner never change hands');
});

test('the same job logged by two members is two separate rows, never merged', async () => {
  const a = row({ memberId: 'A', connects: 20 });
  const forB = applyManualLog([a], row({ id: 'n', memberId: 'B', connects: 30 }));
  assert.equal(forB.action, 'created');
  assert.equal(forB.logs.length, 2);
  assert.equal(forB.logs.find(l => l.memberId === 'A').connects, 20, "A's row is untouched");
  env.store.logs = forB.logs;
  await upsertCapturedLog({ jobId: '~J1', title: 'Website redesign', connectsTotal: 40, submittedAt: new Date(NOW).toISOString() }, 'B');
  assert.deepEqual(env.store.logs.map(l => [l.memberId, l.connects]).sort(), [['A', 20], ['B', 40]]);
});

test("a status scan for one member never touches another member's rows or reminders", async () => {
  env.connect('B', 'tokB');
  env.store.logs = [row({ id: 'a1', memberId: 'A' }), row({ id: 'b1', memberId: 'B' })];
  await handleProposalsRows([{ proposalId: '2096409461684633601', title: 'Website redesign', initiated: 'Initiated ' + new Date(NOW - 5 * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), reason: 'Hired', section: 'archived' }], NOW, 'archived');
  const by = Object.fromEntries(env.store.logs.map(l => [l.id, l.status]));
  assert.equal(by.b1, 'hired', 'the connected member (B) is updated');
  assert.equal(by.a1, 'applied', "member A's row is left alone");
  // reminders only count the connected member's open proposals
  assert.equal(computeNudge(visibleLogs([row({ memberId: 'A' })], 'B'), {}, NOW), null);
});

test('a refusal from the engine is shown on the row and in diagnostics; a later success clears it', async () => {
  env.store.logs = [row({ memberId: 'A' }), row({ id: 'o', jobId: '~J2', memberId: 'B' })];
  env.responder = (_u, init) => json(200, { results: JSON.parse(init.body).events.map(e => ({ eventId: e.eventId, status: 'rejected', error: 'unknown_proposal' })) });
  await enqueue('proposal.status_changed', { jobId: '~J1', to: 'interviewing', source: 'manual', changedAt: new Date().toISOString() });
  await flush();
  const mineRow = env.store.logs.find(l => l.id === 'x');
  assert.equal(mineRow.syncIssue, 'unknown_proposal');
  assert.equal(env.store.logs.find(l => l.id === 'o').syncIssue, undefined, 'only the proposal concerned is marked');
  assert.ok((await readDiag()).some(d => d.kind === 'sync.rejected' && d.detail.error === 'unknown_proposal'));

  env.responder = (_u, init) => json(200, { results: JSON.parse(init.body).events.map(e => ({ eventId: e.eventId, status: 'accepted' })) });
  await enqueue('proposal.status_changed', { jobId: '~J1', to: 'hired', source: 'manual', changedAt: new Date().toISOString() });
  await flush();
  assert.equal(env.store.logs.find(l => l.id === 'x').syncIssue, undefined, 'cleared once the engine accepts a change');
});

test('markSyncIssue leaves other members rows with the same job alone', async () => {
  env.store.logs = [row({ memberId: 'A' }), row({ id: 'q', memberId: 'B' })];
  await markSyncIssue('~J1', 'A', 'unknown_proposal');
  assert.equal(env.store.logs.find(l => l.id === 'x').syncIssue, 'unknown_proposal');
  assert.equal(env.store.logs.find(l => l.id === 'q').syncIssue, undefined);
});
