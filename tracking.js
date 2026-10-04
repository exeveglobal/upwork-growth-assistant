// tracking.js - Pure helpers that turn scraped/scored data into engine event payloads.
// Shapes are defined by docs/DATA-CONTRACT.md and validated strictly by the engine.

const DESCRIPTION_MAX = 8000;
const TITLE_MAX = 300;

// ROI Hub's local statuses -> canonical engine statuses
const LOCAL_TO_CANONICAL = {
  applied: 'submitted',
  viewed: 'viewed',
  interviewing: 'interviewing',
  hired: 'hired',
  rejected: 'declined',
  withdrawn: 'withdrawn',
  archived: 'archived'
};
const CANONICAL_TO_LOCAL = Object.fromEntries(Object.entries(LOCAL_TO_CANONICAL).map(([l, c]) => [c, l]));

export const toCanonicalStatus = (local) => LOCAL_TO_CANONICAL[local] || 'submitted';
export const toLocalStatus = (canonical) => CANONICAL_TO_LOCAL[canonical] || null;

// "rank2" -> 2; anything else -> undefined (no boost)
export function boostRankNumber(boost) {
  const m = /^rank([1-4])$/.exec(boost || '');
  return m ? Number(m[1]) : undefined;
}

const orNull = (v) => (v === undefined || v === '' || Number.isNaN(v) ? null : v);
const cleanText = (v, bad = []) => (typeof v === 'string' && v && !bad.includes(v) ? v : null);

/** The values the ROI scorer looked at, frozen at scoring time (live Upwork numbers drift). */
export function buildScoreInputs(job) {
  return {
    isHourly: orNull(job.isHourly),
    budget: cleanText(job.budget),
    jobAgeHours: orNull(job.jobAgeHours),
    connectsNeeded: orNull(job.connectsNeeded),
    proposalRangeText: cleanText(job.proposalRangeText),
    interviewingCount: orNull(job.interviewingCount),
    invitesSent: orNull(job.invitesSent),
    unansweredInvites: orNull(job.unansweredInvites),
    hiresCount: orNull(job.hiresCount),
    clientLastViewedHours: orNull(job.clientLastViewedHours),
    client: {
      country: cleanText(job.clientCountry, ['Unknown']),
      isPaymentVerified: orNull(job.isPaymentVerified),
      rating: orNull(job.rating),
      reviewsCount: orNull(job.reviewsCount),
      hireRate: orNull(job.hireRate),
      totalSpend: cleanText(job.totalSpend),
      activeJobsCount: orNull(job.activeJobsCount),
      avgRatePaid: cleanText(job.avgRatePaid, ['N/A'])
    }
  };
}

export function buildScore(roi) {
  return {
    total: roi.score,
    verdict: roi.label,
    bucketA: roi.buckets.A,
    bucketB: roi.buckets.B,
    bucketC: roi.buckets.C,
    paymentMultiplier: roi.paymentMultiplier,
    connectsModifier: roi.connectsModifier
  };
}

/** Attached to a proposal so the score "as it was when applying" can be reviewed later. */
export function buildScoreSnapshot(job, roi) {
  return { inputs: buildScoreInputs(job), score: buildScore(roi) };
}

export function buildJobScoredPayload(job, roi) {
  return {
    jobId: job.jobId,
    jobUrl: job.jobUrl || undefined,
    title: (job.title || '').slice(0, TITLE_MAX),
    description: job.description ? job.description.slice(0, DESCRIPTION_MAX) : undefined,
    ...buildScoreInputs(job),
    score: buildScore(roi)
  };
}

/** Changes whenever something worth re-recording changes. */
export function scoreSignature(job, roi) {
  return [roi.score, job.proposalRangeText, job.interviewingCount, job.connectsNeeded, job.invitesSent].join('|');
}

const RESCORE_AFTER_MS = 30 * 60 * 1000;

/** Record a job when first seen, when its score inputs changed, or at most every 30 minutes. */
export function shouldEmitJobScored(prev, now, signature) {
  if (!prev) return true;
  if (prev.sig !== signature) return true;
  return now - prev.at >= RESCORE_AFTER_MS;
}

const round2 = (n) => Math.round(n * 100) / 100;
const stripEmpty = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));

/**
 * proposal.submitted payload for a proposal read from Upwork's apply page.
 * `data` = apply-capture.js readForm() result; `scored` = the stored { snapshot, seenAt } for this
 * job from when the member last scanned it (so the score "as it was when applying" is kept).
 */
export function buildCapturedProposalPayload(data, scored, appliedAtMs) {
  const snapshot = scored?.snapshot;
  const seenAge = snapshot?.inputs?.jobAgeHours;
  const jobAgeHoursAtApply = typeof seenAge === 'number' && scored.seenAt
    ? round2(seenAge + Math.max(0, appliedAtMs - scored.seenAt) / 3_600_000)
    : undefined;

  return stripEmpty({
    jobId: data.jobId,
    jobUrl: `https://www.upwork.com/jobs/${data.jobId}`,
    title: data.title ? data.title.slice(0, TITLE_MAX) : undefined,
    submittedAt: new Date(appliedAtMs).toISOString(),
    source: 'capture',
    applyAs: data.applyAs,
    connectsTotal: data.connectsTotal ?? (data.connectsRequired !== undefined ? data.connectsRequired + (data.connectsBoost || 0) : undefined),
    connectsBoost: data.connectsBoost,
    boostRank: data.boostRank,
    connectsRequired: data.connectsRequired,
    connectsAvailableBefore: data.connectsAvailableBefore,
    connectsRemainingAfter: data.connectsRemainingAfter,
    contractType: data.contractType,
    bidAmount: data.bidAmount,
    hourlyRate: data.hourlyRate,
    youReceive: data.youReceive,
    serviceFeePct: data.serviceFeePct,
    duration: data.duration,
    coverLetter: data.coverLetter,
    questions: data.questions,
    scoreSnapshot: snapshot,
    jobAgeHoursAtApply,
    confirmation: 'navigated'
  });
}
