// capture.js - Service-worker side of apply-page capture.
//
// apply-capture.js reports "Send clicked" with the form contents. We cannot see Upwork's
// success response, so a proposal counts as sent when the tab LEAVES the apply page within
// 2 minutes of the click and the member did not press Cancel. Step 6's Proposals-page check
// later verifies against Upwork's own list. State lives in storage, not memory, because the
// service worker can be stopped at any time.

import { enqueue } from './outbox.js';
import { SCORING_VERSION, logError } from './utils.js';
import { buildCapturedProposalPayload } from './tracking.js';
import { adoptLegacyLogs, upsertCapturedLog } from './logs.js';
import { getConnection } from './connection.js';
import { logDiag } from './diag.js';
import { refreshNudge } from './proposals-check.js';

export const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

const key = (tabId) => `pc:${tabId}`;
const APPLY_URL = /\/nx\/proposals\/job\/(~[0-9A-Za-z]{10,40})\/apply/;

export async function handleApplyMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) return;

  if (message.action === 'applySendClicked') {
    if (!message.data?.jobId) return;
    await chrome.storage.local.set({ [key(tabId)]: { data: message.data, at: Date.now() } });
    const { connectsRequired: req, connectsBoost: boost, connectsTotal: total } = message.data;
    await logDiag('apply.send_clicked', { required: req ?? null, boost: boost ?? null, total: total ?? null });
    // The three numbers should add up; when they do not (or one is missing) say so, so the cause can be found
    if (total === undefined || (req !== undefined && boost !== undefined && req + boost !== total)) {
      await logDiag('apply.connects_unclear', { required: req ?? null, boost: boost ?? null, total: total ?? null });
    }
  } else if (message.action === 'applyCancelled') {
    await chrome.storage.local.remove(key(tabId));
  }
}

export async function handleTabUpdated(tabId, changeInfo) {
  if (!changeInfo.url) return;
  const { [key(tabId)]: pending } = await chrome.storage.local.get(key(tabId));
  if (!pending) return;

  // Still the same apply page (query/hash changes, SPA re-renders): not a confirmation
  const still = APPLY_URL.exec(changeInfo.url);
  if (still && still[1] === pending.data.jobId) return;

  await chrome.storage.local.remove(key(tabId));
  if (Date.now() - pending.at > CONFIRM_WINDOW_MS) { // too late: the send probably failed and they wandered off
    await logDiag('apply.dropped', { reason: 'left_too_late', afterSec: Math.round((Date.now() - pending.at) / 1000) });
    return;
  }

  try {
    await recordCapturedProposal(pending.data, pending.at);
  } catch (err) {
    logError('capture → record', err.message, '', err.stack);
  }
}

/** A tab closed after Send was clicked but before the page moved on: nothing is recorded, but say so. */
export async function handleTabRemoved(tabId) {
  const { [key(tabId)]: pending } = await chrome.storage.local.get(key(tabId));
  if (!pending) return;
  await chrome.storage.local.remove(key(tabId));
  await logDiag('apply.dropped', { reason: 'tab_closed', afterSec: Math.round((Date.now() - pending.at) / 1000) });
}

async function recordCapturedProposal(data, at) {
  const { scoredIndex = {} } = await chrome.storage.local.get('scoredIndex');
  const scored = scoredIndex[data.jobId];
  const payload = buildCapturedProposalPayload(data, scored, at);
  if (data.unread) await logDiag('apply.unread_fields', { fields: data.unread });
  if (!scored) await logDiag('apply.no_score_snapshot', {}); // job was never scored before applying

  const queued = await enqueue('proposal.submitted', payload, {
    occurredAt: payload.submittedAt,
    ...(scored && { scoringVersion: SCORING_VERSION })
  });
  if (queued) {
    await logDiag('apply.recorded', { total: payload.connectsTotal ?? null, boost: payload.connectsBoost ?? null, scored: !!scored });
    const memberId = (await getConnection())?.member?.id;
    await adoptLegacyLogs(memberId);
    await upsertCapturedLog(payload, memberId); // Free tier records nothing
    await refreshNudge();
  }
}
