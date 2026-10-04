import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

const env = installChrome();
const { handleJobScraped } = await import('../job-scored.js');
const { handleApplyMessage, handleTabUpdated } = await import('../capture.js');
const { flush } = await import('../outbox.js');
const { logDiag, readDiag } = await import('../diag.js');

const ID = '~022106746859492424699';
const job = (over = {}) => ({
  type: 'job', isLoaded: true, jobId: ID, jobUrl: `https://www.upwork.com/jobs/${ID}`,
  title: 'Elementor Specialist', description: 'x'.repeat(80), isHourly: true, budget: '$20 – $40/hr',
  jobAgeHours: 1, connectsNeeded: 14, proposalRangeText: '50+', interviewingCount: 1, invitesSent: 0,
  unansweredInvites: 0, hiresCount: null, clientLastViewedHours: 0.03, clientCountry: 'Colombia',
  isPaymentVerified: true, rating: 5, reviewsCount: 40, hireRate: 95, totalSpend: '66K', activeJobsCount: 1,
  avgRatePaid: '$22/hr', ...over
});
const sent = () => env.calls.flatMap(c => c.body?.events ?? []);

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

test('a loaded job is scored, snapshotted and queued as job.scored', async () => {
  const roi = await handleJobScraped(job());
  assert.ok(roi && typeof roi.score === 'number');
  await flush();
  const [ev] = sent();
  assert.equal(ev.type, 'job.scored');
  assert.equal(ev.payload.jobId, ID);
  const snap = env.store.scoredIndex[ID].snapshot;
  assert.equal(snap.inputs.isHourly, true);
  assert.equal(snap.inputs.connectsNeeded, 14);
  assert.equal(snap.score.total, roi.score);
});

test('free tier, unloaded and id-less jobs record nothing', async () => {
  delete env.store.connection;
  assert.equal(await handleJobScraped(job()), null);
  env.connect('m1', 'tok');
  assert.equal(await handleJobScraped(job({ isLoaded: false })), null);
  assert.equal(await handleJobScraped(job({ jobId: null })), null);
  assert.equal(env.store.scoredIndex, undefined);
  await flush();
  assert.equal(sent().length, 0);
});

test('the same job pushed repeatedly is queued once; a changed signal queues again', async () => {
  await handleJobScraped(job());
  await handleJobScraped(job());
  await flush();
  assert.equal(sent().length, 1);
  await handleJobScraped(job({ proposalRangeText: '20 to 50' }));
  await flush();
  assert.equal(sent().length, 2);
});

test('concurrent pushes from different tabs never lose a job', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `~02210000000000000${String(i).padStart(4, '0')}`);
  await Promise.all(ids.map(jobId => handleJobScraped(job({ jobId }))));
  assert.deepEqual(Object.keys(env.store.scoredIndex).sort(), [...ids].sort());
});

test('score taken in one tab is attached when applying from another tab after the first closed', async () => {
  await handleJobScraped(job());
  const APPLY = `https://www.upwork.com/nx/proposals/job/${ID}/apply/`;
  const data = {
    jobId: ID, title: 'Elementor Specialist', applyAs: 'agency:EXEVE Global', connectsRequired: 14, connectsBoost: 6,
    connectsTotal: 20, boostRank: 2, contractType: 'hourly', hourlyRate: 30, youReceive: 27, coverLetter: 'Hi'
  };
  await handleApplyMessage({ action: 'applySendClicked', data }, { tab: { id: 99 } });
  await handleTabUpdated(99, { url: 'https://www.upwork.com/nx/proposals/123456789' });
  await flush();
  const ev = sent().find(e => e.type === 'proposal.submitted');
  assert.equal(ev.payload.contractType, 'hourly');
  assert.equal(ev.payload.hourlyRate, 30);
  assert.equal(ev.payload.connectsTotal, 20);
  assert.equal(ev.payload.connectsBoost, 6);
  assert.equal(ev.payload.scoreSnapshot.inputs.isHourly, true);
  assert.ok(ev.payload.scoreSnapshot.score.total >= 0);
  assert.ok(ev.payload.jobAgeHoursAtApply >= 1);
});

test('a fixed-price proposal carries payment mode and milestones', async () => {
  await handleJobScraped(job({ isHourly: false, budget: '$500' }));
  const data = {
    jobId: ID, title: 'T', contractType: 'fixed', bidAmount: 500, paymentMode: 'milestone',
    milestones: [{ description: 'Design', amount: 200 }, { description: 'Build', amount: 300, dueDate: 'Nov 1' }],
    connectsRequired: 14, connectsTotal: 14
  };
  await handleApplyMessage({ action: 'applySendClicked', data }, { tab: { id: 5 } });
  await handleTabUpdated(5, { url: 'https://www.upwork.com/nx/proposals/1234567' });
  await flush();
  const ev = sent().find(e => e.type === 'proposal.submitted');
  assert.equal(ev.payload.paymentMode, 'milestone');
  assert.equal(ev.payload.milestones.length, 2);
  assert.equal(ev.payload.scoreSnapshot.inputs.isHourly, false);
});

test('applying to a never-scored job still records the proposal and notes it in diagnostics', async () => {
  const data = { jobId: ID, title: 'T', contractType: 'fixed', bidAmount: 90, unread: ['paymentMode'], connectsRequired: 10, connectsTotal: 10 };
  await handleApplyMessage({ action: 'applySendClicked', data }, { tab: { id: 6 } });
  await handleTabUpdated(6, { url: 'https://www.upwork.com/nx/proposals/7654321' });
  await flush();
  const ev = sent().find(e => e.type === 'proposal.submitted');
  assert.equal(ev.payload.scoreSnapshot, undefined);
  assert.equal(ev.payload.unread, undefined, 'diagnostic hints never go to the engine');
  const kinds = (await readDiag()).map(d => d.kind);
  assert.ok(kinds.includes('apply.no_score_snapshot') && kinds.includes('apply.unread_fields'));
});

test('diagnostics dedupe repeats within an hour and stay capped', async () => {
  const t = Date.now();
  await logDiag('x', { a: 1 }, t);
  await logDiag('x', { a: 1 }, t + 1000);
  let d = await readDiag();
  assert.equal(d.length, 1);
  assert.equal(d[0].count, 2);
  for (let i = 0; i < 230; i++) await logDiag('y', { i }, t);
  d = await readDiag();
  assert.equal(d.length, 200);
});
