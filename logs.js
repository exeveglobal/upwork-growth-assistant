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
  return { logs, action: 'overridden', log: existing };
}

/** Storage-backed applyManualLog (fresh read-modify-write, like every other log change). */
export async function recordManualLog(entry) {
  let result;
  await updateLogs((logs) => { result = applyManualLog(logs, entry); return result.logs; });
  return result;
}
