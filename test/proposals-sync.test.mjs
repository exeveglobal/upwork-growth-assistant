import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { parseInitiated, normalizeTitle, statusFromRow, nextStatus, handleProposalsRows } = await import('../proposals-sync.js');
const { flush } = await import('../outbox.js');

const JOB1 = '~022106334687117392891';
const JOB2 = '~022106342951146432544';
const NOW = new Date(2026, 9, 3, 15, 0, 0).getTime();            // Oct 3 2026, local
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

const row = (over = {}) => ({ proposalId: '2096409461684633601', title: 'Website redesign', initiated: 'Initiated Oct 3, 2026', reason: 'Job is closed', section: 'archived', ...over });
const log = (over = {}) => ({ id: 'l1', jobId: JOB1, title: 'Website redesign', submittedAt: at(2026, 10, 3), status: 'applied', connects: 14, boost: 'none', ...over });
const events = () => env.calls.flatMap(c => c.body?.events ?? []).filter(e => e.type === 'proposal.status_changed').map(e => e.payload);
const sync = async (rows) => { const r = await handleProposalsRows(rows, NOW); await flush(); return r; };

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

// ── pure helpers ────────────────────────────────────────────────────────────
test('parseInitiated reads Upwork dates as local midnight', () => {
  assert.deepEqual(parseInitiated('Initiated Sep 6, 2026')?.getTime(), new Date(2026, 8, 6).getTime());
  assert.deepEqual(parseInitiated('Initiated Dec 15, 2025')?.getTime(), new Date(2025, 11, 15).getTime());
  assert.equal(parseInitiated('Received Aug 22, 2026')?.getTime(), new Date(2026, 7, 22).getTime());
  assert.equal(parseInitiated('nonsense'), null);
  assert.equal(parseInitiated(''), null);
  assert.equal(parseInitiated(undefined), null);
});

test('titles match regardless of case, punctuation and spacing', () => {
  assert.equal(normalizeTitle('  WordPress Developer – Update (Desktop + Mobile)! '), 'wordpress developer update desktop mobile');
  assert.equal(normalizeTitle('Colombo / Negombo social media'), normalizeTitle('colombo negombo SOCIAL media'));
  assert.equal(normalizeTitle('Café Redesign'), 'café redesign');
  assert.notEqual(normalizeTitle('Website redesign'), normalizeTitle('Website redesign 2'));
});

test('row status: sections and archive reasons', () => {
  const s = (section, reason) => statusFromRow({ section, reason });
  assert.equal(s('submitted'), 'submitted');
  assert.equal(s('active'), 'interviewing');
  assert.equal(s('archived', 'Hired'), 'hired');
  assert.equal(s('archived', 'hired'), 'hired');
  assert.equal(s('archived', 'Job is closed'), 'archived');
  assert.equal(s('archived', 'Declined by client'), 'declined');
  assert.equal(s('archived', 'Withdrawn'), 'withdrawn');
  assert.equal(s('archived', 'Client hired someone else'), 'archived', '"hired" inside a longer reason is NOT our hire');
  assert.equal(s('archived', ''), 'archived');
  assert.equal(s('unknown', 'Hired'), null);
});

test('nextStatus: forward only, hired is final, archive states apply', () => {
  assert.equal(nextStatus('submitted', 'interviewing'), 'interviewing');
  assert.equal(nextStatus('interviewing', 'submitted'), 'interviewing', 'never backwards');
  assert.equal(nextStatus('interviewing', 'hired'), 'hired');
  assert.equal(nextStatus('hired', 'archived'), 'hired', 'hired is never overridden');
  assert.equal(nextStatus('hired', 'submitted'), 'hired');
  assert.equal(nextStatus('submitted', 'archived'), 'archived');
  assert.equal(nextStatus('interviewing', 'declined'), 'declined');
  assert.equal(nextStatus('archived', 'interviewing'), 'interviewing', 'a reopened proposal moves out of archive');
  assert.equal(nextStatus('submitted', 'submitted'), 'submitted');
});

// ── matching and syncing ────────────────────────────────────────────────────
test('matches by title and date, queues a verified status change, and updates the ROI Hub', async () => {
  env.store.logs = [log()];
  assert.deepEqual(await sync([row()]), { matched: 1 });
  assert.deepEqual(events(), [{
    jobId: JOB1, to: 'archived', source: 'scraped', changedAt: new Date(NOW).toISOString(),
    upworkProposalId: '2096409461684633601', reason: 'Job is closed'
  }]);
  assert.equal(env.store.logs[0].status, 'archived');
  assert.deepEqual(env.store.proposalsSeen['2096409461684633601'], { jobId: JOB1, status: 'archived', verified: true });
});

test('a day of difference is tolerated (time zones); two days is not', async () => {
  env.store.logs = [log({ submittedAt: at(2026, 10, 2, 23) })];
  assert.equal((await sync([row()])).matched, 1);
  env.reset(); env.connect(); env.responder = acceptAll;
  env.store.logs = [log({ submittedAt: at(2026, 10, 1) })];
  assert.equal((await sync([row()])).matched, 0);
  assert.equal(events().length, 0);
});

