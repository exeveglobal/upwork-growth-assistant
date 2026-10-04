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
      Object.assign(existing, {
        connects: payload.connectsTotal ?? existing.connects,
        boost: payload.boostRank ? boost : existing.boost,
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
