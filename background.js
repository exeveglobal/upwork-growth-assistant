// Service worker for the Upwork Growth Assistant Chrome Extension

import { flush } from './outbox.js';
import { verifyConnection } from './connection.js';
import { handleApplyMessage, handleTabUpdated, handleTabRemoved } from './capture.js';
import { handleProposalsRows } from './proposals-sync.js';
import { handleJobScraped } from './job-scored.js';
import { logDiag } from './diag.js';
import { handleActivityTicks, flushActivity } from './activity-sync.js';
import { logError } from './utils.js';

const FLUSH_ALARM = 'outbox-flush';
const VERIFY_ALARM = 'verify-connection';
const ACTIVITY_ALARM = 'activity-flush';

chrome.runtime.onInstalled.addListener(() => {
  // Enable opening the side panel on clicking the extension icon
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => {
      console.log("Upwork Growth Assistant side panel behavior configured successfully.");
    })
    .catch((error) => {
      console.error("Error configuring side panel behavior:", error);
    });
});

// Retry unsent events every minute, and re-check the connection every 15 minutes even if the
// side panel is closed, so a revoked device stops quickly.
async function ensureAlarm(name, periodInMinutes) {
  if (!(await chrome.alarms.get(name))) chrome.alarms.create(name, { periodInMinutes });
}
ensureAlarm(FLUSH_ALARM, 1);
ensureAlarm(VERIFY_ALARM, 15);
ensureAlarm(ACTIVITY_ALARM, 5);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flush().catch(() => {});
  if (alarm.name === VERIFY_ALARM) verifyConnection().catch(() => {});
  if (alarm.name === ACTIVITY_ALARM) flushActivity().catch(() => {});
});

// Apply-page capture: the content script reports Send/Cancel clicks; tab navigation confirms a send.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.action === 'applySendClicked' || message?.action === 'applyCancelled') {
    handleApplyMessage(message, sender).catch((err) => logError('background → apply message', err.message, '', err.stack));
  } else if (message?.action === 'proposalsRows') {
    handleProposalsRows(message.rows).catch((err) => logError('background → proposals rows', err.message, '', err.stack));
  } else if (message?.action === 'jobScraped') {
    handleJobScraped(message.job).catch(() => {});
  } else if (message?.action === 'diag' && typeof message.kind === 'string') {
    logDiag(message.kind.slice(0, 60), message.detail && typeof message.detail === 'object' ? message.detail : {});
  } else if (message?.action === 'activityTicks') {
    handleActivityTicks(message).catch((err) => logError('background → activity', err.message, '', err.stack));
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  handleTabUpdated(tabId, changeInfo).catch((err) => logError('background → tab updated', err.message, '', err.stack));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  flush().catch(() => {});
});
