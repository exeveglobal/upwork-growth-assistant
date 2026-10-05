import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { handleApplyMessage, handleTabUpdated, handleTabRemoved, CONFIRM_WINDOW_MS } = await import('../capture.js');
const { flush } = await import('../outbox.js');
const { buildCapturedProposalPayload } = await import('../tracking.js');

const JOB = '~022106334687117392891';
const APPLY = `https://www.upwork.com/nx/proposals/job/${JOB}/apply/`;
const DONE = 'https://www.upwork.com/nx/proposals/9999';
const TAB = 7;

const form = (over = {}) => ({
  jobId: JOB, title: 'Build a Wordpress Website', applyAs: 'freelancer', connectsAvailableBefore: 189,
  connectsRequired: 14, connectsBoost: 0, connectsTotal: 14, connectsRemainingAfter: 175,
  contractType: 'fixed', bidAmount: 100, youReceive: 90, serviceFeePct: 10, duration: '1 to 3 months',
  coverLetter: 'Hello there', ...over
});
const click = (data = form()) => handleApplyMessage({ action: 'applySendClicked', data }, { tab: { id: TAB } });
const sentEvents = () => env.calls.flatMap(c => c.body?.events ?? []);
const logs = () => env.store.logs ?? [];

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

test('send click then leaving the apply page records the proposal (outbox + ROI Hub)', async () => {
  await click();
  assert.equal(sentEvents().length, 0, 'nothing is recorded just because Send was clicked');

  await handleTabUpdated(TAB, { url: DONE });
  await flush();

  const [e] = sentEvents();
  assert.equal(e.type, 'proposal.submitted');
  assert.equal(e.payload.source, 'capture');
  assert.equal(e.payload.confirmation, 'navigated');
  assert.equal(e.payload.jobId, JOB);
  assert.equal(e.payload.coverLetter, 'Hello there');
  assert.equal(e.payload.connectsTotal, 14);
  assert.equal(e.payload.bidAmount, 100);
  assert.equal(e.occurredAt, e.payload.submittedAt);

  assert.equal(logs().length, 1);
  assert.deepEqual(
    { jobId: logs()[0].jobId, title: logs()[0].title, connects: logs()[0].connects, status: logs()[0].status, source: logs()[0].source },
    { jobId: JOB, title: 'Build a Wordpress Website', connects: 14, status: 'applied', source: 'capture' }
  );
  assert.ok(!(`pc:${TAB}` in env.store), 'pending state cleared');
});

test('Cancel clears the pending send: leaving afterwards records nothing', async () => {
  await click();
  await handleApplyMessage({ action: 'applyCancelled' }, { tab: { id: TAB } });
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(sentEvents().length, 0);
  assert.equal(logs().length, 0);
});

test('a send that fails validation (page never leaves) records nothing', async () => {
  await click();
  await handleTabUpdated(TAB, { url: APPLY + '?refresh=1' });          // same apply page, e.g. query change
  await handleTabUpdated(TAB, { url: APPLY.replace('/apply/', '/apply/#cover') });
  await flush();
  assert.equal(sentEvents().length, 0);
  assert.ok(`pc:${TAB}` in env.store, 'still waiting: the member may fix the form and press Send again');
});

test('leaving too late (after 2 minutes) is not treated as a send', async () => {
  await click();
  env.store[`pc:${TAB}`].at = Date.now() - CONFIRM_WINDOW_MS - 1000;
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(sentEvents().length, 0);
  assert.ok(!(`pc:${TAB}` in env.store), 'expired state is discarded');
});

test('closing the tab discards the pending send', async () => {
  await click();
  await handleTabRemoved(TAB);
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(sentEvents().length, 0);
});

test('navigation in a tab with no pending send is ignored', async () => {
  await handleTabUpdated(99, { url: DONE });
  await handleTabUpdated(99, { status: 'loading' });
  await flush();
  assert.equal(sentEvents().length, 0);
});

test('pressing Send twice keeps only the latest form contents', async () => {
  await click(form({ coverLetter: 'first draft' }));
  await click(form({ coverLetter: 'fixed version' }));
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(sentEvents().length, 1);
  assert.equal(sentEvents()[0].payload.coverLetter, 'fixed version');
});

test('tabs are tracked independently', async () => {
  await handleApplyMessage({ action: 'applySendClicked', data: form({ coverLetter: 'A' }) }, { tab: { id: 1 } });
  await handleApplyMessage({ action: 'applySendClicked', data: form({ jobId: '~022100000000000000001', coverLetter: 'B' }) }, { tab: { id: 2 } });
  await handleTabUpdated(2, { url: DONE });
  await flush();
  assert.deepEqual(sentEvents().map(e => e.payload.coverLetter), ['B']);
  assert.ok('pc:1' in env.store);
});

test('free tier: nothing is queued and the ROI Hub is untouched', async () => {
  delete env.store.connection;
  await click();
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(env.calls.length, 0);
  assert.equal(Object.keys(env.store).filter(k => k.startsWith('ob:')).length, 0);
  assert.equal(logs().length, 0);
});

test('a message without a job id, or from a non-tab sender, is ignored', async () => {
  await handleApplyMessage({ action: 'applySendClicked', data: { title: 'x' } }, { tab: { id: TAB } });
  await handleApplyMessage({ action: 'applySendClicked', data: form() }, {});
  assert.deepEqual(Object.keys(env.store).filter(k => k.startsWith('pc:')), []);
});