test('unknown proposals (made before install) and different titles are ignored', async () => {
  env.store.logs = [log({ title: 'Something else entirely' })];
  assert.equal((await sync([row()])).matched, 0);
  assert.equal(events().length, 0);
  assert.equal(env.store.logs[0].status, 'applied');
});

test('ambiguous matches (same title, same day, two jobs) are skipped, never guessed', async () => {
  env.store.logs = [log(), log({ id: 'l2', jobId: JOB2 })];
  assert.equal((await sync([row()])).matched, 0);
  assert.equal(events().length, 0);
});

test('once matched, the proposal id is bound to the job even if the title later differs', async () => {
  env.store.logs = [log()];
  await sync([row({ section: 'submitted' })]);
  env.store.logs[0].title = 'Renamed locally';
  env.calls.length = 0;
  await sync([row({ section: 'archived', reason: 'Hired' })]);
  assert.deepEqual(events().map(e => e.to), ['hired']);
});

test('the same proposal id never binds to two jobs', async () => {
  env.store.logs = [log(), log({ id: 'l2', jobId: JOB2, title: 'Other job' })];
  await sync([row()]);
  await sync([row({ title: 'Other job' })]);                       // same id, different title: still the first job
  assert.equal(env.store.proposalsSeen['2096409461684633601'].jobId, JOB1);
});

test('no change since the last look: nothing is re-sent (opening the page repeatedly is free)', async () => {
  env.store.logs = [log()];
  await sync([row()]);
  env.calls.length = 0;
  await sync([row()]);
  await sync([row()]);
  assert.equal(events().length, 0);
});

test('a manual override stands until Upwork reports something different', async () => {
  env.store.logs = [log()];
  await sync([row({ section: 'submitted' })]);                      // verified as submitted
  env.store.logs[0].status = 'interviewing';                        // member marks it interviewing by hand
  env.calls.length = 0;
  await sync([row({ section: 'submitted' })]);                      // Upwork still says submitted
  assert.equal(events().length, 0);
  assert.equal(env.store.logs[0].status, 'interviewing');

  await sync([row({ section: 'archived', reason: 'Job is closed' })]);   // Upwork now says archived: real change
  assert.equal(env.store.logs[0].status, 'archived');
  assert.deepEqual(events().map(e => e.to), ['archived']);
});

test('first sighting of a proposal the member already advanced by hand does not move it backwards', async () => {
  env.store.logs = [log({ status: 'interviewing' })];
  await sync([row({ section: 'submitted' })]);
  assert.equal(env.store.logs[0].status, 'interviewing');
  assert.deepEqual(events().map(e => e.to), ['interviewing'], 'still sent once, to verify the proposal exists');
});

test('hired is never replaced by the archive reason that follows it', async () => {
  env.store.logs = [log({ status: 'hired' })];
  await sync([row({ reason: 'Job is closed' })]);
  assert.equal(env.store.logs[0].status, 'hired');
  assert.deepEqual(events().map(e => e.to), ['hired']);
});

test('several rows in one report are handled independently', async () => {
  env.store.logs = [log(), log({ id: 'l2', jobId: JOB2, title: 'Fix large website performance' })];
  await sync([
    row({ proposalId: '2000000000000000001', title: 'Website redesign', reason: 'Hired' }),
    row({ proposalId: '2000000000000000002', title: 'Fix large website performance', reason: 'Job is closed' }),
    row({ proposalId: '2000000000000000003', title: 'Not mine' }),
    row({ proposalId: 'bad-id', title: 'Website redesign' })
  ]);
  assert.deepEqual(events().map(e => [e.jobId, e.to]), [[JOB1, 'hired'], [JOB2, 'archived']]);
  assert.deepEqual(env.store.logs.map(l => l.status), ['hired', 'archived']);
});

test('free tier: rows are ignored entirely', async () => {
  delete env.store.connection;
  env.store.logs = [log()];
  assert.deepEqual(await sync([row()]), { matched: 0 });
  assert.equal(env.calls.length, 0);
  assert.equal(env.store.logs[0].status, 'applied');
  assert.ok(!('proposalsSeen' in env.store));
});

test('garbage input does not throw', async () => {
  env.store.logs = [log()];
  assert.deepEqual(await sync(undefined), { matched: 0 });
  assert.deepEqual(await sync([null, undefined, 42, 'x', {}, { section: 'archived' }]), { matched: 0 });
  assert.equal(events().length, 0);
});

test('local logs without a job id (manual, unlinked) are never matched', async () => {
  env.store.logs = [log({ jobId: undefined })];
  assert.equal((await sync([row()])).matched, 0);
});

test('a status set by hand is not pulled back by Upwork showing less, but moves forward when it shows more', async () => {
  const { nextStatus } = await import('../proposals-sync.js');
  assert.equal(nextStatus('replied', 'submitted'), 'replied', 'manual reply survives a scan that still says submitted');
  assert.equal(nextStatus('viewed', 'submitted'), 'viewed');
  assert.equal(nextStatus('replied', 'interviewing'), 'interviewing', 'Upwork moving the proposal to Active wins');
  assert.equal(nextStatus('submitted', 'replied'), 'replied');
  assert.equal(nextStatus('hired', 'replied'), 'hired');
  assert.equal(nextStatus('replied', 'archived'), 'archived', 'closed on Upwork still closes it');
});
