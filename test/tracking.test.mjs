import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCanonicalStatus, toLocalStatus, boostRankNumber, buildScoreInputs, buildScore,
  buildScoreSnapshot, buildJobScoredPayload, scoreSignature, shouldEmitJobScored
} from '../tracking.js';
import { calculateROIScore } from '../utils.js';

const job = {
  jobId: '~022106334687117392891',
  jobUrl: 'https://www.upwork.com/jobs/~022106334687117392891',
  title: 'WordPress Site Design Update',
  description: 'd'.repeat(9000),
  clientName: 'Jane',             // must never be sent
  rawText: 'secret page text',    // must never be sent
  clientCountry: 'New Zealand', rating: 5, hireRate: 80, totalSpend: '9K+', connectsNeeded: 14,
  isPaymentVerified: true, isHourly: false, budget: '$100', hiresCount: null, activeJobsCount: 1,
  avgRatePaid: 'N/A', reviewsCount: NaN, jobAgeHours: 0.2, clientLastViewedHours: null,
  interviewingCount: 0, invitesSent: 0, unansweredInvites: 0, proposalRangeText: '5 to 10', isLoaded: true
};

test('status mapping between ROI Hub and the engine is two-way for the known statuses', () => {
  assert.equal(toCanonicalStatus('applied'), 'submitted');
  assert.equal(toCanonicalStatus('rejected'), 'declined');
  assert.equal(toCanonicalStatus('hired'), 'hired');
  assert.equal(toCanonicalStatus('nonsense'), 'submitted');
  assert.equal(toLocalStatus('submitted'), 'applied');
  assert.equal(toLocalStatus('declined'), 'rejected');
  assert.equal(toLocalStatus('viewed'), 'viewed');
  assert.equal(toLocalStatus('archived'), 'archived');
  assert.equal(toLocalStatus('withdrawn'), 'withdrawn');
  assert.equal(toLocalStatus('nonsense'), null);
  assert.equal(toCanonicalStatus('archived'), 'archived');
});

test('boost position parsing', () => {
  assert.equal(boostRankNumber('rank3'), 3);
  assert.equal(boostRankNumber('none'), undefined);
  assert.equal(boostRankNumber('rank9'), undefined);
  assert.equal(boostRankNumber(undefined), undefined);
});

test('score inputs normalise scraper placeholders to null', () => {
  const i = buildScoreInputs({ ...job, clientCountry: 'Unknown', avgRatePaid: 'N/A', reviewsCount: NaN, budget: '' });
  assert.equal(i.client.country, null);
  assert.equal(i.client.avgRatePaid, null);
  assert.equal(i.client.reviewsCount, null);
  assert.equal(i.budget, null);
  assert.equal(i.client.hireRate, 80);
  assert.equal(i.client.isPaymentVerified, true);
});

test('job.scored payload carries the score, trims text, and leaks no private fields', () => {
  const roi = calculateROIScore(job);
  const p = buildJobScoredPayload(job, roi);
  assert.equal(p.jobId, job.jobId);
  assert.equal(p.description.length, 8000);
  assert.deepEqual(p.score, buildScore(roi));
  assert.equal(p.score.total, roi.score);
  assert.equal(p.score.bucketA, roi.buckets.A);
  const text = JSON.stringify(p);
  assert.ok(!text.includes('Jane') && !text.includes('secret page text') && !text.includes('rawText') && !text.includes('clientName'));
  assert.ok(!('isLoaded' in p));
});

test('score snapshot = inputs + score only', () => {
  const roi = calculateROIScore(job);
  const snap = buildScoreSnapshot(job, roi);
  assert.deepEqual(Object.keys(snap).sort(), ['inputs', 'score']);
  assert.equal(snap.inputs.connectsNeeded, 14);
});

test('re-record a job when first seen, when it changed, or after 30 minutes', () => {
  const roi = calculateROIScore(job);
  const sig = scoreSignature(job, roi);
  const now = 1_000_000_000;
  assert.equal(shouldEmitJobScored(undefined, now, sig), true);
  assert.equal(shouldEmitJobScored({ at: now - 1000, sig }, now, sig), false);
  assert.equal(shouldEmitJobScored({ at: now - 1000, sig: 'other' }, now, sig), true);
  assert.equal(shouldEmitJobScored({ at: now - 31 * 60_000, sig }, now, sig), true);

  const moved = scoreSignature({ ...job, proposalRangeText: '20 to 50' }, roi);
  assert.notEqual(moved, sig);
});

test('calculateROIScore exposes structured parts without changing the score', () => {
  const roi = calculateROIScore(job);
  assert.equal(typeof roi.score, 'number');
  assert.deepEqual(Object.keys(roi.buckets), ['A', 'B', 'C']);
  assert.equal(roi.paymentMultiplier, 1.1);
  assert.equal(roi.connectsModifier, 3);
});

test('a score rebuilt from its snapshot is identical to the original', async () => {
  const { buildScoreInputs, jobFromInputs } = await import('../tracking.js');
  const { calculateROIScore } = await import('../utils.js');
  const job = {
    isHourly: true, budget: '$20 – $40/hr', jobAgeHours: 2, connectsNeeded: 14, proposalRangeText: '10 to 15',
    interviewingCount: 1, invitesSent: 0, unansweredInvites: 0, hiresCount: null, clientLastViewedHours: 0.5,
    clientCountry: 'Colombia', isPaymentVerified: true, rating: 4.9, reviewsCount: 40, hireRate: 80, totalSpend: '66K',
    activeJobsCount: 1, avgRatePaid: '$22/hr'
  };
  const original = calculateROIScore(job);
  const rebuilt = calculateROIScore(jobFromInputs(buildScoreInputs(job)));
  assert.equal(rebuilt.score, original.score);
  assert.deepEqual(rebuilt.reasons, original.reasons);
  // missing client data survives the round trip too
  const sparse = { ...job, clientCountry: 'Unknown', avgRatePaid: 'N/A', rating: null, hireRate: null, totalSpend: null };
  assert.equal(calculateROIScore(jobFromInputs(buildScoreInputs(sparse))).score, calculateROIScore(sparse).score);
});

test('ageJob moves time forward and swaps in the Connects cost the apply page shows', async () => {
  const { ageJob } = await import('../tracking.js');
  const aged = ageJob({ jobAgeHours: 1, clientLastViewedHours: 0.1, connectsNeeded: 14, hireRate: 80, interviewingCount: null }, 3 * 3_600_000, 16);
  assert.equal(aged.jobAgeHours, 4);
  assert.equal(aged.clientLastViewedHours, 3.1);
  assert.equal(aged.connectsNeeded, 16);
  assert.equal(aged.hireRate, 80);
  assert.equal(ageJob({ jobAgeHours: null, clientLastViewedHours: null, connectsNeeded: 14 }, 1000).jobAgeHours, null, 'unknown stays unknown');
  assert.equal(ageJob({ jobAgeHours: 1, connectsNeeded: 14 }, 1000).connectsNeeded, 14, 'no live value keeps the saved one');
});