test('an entry the member already logged for this job is enriched, not duplicated', async () => {
  env.store.logs = [
    { id: 'old', title: 'Manual title', connects: 10, boost: 'none', status: 'interviewing', jobId: JOB, scoreSnapshot: { inputs: {}, score: { total: 70 } } },
    { id: 'other', title: 'Another job', connects: 8, boost: 'none', status: 'applied', jobId: '~0221999999999999' }
  ];
  await click(form({ connectsTotal: 16, boostRank: 2 }));
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(logs().length, 2);
  const mine = logs().find(l => l.jobId === JOB);
  assert.equal(mine.id, 'old');
  assert.equal(mine.title, 'Manual title');
  assert.equal(mine.status, 'interviewing', 'status is never regressed');
  assert.equal(mine.connects, 16);
  assert.equal(mine.boost, 'rank2');
  assert.deepEqual(mine.scoreSnapshot.score, { total: 70 }, 'the original score snapshot is kept');
});

test('the score snapshot from scanning the job is attached, with the job age at apply time', async () => {
  const seenAt = Date.now() - 30 * 60_000;                       // scanned 30 minutes ago
  env.store.scoredIndex = {
    [JOB]: { at: seenAt, sig: 's', seenAt, snapshot: { inputs: { jobAgeHours: 0.25, connectsNeeded: 14 }, score: { total: 78, verdict: 'Apply' } } }
  };
  await click();
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  const e = sentEvents()[0];
  assert.equal(e.payload.scoreSnapshot.score.total, 78);
  assert.ok(Math.abs(e.payload.jobAgeHoursAtApply - 0.75) < 0.02, `age at apply ~0.75h, got ${e.payload.jobAgeHoursAtApply}`);
  assert.equal(e.scoringVersion, '1');
});

test('without a scan there is no snapshot and no age, and the payload has no nulls', async () => {
  await click(form({ duration: undefined }));
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  const p = sentEvents()[0].payload;
  assert.ok(!('scoreSnapshot' in p) && !('jobAgeHoursAtApply' in p) && !('duration' in p));
  assert.ok(Object.values(p).every(v => v !== null && v !== undefined));
});

test('hourly agency proposals keep the hourly rate, questions and boost', () => {
  const p = buildCapturedProposalPayload(form({
    contractType: 'hourly', bidAmount: undefined, hourlyRate: 20, youReceive: 18, applyAs: 'agency:EXEVE Global',
    connectsRequired: 20, connectsBoost: 5, connectsTotal: undefined, boostRank: 3,
    questions: [{ question: 'Q1', answer: 'A1' }]
  }), undefined, Date.UTC(2026, 9, 3, 12));
  assert.equal(p.connectsTotal, 25, 'total falls back to required + boost');
  assert.deepEqual(
    [p.contractType, p.hourlyRate, p.applyAs, p.boostRank, p.questions.length, p.submittedAt],
    ['hourly', 20, 'agency:EXEVE Global', 3, 1, '2026-10-03T12:00:00.000Z']
  );
  assert.ok(!('bidAmount' in p));
});

const { readDiag } = await import('../diag.js');
const kinds = async () => (await readDiag()).map(d => d.kind);

test('a boosted proposal is recorded with the job cost, the bid and the total', async () => {
  await click(form({ connectsRequired: 20, connectsBoost: 9, connectsTotal: 29, boostRank: 3 }));
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  const ev = sentEvents().find(e => e.type === 'proposal.submitted');
  assert.deepEqual([ev.payload.connectsRequired, ev.payload.connectsBoost, ev.payload.connectsTotal, ev.payload.boostRank], [20, 9, 29, 3]);
  assert.equal(logs()[0].connects, 29);
  assert.ok((await kinds()).includes('apply.recorded'));
  assert.ok(!(await kinds()).includes('apply.connects_unclear'));
});

test('numbers that do not add up, or a missing total, are noted in diagnostics', async () => {
  await click(form({ connectsRequired: 20, connectsBoost: 9, connectsTotal: 20 }));
  await handleTabRemoved(TAB);
  assert.ok((await kinds()).includes('apply.connects_unclear'));
  const f = form({ connectsRequired: 20 }); delete f.connectsTotal; delete f.connectsBoost;
  await click(f);
  assert.equal((await readDiag()).filter(d => d.kind === 'apply.connects_unclear').length, 2);
});

test('closing the tab right after Send records nothing but says why', async () => {
  await click();
  await handleTabRemoved(TAB);
  await flush();
  assert.equal(sentEvents().filter(e => e.type === 'proposal.submitted').length, 0);
  const dropped = (await readDiag()).find(d => d.kind === 'apply.dropped');
  assert.equal(dropped.detail.reason, 'tab_closed');
});

test('leaving the apply page long after Send is dropped and noted', async () => {
  await click();
  const pc = env.store[`pc:${TAB}`]; pc.at -= CONFIRM_WINDOW_MS + 5000; env.store[`pc:${TAB}`] = pc;
  await handleTabUpdated(TAB, { url: DONE });
  await flush();
  assert.equal(sentEvents().filter(e => e.type === 'proposal.submitted').length, 0);
  assert.equal((await readDiag()).find(d => d.kind === 'apply.dropped').detail.reason, 'left_too_late');
});
