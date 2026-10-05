// proposals-check.js - "Look at your proposals at least every 3 days", and the reminder when that lapses.
//
// The extension never opens, loads or clicks anything on Upwork by itself. Statuses are read from the
// Proposals page while the MEMBER has it open (proposals-scan.js). This module only remembers when that
// last happened and decides whether to ask the member to do it again. The reminder is a badge on the
// toolbar icon and a banner in the side panel; its button opens the page on the member's own click.

import { enqueue } from './outbox.js';
import { visibleLogs } from './logs.js';

export const CHECK_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
const SETTLE_MS = 24 * 60 * 60 * 1000;     // a proposal sent in the last day may not be in the lists yet
const HEARTBEAT_MS = 30 * 60 * 1000;       // tell the engine at most this often per list
const OPEN = new Set(['applied', 'viewed', 'replied', 'interviewing']);

export const PROPOSALS_URL = 'https://www.upwork.com/nx/proposals/';
export const ARCHIVED_URL = 'https://www.upwork.com/nx/proposals/archived';

const openLogs = (logs) => logs.filter(l => l.jobId && OPEN.has(l.status));

/**
 * What the member should be asked to do now, or null.
 *   archive: proposals we track dropped off the Active list, so Upwork has closed them: look at Archived
 *   stale:   open proposals exist and the Active list has not been looked at for 3 days
 * `check` = { activeAt, archivedAt, missingJobIds } from recordCheck.
 */
export function computeNudge(logs, check = {}, now = Date.now()) {
  const open = openLogs(logs);
  if (!open.length) return null;

  const missing = open.filter(l => (check.missingJobIds || []).includes(l.jobId));
  if (missing.length && (check.archivedAt || 0) < (check.activeAt || 0)) {
    return { kind: 'archive', count: missing.length, url: ARCHIVED_URL, titles: missing.slice(0, 3).map(l => l.title || 'Untitled'), more: Math.max(0, missing.length - 3) };
  }

  // Never checked: the clock starts when the oldest open proposal was sent, so a brand-new one is not nagged about
  const since = check.activeAt ?? Math.min(...open.map(l => Date.parse(l.submittedAt) || now));
  if (now - since >= CHECK_EVERY_MS) {
    return { kind: 'stale', count: open.length, days: Math.floor((now - since) / 86_400_000), url: PROPOSALS_URL, never: check.activeAt === undefined };
  }
  return null;
}

/**
 * Records that the member looked at a list. `matchedJobIds` = our proposals that list showed.
 * From the Active list we learn which open proposals are gone from it (sent before the last day).
 */
export function applyCheck(check = {}, { page, matchedJobIds, logs, now }) {
  const next = { ...check };
  if (page === 'archived') {
    next.archivedAt = now;
    next.missingJobIds = (check.missingJobIds || []).filter(id => !matchedJobIds.includes(id));
  } else {
    next.activeAt = now;
    next.missingJobIds = openLogs(logs)
      .filter(l => !matchedJobIds.includes(l.jobId) && now - (Date.parse(l.submittedAt) || now) > SETTLE_MS)
      .map(l => l.jobId);
  }
  return next;
}

/** Stores the check, tells the engine (rate limited) and refreshes the reminder. */
export async function recordCheck({ page, rowCount, matchedJobIds, logs, now = Date.now() }) {
  const { proposalsCheck = {} } = await chrome.storage.local.get('proposalsCheck');
  const next = applyCheck(proposalsCheck, { page, matchedJobIds, logs, now });

  const key = page === 'archived' ? 'archivedBeatAt' : 'activeBeatAt';
  if (!next[key] || now - next[key] >= HEARTBEAT_MS) {
    const queued = await enqueue('proposals.checked', { page, rows: Math.min(rowCount, 1000), matched: Math.min(matchedJobIds.length, 1000) });
    if (queued) next[key] = now;
  }
  await chrome.storage.local.set({ proposalsCheck: next });
  await refreshNudge(logs, now);
}

/** Re-evaluates the reminder and mirrors it to the toolbar badge. Safe to call any time. */
export async function refreshNudge(logsArg, now = Date.now()) {
  const data = await chrome.storage.local.get(['logs', 'proposalsCheck', 'connection']);
  // only the connected member's proposals count (the same browser may have been used by someone else before)
  const mine = data.connection ? (logsArg ?? visibleLogs(data.logs ?? [], data.connection.member.id)) : [];
  const nudge = data.connection ? computeNudge(mine, data.proposalsCheck || {}, now) : null;
  await chrome.storage.local.set({ nudge });
  try {
    await chrome.action.setBadgeText({ text: nudge ? '!' : '' });
    if (nudge) await chrome.action.setBadgeBackgroundColor({ color: '#FE4C1C' });
  } catch { /* no action API (tests) */ }
  return nudge;
}
