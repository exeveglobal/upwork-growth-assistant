// proposals-sync.js - Service-worker side of the Proposals-page reader.
//
// proposals-scan.js reports the rows the member is looking at. Upwork's rows carry no job id, so a
// row is matched to a proposal the extension already recorded (same normalised title, initiated
// within a day of when it was sent). Anything unmatched or ambiguous is ignored. A match both
// VERIFIES the proposal really exists on Upwork and updates its status.

import { getConnection } from './connection.js';
import { enqueue } from './outbox.js';
import { updateLogs } from './logs.js';
import { toCanonicalStatus, toLocalStatus } from './tracking.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** "Initiated Sep 6, 2026" -> local midnight of that day, or null. */
export function parseInitiated(text) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text || '');
  const month = m ? MONTHS[m[1].toLowerCase()] : undefined;
  return month === undefined ? null : new Date(Number(m[3]), month, Number(m[2]));
}

export const normalizeTitle = (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Canonical status a row implies, or null when the row can't be interpreted. */
export function statusFromRow(row) {
  switch (row.section) {
    case 'submitted': return 'submitted';
    case 'active': return 'interviewing';
    case 'archived': {
      const reason = (row.reason || '').trim();
      if (/^hired$/i.test(reason)) return 'hired';
      if (/declin/i.test(reason)) return 'declined';
      if (/withdr/i.test(reason)) return 'withdrawn';
      return 'archived'; // "Job is closed" and anything we haven't seen; the raw reason is kept
    }
    default: return null;
  }
}

const RANK = { submitted: 0, viewed: 1, interviewing: 2, hired: 3 };
const TERMINAL = new Set(['declined', 'withdrawn', 'archived']);

/**
 * The status to keep given what we have and what Upwork now shows. Never overrides "hired"; moves
 * forward through submitted -> viewed -> interviewing -> hired; archive states apply unless hired.
 */
export function nextStatus(local, scraped) {
  if (local === scraped || local === 'hired') return local;
  if (TERMINAL.has(scraped) || TERMINAL.has(local)) return scraped;
  return RANK[scraped] > RANK[local] ? scraped : local;
}

function findLog(logs, row, seen) {
  const known = seen[row.proposalId];
  if (known) return logs.find(l => l.jobId === known.jobId) || null;

  const day = parseInitiated(row.initiated);
  if (!day) return null;
  const title = normalizeTitle(row.title);
  const taken = new Set(Object.values(seen).map(s => s.jobId));
  const candidates = logs.filter(l =>
    l.jobId && !taken.has(l.jobId) && l.submittedAt && normalizeTitle(l.title) === title &&
    Math.abs(startOfDay(new Date(l.submittedAt)) - day.getTime()) <= DAY_MS
  );
  return candidates.length === 1 ? candidates[0] : null; // ambiguous or unknown: leave it alone
}

let chain = Promise.resolve();

/** Serialised: two reports in quick succession must not interleave their read-modify-write. */
export function handleProposalsRows(rows, now = Date.now()) {
  const run = chain.then(() => process(rows, now));
  chain = run.catch(() => {});
  return run;
}

async function process(rows, now) {
  if (!(await getConnection())) return { matched: 0 }; // Free tier reads nothing
  if (!Array.isArray(rows)) return { matched: 0 };

  const { proposalsSeen: seen = {} } = await chrome.storage.local.get('proposalsSeen');
  const { logs = [] } = await chrome.storage.local.get('logs');
  const newSeen = { ...seen };
  const localUpdates = {}; // jobId -> new local status
  let matched = 0;

  for (const row of rows.slice(0, 100)) {
    const scraped = statusFromRow(row);
    if (!scraped || !/^\d{6,30}$/.test(String(row.proposalId))) continue;
    const log = findLog(logs, row, newSeen);
    if (!log) continue;
    matched++;

    const prev = newSeen[row.proposalId];
    // Nothing new from Upwork since the last look: leave the proposal (and any manual override) alone
    if (prev && prev.status === scraped && prev.verified) continue;

    const local = toCanonicalStatus(localUpdates[log.jobId] ?? log.status);
    const target = nextStatus(local, scraped);

    const queued = await enqueue('proposal.status_changed', {
      jobId: log.jobId,
      to: target,
      source: 'scraped',
      changedAt: new Date(now).toISOString(),
      upworkProposalId: String(row.proposalId),
      ...(row.reason && { reason: row.reason.slice(0, 100) })
    });
    if (!queued) return { matched }; // disconnected mid-way

    if (target !== local) localUpdates[log.jobId] = toLocalStatus(target);
    newSeen[row.proposalId] = { jobId: log.jobId, status: scraped, verified: true };
  }

  await chrome.storage.local.set({ proposalsSeen: newSeen });
  if (Object.keys(localUpdates).length) {
    await updateLogs((all) => {
      for (const l of all) if (localUpdates[l.jobId]) l.status = localUpdates[l.jobId];
      return all;
    });
  }
  return { matched };
}
