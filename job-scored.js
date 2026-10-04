// job-scored.js - Service-worker side of job scoring: the ONE writer of chrome.storage "scoredIndex".
//
// Job pages (slider or full page) push what they scraped via content.js, whether or not the side
// panel is open; the side panel forwards what it scraped too. Everything is scored here with the
// same scorer, frozen into a snapshot ("the score and its inputs as they were when seen") and
// queued as job.scored. When the member later applies (possibly from another tab, after the job
// tab was closed) capture.js reads the snapshot back by job id. Writes are serialised so two tabs
// can never overwrite each other's read-modify-write.

import { getConnection } from './connection.js';
import { enqueue } from './outbox.js';
import { calculateROIScore, SCORING_VERSION, logError } from './utils.js';
import { buildJobScoredPayload, buildScoreSnapshot, scoreSignature, shouldEmitJobScored } from './tracking.js';

const MAX_INDEX = 200;
let chain = Promise.resolve();

/** Scores a scraped job and records it. Returns the roi (or null when the job isn't usable). */
export function handleJobScraped(job, now = Date.now()) {
  const run = chain.then(() => record(job, now));
  chain = run.catch(() => {});
  return run.catch((err) => { logError('job-scored → record', err.message, '', err.stack); return null; });
}

async function record(job, now) {
  if (!job || job.type !== 'job' || !job.isLoaded || !job.jobId) return null;
  if (!(await getConnection())) return null; // Free tier keeps nothing

  const roi = calculateROIScore(job);
  const { scoredIndex = {} } = await chrome.storage.local.get('scoredIndex');
  const prev = scoredIndex[job.jobId];
  const sig = scoreSignature(job, roi);
  const due = shouldEmitJobScored(prev, now, sig);

  if (due) await enqueue('job.scored', buildJobScoredPayload(job, roi), { scoringVersion: SCORING_VERSION });

  scoredIndex[job.jobId] = { at: due ? now : prev.at, sig, seenAt: now, snapshot: buildScoreSnapshot(job, roi) };
  const newest = Object.entries(scoredIndex).sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, MAX_INDEX);
  await chrome.storage.local.set({ scoredIndex: Object.fromEntries(newest) });
  return roi;
}
