// logs.js - ROI Hub history in chrome.storage.local["logs"].
// Written from both the side panel and the service worker (apply capture), so every change is a
// fresh read-modify-write instead of overwriting from a stale in-memory copy.

export async function updateLogs(mutator) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const next = mutator(logs) ?? logs;
  await chrome.storage.local.set({ logs: next });
  return next;
}

/**
 * Adds a proposal captured from Upwork's apply page to the ROI Hub, or enriches the entry the
 * member already logged for the same job (never a duplicate).
 */
/** What the total was made of, as read from Upwork's summary: the job's own cost and the bid. */
const splitOf = (payload) => ({
  ...(payload.connectsRequired !== undefined && { connectsJob: payload.connectsRequired }),
  ...(payload.connectsBoost !== undefined && { connectsBid: payload.connectsBoost })
});

/** "29 connects (20 job + 9 bid)" when the split is known, else "29 connects". */
export function connectsLabel(log) {
  const base = `${log.connects} connects`;
  return log.connectsBid > 0 && log.connectsJob !== undefined ? `${base} (${log.connectsJob} job + ${log.connectsBid} bid)` : base;
}

export function upsertCapturedLog(payload) {
  const connects = payload.connectsTotal ?? 0;
  const boost = payload.boostRank ? `rank${payload.boostRank}` : 'none';

  return updateLogs((logs) => {
    const existing = logs.find(l => l.jobId === payload.jobId);
    if (existing) {
      const nextBoost = payload.boostRank ? boost : existing.boost;
      const nextConnects = payload.connectsTotal ?? existing.connects;
      // Capture disagrees with what is already recorded (e.g. typed by hand): keep the earlier values
      if (nextConnects !== existing.connects || nextBoost !== existing.boost) {
        existing.revisions = [...(existing.revisions || []), {
          at: new Date().toISOString(), source: existing.source === 'capture' ? 'capture' : 'manual',
          connects: existing.connects, boost: existing.boost, status: existing.status
        }].slice(-MAX_REVISIONS);
      }
      Object.assign(existing, {
        connects: nextConnects,
        boost: nextBoost,
        ...splitOf(payload),
        jobUrl: payload.jobUrl ?? existing.jobUrl,
        scoreSnapshot: existing.scoreSnapshot ?? payload.scoreSnapshot,
        source: 'capture'
      });
      return logs;
    }
    return [{
      id: Date.now().toString(),
      date: new Date(payload.submittedAt).toLocaleDateString(),
      submittedAt: payload.submittedAt,
      title: payload.title || 'Untitled job',
      connects,
      boost,
      status: 'applied',
      jobId: payload.jobId,
      jobUrl: payload.jobUrl,
      scoreSnapshot: payload.scoreSnapshot,
      ...splitOf(payload),
      source: 'capture'
    }, ...logs];
  });
}

const MAX_REVISIONS = 20;
const TRACKED = ['connects', 'boost', 'status'];

/**
 * Adds a hand-logged proposal to the ROI Hub without duplicating one that exists for the same job.
 *   - no entry for the job yet           -> created
 *   - an entry exists, same values       -> unchanged (nothing is added or sent)
 *   - an entry exists, values differ     -> the entry takes the hand-entered values, and what it held
 *     before (e.g. what was auto-tracked from the apply page) is kept in `revisions`
 * Entries without a job id are always separate. Returns { logs, action, log }.
 */
export function applyManualLog(logs, entry, now = Date.now()) {
  const existing = entry.jobId ? logs.find(l => l.jobId === entry.jobId) : null;
  if (!existing) return { logs: [entry, ...logs], action: 'created', log: entry };

  if (TRACKED.every(k => existing[k] === entry[k])) return { logs, action: 'unchanged', log: existing };

  const revisions = [...(existing.revisions || []), {
    at: new Date(now).toISOString(),
    source: existing.source === 'capture' ? 'capture' : 'manual',
    connects: existing.connects, boost: existing.boost, status: existing.status
  }].slice(-MAX_REVISIONS);

  Object.assign(existing, { connects: entry.connects, boost: entry.boost, status: entry.status, source: 'manual', revisions });
  if (entry.connects !== revisions[revisions.length - 1].connects) { delete existing.connectsJob; delete existing.connectsBid; }
  return { logs, action: 'overridden', log: existing };
}

/** Storage-backed applyManualLog (fresh read-modify-write, like every other log change). */
export async function recordManualLog(entry) {
  let result;
  await updateLogs((logs) => { result = applyManualLog(logs, entry); return result.logs; });
  return result;
}

const REPLIED_OR_BEYOND = new Set(['replied', 'interviewing', 'hired']);
const INTERVIEW_OR_BEYOND = new Set(['interviewing', 'hired']);

/** Numbers for the ROI Hub header. A client reply is a response even before an interview. */
export function roiCounts(logs) {
  const total = logs.length;
  const interviews = logs.filter(l => INTERVIEW_OR_BEYOND.has(l.status)).length;
  const responded = logs.filter(l => REPLIED_OR_BEYOND.has(l.status)).length;
  return {
    proposals: total,
    connects: logs.reduce((sum, l) => sum + (Number.isFinite(l.connects) ? l.connects : 0), 0),
    interviews,
    responseRatePct: total > 0 ? Math.round((responded / total) * 100) : 0
  };
}

/** Titles compare equal regardless of case, punctuation and spacing (also used to match Upwork's list rows). */
export const normalizeTitle = (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The one synced proposal (it has a job id) whose title equals `title`, or null. Used when a hand entry
 * is not linked to a job: if it is clearly about a proposal already logged it updates that one instead of
 * creating an on-device copy that would never reach the dashboard. Two matches or none: null.
 */
export function findLoggedByTitle(logs, title) {
  const key = normalizeTitle(title);
  if (!key) return null;
  const matches = logs.filter(l => l.jobId && normalizeTitle(l.title) === key);
  return matches.length === 1 ? matches[0] : null;
}
