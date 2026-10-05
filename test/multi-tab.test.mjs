import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, acceptAll } from './fake-chrome.mjs';

// Several tabs and windows open on Upwork at once: the service worker is the single writer and
// everything keyed by tab or job must stay separate and consistent.
const env = installChrome();
const { handleJobScraped } = await import('../job-scored.js');
const { handleApplyMessage, handleTabUpdated, handleTabRemoved } = await import('../capture.js');
const { handleProposalsRows } = await import('../proposals-sync.js');
const { flush } = await import('../outbox.js');

const J1 = '~022106746859492424699';
const J2 = '~022106913092829653024';
const job = (jobId, over = {}) => ({
  type: 'job', isLoaded: true, jobId, title: 'T', description: 'x'.repeat(80), isHourly: true, jobAgeHours: 1,
  connectsNeeded: 14, proposalRangeText: '10 to 15', interviewingCount: 0, invitesSent: 0, unansweredInvites: 0,
  hiresCount: null, clientLastViewedHours: 1, clientCountry: 'US', isPaymentVerified: true, rating: 4.9, reviewsCount: 10,
  hireRate: 80, totalSpend: '10K', activeJobsCount: 1, avgRatePaid: '$20/hr', ...over
});
const form = (jobId, over = {}) => ({ jobId, title: 'Job ' + jobId.slice(-4), applyAs: 'freelancer', connectsRequired: 14, connectsBoost: 0, connectsTotal: 14, contractType: 'hourly', hourlyRate: 20, coverLetter: 'Hi', ...over });
const sent = (type) => env.calls.flatMap(c => c.body?.events ?? []).filter(e => !type || e.type === type);
const click = (tabId, data) => handleApplyMessage({ action: 'applySendClicked', data }, { tab: { id: tabId } });
const DONE = 'https://www.upwork.com/nx/proposals/123456789';

beforeEach(() => { env.reset(); env.connect('m1', 'tok'); env.responder = acceptAll; });

test('the same job open in two tabs or windows at once is recorded once', async () => {
  await Promise.all([handleJobScraped(job(J1)), handleJobScraped(job(J1)), handleJobScraped(job(J1))]);
  await flush();
  assert.equal(sent('job.scored').length, 1);
  assert.deepEqual(Object.keys(env.store.scoredIndex), [J1]);
});

test('seen again later from another window: the newer values win and the change is sent', async () => {
  const t0 = 1_000_000;
  await handleJobScraped(job(J1, { proposalRangeText: '10 to 15' }), t0);
  await handleJobScraped(job(J1, { proposalRangeText: '50+', interviewingCount: 3 }), t0 + 6 * 3_600_000);
  await flush();
  const entry = env.store.scoredIndex[J1];
  assert.equal(entry.snapshot.inputs.proposalRangeText, '50+');
  assert.equal(entry.seenAt, t0 + 6 * 3_600_000);
  assert.equal(sent('job.scored').length, 2);
});

test('a page left open for a long time is not recorded as a fresh sighting', async () => {
  assert.equal(await handleJobScraped(job(J1, { stalePage: true, pageAgeMin: 300 })), null);
  assert.equal(env.store.scoredIndex, undefined);
  await flush();
  assert.equal(sent().length, 0);
});

test('different jobs in different tabs keep separate state; closing one tab does not drop the other', async () => {
  await handleJobScraped(job(J1)); await handleJobScraped(job(J2));
  await click(11, form(J1)); await click(22, form(J2));
  assert.ok(env.store['pc:11'] && env.store['pc:22']);
  await handleTabRemoved(11);                       // tab 11 closed right after Send
  assert.equal(env.store['pc:11'], undefined);
  assert.ok(env.store['pc:22'], 'the other tab is untouched');
  await handleTabUpdated(22, { url: DONE });        // tab 22 moves on: recorded
  await flush();
  const jobs = sent('proposal.submitted').map(e => e.payload.jobId);
  assert.deepEqual(jobs, [J2]);
  assert.equal(env.store.logs.length, 1);
});

test('the same apply page sent from two tabs gives one ROI Hub entry and no false revision', async () => {
  await handleJobScraped(job(J1));
  await click(11, form(J1)); await click(12, form(J1));
  await Promise.all([handleTabUpdated(11, { url: DONE }), handleTabUpdated(12, { url: DONE })]);
  await flush();
  assert.equal(env.store.logs.length, 1);
  assert.equal(env.store.logs[0].revisions, undefined);
  assert.equal(env.store.logs[0].connects, 14);
});

test('two tabs on the Proposals page report the same rows: one status change, one heartbeat', async () => {
  env.store.logs = [{ id: 'l1', jobId: J1, title: 'Website redesign', submittedAt: new Date(2026, 9, 3, 12).toISOString(), status: 'applied', connects: 14, boost: 'none' }];
  const NOW = new Date(2026, 9, 3, 15).getTime();
  const row = { proposalId: '2096409461684633601', title: 'Website redesign', initiated: 'Initiated Oct 3, 2026', reason: 'Hired', section: 'archived' };
  await Promise.all([handleProposalsRows([row], NOW, 'archived'), handleProposalsRows([row], NOW, 'archived')]);
  await flush();
  assert.equal(sent('proposal.status_changed').length, 1);
  assert.equal(sent('proposals.checked').length, 1);
  assert.equal(env.store.logs[0].status, 'hired');
});
