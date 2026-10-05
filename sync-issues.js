// sync-issues.js - Makes a failed sync visible instead of silent.
//
// The outbox sends events in the background. When the engine accepts one, any earlier "not synced" mark on
// that proposal is cleared; when it REFUSES one (e.g. the proposal is not in this member's account), the
// reason goes to the diagnostics log and the proposal's ROI Hub row is marked "not synced".

import { logDiag } from './diag.js';
import { markSyncIssue } from './logs.js';

const PROPOSAL_EVENTS = new Set(['proposal.submitted', 'proposal.status_changed']);

export async function noteSyncResult(event, memberId, result) {
  try {
    if (result.status === 'rejected') {
      await logDiag('sync.rejected', { type: event.type, error: String(result.error || 'unknown').slice(0, 80) });
      if (PROPOSAL_EVENTS.has(event.type)) await markSyncIssue(event.payload?.jobId, memberId, String(result.error || 'rejected').slice(0, 80));
    } else if (PROPOSAL_EVENTS.has(event.type)) {
      await markSyncIssue(event.payload?.jobId, memberId, null);
    }
  } catch { /* reporting must never block sending */ }
}
