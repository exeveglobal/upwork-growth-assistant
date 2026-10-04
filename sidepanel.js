// sidepanel.js - Controller for Upwork Growth Assistant Side Panel

import {
  calculateROIScore,
  SCORING_VERSION,
  getConnectsTier,
  logError,
  getErrorLog,
  clearErrorLog
} from './utils.js';
import {
  getConnection,
  getConnectionLost,
  connectWithCode,
  disconnect,
  verifyConnection
} from './connection.js';
import { enqueue, flush } from './outbox.js';
import { updateLogs } from './logs.js';
import { readDiag, formatDiag, clearDiag } from './diag.js';
import {
  buildScoreSnapshot,
  toCanonicalStatus,
  boostRankNumber
} from './tracking.js';

// State
let currentScrapedJob = null;
let appSettings = {};      // { niche, rate, bio } - local only
let connection = null;     // stored connection (Connected tier) or null (Free tier)
let currentRoi = null;     // ROI result for currentScrapedJob
let pendingLogJob = null;  // job the ROI Hub form is linked to: { jobId, jobUrl, title, scoreSnapshot }
let proposalLogs = [];

// DOM Elements
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");
const tierBadge = document.getElementById("tier-badge");
const connectionBanner = document.getElementById("connection-banner");
const connectionBannerText = document.getElementById("connection-banner-text");
const btnBannerConnect = document.getElementById("btn-banner-connect");
const freeNotice = document.getElementById("free-notice");
const btnFreeConnect = document.getElementById("btn-free-connect");
const roiLocked = document.getElementById("roi-locked");
const roiContent = document.getElementById("roi-content");
const btnLockConnect = document.getElementById("btn-lock-connect");
const btnLogJob = document.getElementById("btn-log-job");
const logLinked = document.getElementById("log-linked");
const logLinkedTitle = document.getElementById("log-linked-title");
const btnUnlinkJob = document.getElementById("btn-unlink-job");
const logSyncHint = document.getElementById("log-sync-hint");

// Settings Elements
const settingsNicheInput = document.getElementById("settings-niche");
const settingsRateInput = document.getElementById("settings-rate");
const settingsBioInput = document.getElementById("settings-bio");
const saveSettingsBtn = document.getElementById("btn-save-settings");
const saveStatusMsg = document.getElementById("save-status-msg");

// Connection Elements
const connConnected = document.getElementById("conn-connected");
const connForm = document.getElementById("conn-form");
const connMemberName = document.getElementById("conn-member-name");
const connConsent = document.getElementById("conn-consent");
const connCodeInput = document.getElementById("conn-code");
const btnConnect = document.getElementById("btn-connect");
const connSpinner = document.getElementById("conn-spinner");
const connError = document.getElementById("conn-error");
const btnDisconnect = document.getElementById("btn-disconnect");

// Analyzer Elements
const jobPageStatus = document.getElementById("job-page-status");
const jobDetailsCard = document.getElementById("job-details-card");
const scrapedJobTitle = document.getElementById("scraped-job-title");
const scrapedJobConnects = document.getElementById("scraped-job-connects");
const scrapedJobCountry = document.getElementById("scraped-job-country");
const roiScoreCard = document.getElementById("roi-score-card");
const roiProgressRing = document.getElementById("roi-progress");
const roiNumber = document.getElementById("roi-number");
const roiLabel = document.getElementById("roi-label");
const roiReasonsList = document.getElementById("roi-reasons-list");
const aiComingSoonCard = document.getElementById("ai-coming-soon-card");
const btnReloadJob = document.getElementById("btn-reload-job");
const analyzerFallback = document.getElementById("analyzer-fallback");

// ROI Hub Elements
const statTotalConnects = document.getElementById("stat-total-connects");
const statTotalProposals = document.getElementById("stat-total-proposals");
const statTotalInterviews = document.getElementById("stat-total-interviews");
const statConversion = document.getElementById("stat-conversion");
const proposalLogForm = document.getElementById("proposal-log-form");
const logTitleInput = document.getElementById("log-title");
const logConnectsInput = document.getElementById("log-connects");
const logBoostSelect = document.getElementById("log-boost");
const logStatusSelect = document.getElementById("log-status");
const historyContainer = document.getElementById("history-container");
const btnClearHistory = document.getElementById("btn-clear-history");

// Error Log Elements
const errorLogContainer = document.getElementById("error-log-container");
const btnClearErrorLog = document.getElementById("btn-clear-error-log");

const CONNECTION_RECHECK_MS = 5 * 60 * 1000;

// Auto-scanner tracking variables
let lastPageIdentifier = "";
let scanInProgress = false;

// Initialize Extension Sidepanel
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadProposalLogs();
  setupTabs();
  setupSettingsUI();
  setupConnectionUI();
  setupROILogger();
  setupErrorLog();

  // Tier first (instant, from storage), then confirm the token with the engine in the background
  await refreshTier();
  flush().catch(() => {});
  verifyConnection().catch(err => logError('sidepanel → verifyConnection', err.message, '', err.stack));
  setInterval(() => verifyConnection().catch(() => {}), CONNECTION_RECHECK_MS);

  // Set initial UI state — show fallback, hide all result cards
  showFallbackUI();
  await scanActivePage();

  // Setup periodic SPA scanner (every 1.5s) to detect drawer openings or navigation changes
  setInterval(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes("upwork.com")) {
        chrome.tabs.sendMessage(tab.id, { action: "checkPageIdentifier" }, (response) => {
          if (chrome.runtime.lastError) {
            // content script not ready yet, skip auto-check
            return;
          }
          if (response && response.success && response.identifier) {
            const id = response.identifier;

            if (lastPageIdentifier === "__tab_switch__") {
              // onActivated already started a scan — just settle the identifier
              lastPageIdentifier = id;
              return;
            }
            if (id !== lastPageIdentifier) {
              lastPageIdentifier = id;
              clearCachedUI();
              // Delay scan to let the SPA finish rendering new content
              setTimeout(() => scanActivePage(), 800);
            }
          }
        });
      } else {
        if (lastPageIdentifier !== "not-upwork") {
          lastPageIdentifier = "not-upwork";
          showFallbackUI();
        }
      }
    } catch (err) {
      logError('sidepanel → auto-scan interval', err.message, '', err.stack);
    }
  }, 1500);

  // Re-scan when the user switches browser tabs.
  // Use a sentinel so the 1.5s polling absorbs the identifier update
  // without triggering a second scan on top of this one.
  chrome.tabs.onActivated.addListener(() => {
    lastPageIdentifier = "__tab_switch__";
    clearCachedUI();
    setTimeout(() => scanActivePage(), 800);
  });

  // Manual Scan Buttons
  if (btnReloadJob) btnReloadJob.addEventListener("click", () => {
    clearCachedUI();
    scanActivePage();
  });
});

// Resets UI to "scanning" state — job header card stays visible so the user sees the
// transition animation; ROI and proposal cards are hidden until new results arrive.
// showFallbackUI() is called later only if the scan returns no job data.
function clearCachedUI() {
  scanInProgress = false;

  // Show scanning state in job header card
  jobDetailsCard.classList.remove("hide");
  analyzerFallback.classList.add("hide");
  jobPageStatus.className = "status-alert info";
  jobPageStatus.querySelector(".status-text").textContent = "Scanning job post...";

  scrapedJobTitle.textContent = "Scanning page...";
  scrapedJobConnects.textContent = "...";

  const clientEl = document.getElementById("scraped-job-client");
  if (clientEl) { clientEl.textContent = ""; clientEl.classList.add("hide"); }
  if (scrapedJobCountry) scrapedJobCountry.classList.add("hide");

  // Hide ROI and proposal cards so stale data isn't visible during the scan
  roiScoreCard.classList.add("hide");
  aiComingSoonCard.classList.add("hide");

  updateROIRadial(0, "#eab308");
  roiLabel.textContent = "Scanning...";
  roiLabel.style.backgroundColor = "#eab308";
  roiReasonsList.innerHTML = '<div class="reason-row reason-neutral">Auditing client statistics...</div>';
}

// Setup Tabs Navigation
function setupTabs() {
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetPanel = btn.getAttribute("data-tab");
      
      // Update buttons active class
      tabButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      // Update panels active class
      tabPanels.forEach(panel => {
        if (panel.id === targetPanel) {
          panel.classList.add("active");
        } else {
          panel.classList.remove("active");
        }
      });
    });
  });
}

// Scans current page via content.js DOM scraper
async function scanActivePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url || !tab.url.includes("upwork.com")) {
      showFallbackUI();
      return;
    }
    
    // Try sending message to content script
    sendMessageToContentScript(tab.id, { action: "scrapePage" });
  } catch (error) {
    logError('sidepanel → scanActivePage', error.message, '', error.stack);
  }
}

// Sends message to content script, with programmatic injection recovery and load-retry logic.
// scanInProgress prevents parallel retry chains from running simultaneously.
function sendMessageToContentScript(tabId, message, retryCount = 0) {
  if (retryCount === 0) {
    if (scanInProgress) return;
    scanInProgress = true;
  }

  chrome.tabs.sendMessage(tabId, message, async (response) => {
    if (chrome.runtime.lastError) {
      const injected = await injectContentScript(tabId);
      if (injected) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, message, (retryRes) => {
            scanInProgress = false;
            if (retryRes && retryRes.success) {
              handleScrapeResult(retryRes.data);
            } else {
              console.error("Failed to scrape after programmatic injection.");
            }
          });
        }, 300);
      } else {
        scanInProgress = false;
        showFallbackUI();
      }
      return;
    }

    if (response && response.success) {
      // nojob is a clean terminal state — no retry, just show fallback quietly
      if (response.data.type === 'nojob') {
        scanInProgress = false;
        showFallbackUI();
        return;
      }
      if (!response.data.isLoaded && retryCount < 3) {
        setTimeout(() => sendMessageToContentScript(tabId, message, retryCount + 1), 700);
        return;
      }
      scanInProgress = false;
      handleScrapeResult(response.data);
    } else {
      scanInProgress = false;
      showFallbackUI();
      // Genuine unexpected scrape failure — log it
      const errMsg = response?.error || 'Unknown scraping error';
      logError('sidepanel → sendMessageToContentScript', errMsg, '');
    }
  });
}

// Script Injector Utility
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    });
    return true;
  } catch (err) {
    console.error("Script injection failed:", err);
    return false;
  }
}

// Routes scraped DOM data to specific tabs UI
function handleScrapeResult(data) {
  if (data.type === "job") {
    currentScrapedJob = data;

    // Display job card info
    scrapedJobTitle.textContent = data.title;

    if (data.connectsNeeded !== null && data.connectsNeeded !== undefined) {
      const tier = getConnectsTier(data.connectsNeeded);
      scrapedJobConnects.textContent = `${data.connectsNeeded} Connects (${tier})`;
    } else {
      scrapedJobConnects.textContent = "Connects: Loading...";
    }

    // Display Client Name if found
    const clientEl = document.getElementById("scraped-job-client");
    if (clientEl) {
      if (data.clientName) {
        clientEl.textContent = `Client: ${data.clientName}`;
        clientEl.classList.remove("hide");
      } else {
        clientEl.classList.add("hide");
      }
    }

    // Display Country
    if (scrapedJobCountry) {
      if (data.clientCountry && data.clientCountry !== "Unknown") {
        scrapedJobCountry.textContent = data.clientCountry;
        scrapedJobCountry.classList.remove("hide");
      } else {
        scrapedJobCountry.classList.add("hide");
      }
    }

    jobPageStatus.className = "status-alert success";
    jobPageStatus.querySelector(".status-text").textContent = "Upwork Job Details Scraped!";
    
    jobDetailsCard.classList.remove("hide");
    aiComingSoonCard.classList.remove("hide");
    analyzerFallback.classList.add("hide");
    
    // Process ROI Score
    roiReasonsList.innerHTML = "";

    // Job already filled — skip scoring, show notice
    if (data.hiresCount !== null && data.hiresCount > 0) {
      updateROIRadial(0, "#6b7280");
      roiLabel.textContent = "Filled";
      roiLabel.style.backgroundColor = "#374151";
      roiReasonsList.innerHTML = `
        <div class="job-filled-notice">
          <div class="filled-icon">✓</div>
          <div class="filled-text">
            <strong>Position already filled</strong>
            <p>${data.hiresCount} hire${data.hiresCount > 1 ? "s" : ""} made — your proposal is unlikely to be reviewed.</p>
          </div>
        </div>`;
      currentRoi = null;
      updateLogJobButton();
      roiScoreCard.classList.remove("hide");
      return;
    }

    const roi = calculateROIScore(data);
    currentRoi = roi;
    updateLogJobButton();
    trackJobScored(data);
    updateROIRadial(roi.score, roi.color);
    roiLabel.textContent = roi.label;
    roiLabel.style.backgroundColor = roi.color;

    // Render interactive bucket breakdown
    let currentUl = null;

    roi.reasons.forEach(reason => {
      if (reason.startsWith("──")) {
        const m = reason.match(/── (.+?):\s*(\d+)\/100/);
        const label = m ? m[1] : reason.replace(/──\s*/, "");
        const score = m ? parseInt(m[2]) : null;

        const details = document.createElement("details");
        details.open = true;
        details.classList.add("bucket-section");

        const summary = document.createElement("summary");
        summary.classList.add("bucket-summary");

        const labelSpan = document.createElement("span");
        labelSpan.classList.add("bucket-label");
        labelSpan.textContent = label;
        summary.appendChild(labelSpan);

        if (score !== null) {
          const sw = document.createElement("span");
          sw.classList.add("bucket-score-wrap");
          const bar = document.createElement("div");
          bar.classList.add("bucket-score-bar");
          const fill = document.createElement("div");
          fill.classList.add("bucket-score-fill");
          fill.style.width = score + "%";
          fill.style.backgroundColor = score >= 70 ? "#10b981" : score >= 45 ? "#eab308" : "#ef4444";
          bar.appendChild(fill);
          sw.appendChild(bar);
          const num = document.createElement("span");
          num.classList.add("bucket-score-num");
          num.textContent = score;
          sw.appendChild(num);
          summary.appendChild(sw);
        }

        details.appendChild(summary);
        const ul = document.createElement("ul");
        ul.classList.add("bucket-items");
        details.appendChild(ul);

        roiReasonsList.appendChild(details);
        currentUl = ul;

      } else {
        if (currentUl) {
          const li = document.createElement("li");
          li.textContent = reason;
          if (reason.startsWith("+"))      li.classList.add("reason-positive");
          else if (reason.startsWith("-")) li.classList.add("reason-negative");
          else                             li.classList.add("reason-neutral");
          currentUl.appendChild(li);
        } else {
          const row = document.createElement("div");
          row.classList.add("reason-row");
          row.textContent = reason;
          if (reason.startsWith("+"))      row.classList.add("reason-positive");
          else if (reason.startsWith("-")) row.classList.add("reason-negative");
          else                             row.classList.add("reason-neutral");
          roiReasonsList.appendChild(row);
        }
      }
    });

    roiScoreCard.classList.remove("hide");
  }
  // Profile pages are ignored for now: the Profile Optimizer is coming soon.
}

// Fallback panels utility
function showFallbackUI() {
  currentScrapedJob = null;
  currentRoi = null;
  updateLogJobButton();
  jobPageStatus.className = "status-alert info";
  jobPageStatus.querySelector(".status-text").textContent = "Detecting active Upwork job post...";
  jobDetailsCard.classList.add("hide");
  roiScoreCard.classList.add("hide");
  aiComingSoonCard.classList.add("hide");
  analyzerFallback.classList.remove("hide");
}

// Progress Ring Math
function updateROIRadial(score, color) {
  roiNumber.textContent = score;
  const radius = 34;
  const circumference = 2 * Math.PI * radius; // ~213.62
  
  // Calculate offset
  const offset = circumference - (score / 100) * circumference;
  
  roiProgressRing.style.strokeDasharray = `${circumference} ${circumference}`;
  roiProgressRing.style.strokeDashoffset = offset;
  roiProgressRing.style.stroke = color;
}

// Professional context settings (local only)
function setupSettingsUI() {
  saveSettingsBtn.addEventListener("click", async () => {
    appSettings = {
      niche: settingsNicheInput.value.trim(),
      rate: settingsRateInput.value.trim(),
      bio: settingsBioInput.value.trim()
    };
    await chrome.storage.local.set({ settings: appSettings });

    saveStatusMsg.textContent = "Saved!";
    saveStatusMsg.style.color = "var(--accent-green)";
    setTimeout(() => {
      saveStatusMsg.textContent = "";
    }, 3000);
  });
}

// Loads saved settings. Older versions stored AI provider keys and a license key here; those
// no longer exist (AI will run on the server), so strip them from storage.
async function loadSettings() {
  const data = await chrome.storage.local.get(["settings"]);
  const stored = data.settings || {};
  const { niche = "", rate = "", bio = "" } = stored;
  appSettings = { niche, rate, bio };

  if (Object.keys(stored).some(k => !(k in appSettings))) {
    await chrome.storage.local.set({ settings: appSettings });
  }

  settingsNicheInput.value = niche;
  settingsRateInput.value = rate;
  settingsBioInput.value = bio;
}

// ─── Connection & tier ────────────────────────────────────────────────────────

const CONNECT_ERRORS = {
  invalid_code: "That key isn't valid, has expired, or was already used. Ask your admin for a new one.",
  member_disabled: "Your access is disabled. Please contact your Exeve admin.",
  device_limit: "This key's account has reached its device limit. Ask your admin to remove an old device.",
  too_many_attempts: "Too many attempts. Wait a minute and try again.",
  invalid_request: "Please check the key and try again.",
  network: "Can't reach the Exeve server. Check your internet connection and try again."
};

const LOST_MESSAGES = {
  member_disabled: "Your Exeve access was disabled. Contact your admin.",
  default: "This device was disconnected. Enter your access key to keep tracking."
};

// Re-reads the stored connection and updates everything that depends on the tier.
async function refreshTier() {
  connection = await getConnection();
  const connected = !!connection;

  tierBadge.textContent = connected ? "Connected" : "Free";
  tierBadge.className = `badge ${connected ? "connected" : "free-tier"}`;
  tierBadge.title = connected ? `Connected as ${connection.member.name}` : "Free mode: job scoring only";

  freeNotice.classList.toggle("hide", connected);
  roiLocked.classList.toggle("hide", connected);
  roiContent.classList.toggle("hide", !connected);
  connConnected.classList.toggle("hide", !connected);
  connForm.classList.toggle("hide", connected);
  if (connected) connMemberName.textContent = connection.member.name;
  updateLogJobButton();

  // Pushes the member back to the connect screen when the engine ended their connection
  const lost = connected ? null : await getConnectionLost();
  connectionBanner.classList.toggle("hide", !lost);
  if (lost) connectionBannerText.textContent = LOST_MESSAGES[lost.reason] || LOST_MESSAGES.default;
}

function goToConnect() {
  switchTab("settings-tab");
  connCodeInput.focus();
}

function setupConnectionUI() {
  // Any change to the stored connection (connect, disconnect, 401 from any tab) refreshes the UI
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.connection || changes.connectionLost)) refreshTier();
  });

  [btnBannerConnect, btnFreeConnect, btnLockConnect].forEach(b => b.addEventListener("click", goToConnect));

  const showConnError = (msg) => {
    connError.textContent = msg;
    connError.classList.remove("hide");
  };

  btnConnect.addEventListener("click", async () => {
    connError.classList.add("hide");
    if (!connConsent.checked) return showConnError("Please read and accept the notice above to connect.");
    if (!connCodeInput.value.trim()) return showConnError("Enter the access key from your Exeve admin.");

    btnConnect.disabled = true;
    connSpinner.classList.remove("hide");
    try {
      const res = await connectWithCode(connCodeInput.value);
      if (res.ok) {
        connCodeInput.value = "";
        connConsent.checked = false;
        await refreshTier();
        flush().catch(() => {});
      } else {
        showConnError(CONNECT_ERRORS[res.reason] || "Couldn't connect. Please try again or contact your admin.");
      }
    } catch (err) {
      logError("sidepanel → connect", err.message, "", err.stack);
      showConnError(CONNECT_ERRORS.network);
    } finally {
      btnConnect.disabled = false;
      connSpinner.classList.add("hide");
    }
  });

  btnDisconnect.addEventListener("click", async () => {
    if (confirm("Disconnect this device? Tracking stops until you connect again with a new key.")) {
      await disconnect();
      await refreshTier();
    }
  });
}

// ─── Tracking (Connected tier): events go through the offline outbox ──────────

// Records a scanned job with its score inputs, at most once per change / 30 minutes. The latest
// snapshot is always kept locally so a later apply-page capture can attach "the score as it was".
// The service worker is the single writer of the score snapshot (job-scored.js); job pages also
// push what they scrape on their own, so this only covers a scan the member triggered here.
function trackJobScored(job) {
  try {
    chrome.runtime.sendMessage({ action: "jobScraped", job }).catch(() => {});
  } catch (err) {
    logError("sidepanel → trackJobScored", err.message, "", err.stack);
  }
}

async function trackProposalSubmitted(log) {
  try {
    if (!log.jobId) return; // not linked to a job: stays local
    const boostRank = boostRankNumber(log.boost);
    await enqueue("proposal.submitted", {
      jobId: log.jobId,
      jobUrl: log.jobUrl || undefined,
      title: log.title.slice(0, 300),
      submittedAt: log.submittedAt,
      source: "manual",
      status: toCanonicalStatus(log.status),
      connectsTotal: Number.isFinite(log.connects) ? log.connects : undefined,
      ...(boostRank && { boostRank }),
      scoreSnapshot: log.scoreSnapshot
    }, { occurredAt: log.submittedAt, scoringVersion: SCORING_VERSION });
  } catch (err) {
    logError("sidepanel → trackProposalSubmitted", err.message, "", err.stack);
  }
}

async function trackStatusChanged(log) {
  try {
    if (!log.jobId) return;
    await enqueue("proposal.status_changed", {
      jobId: log.jobId,
      to: toCanonicalStatus(log.status),
      source: "manual",
      changedAt: new Date().toISOString()
    });
  } catch (err) {
    logError("sidepanel → trackStatusChanged", err.message, "", err.stack);
  }
}

// "Log proposal" button on the job card: only for a scored, identifiable job while Connected
function updateLogJobButton() {
  const show = !!(connection && currentScrapedJob && currentScrapedJob.jobId && currentRoi);
  btnLogJob.classList.toggle("hide", !show);
}

function updateLogLinkUI() {
  logLinked.classList.toggle("hide", !pendingLogJob);
  if (pendingLogJob) logLinkedTitle.textContent = pendingLogJob.title;
  logSyncHint.textContent = pendingLogJob
    ? "This proposal will sync to Exeve."
    : "Not linked to a job, so it stays on this device. Use \"Log proposal\" on a scanned job to sync it.";
}

// Switch active tab by panel ID
function switchTab(panelId) {
  const btn = document.querySelector(`.tab-btn[data-tab="${panelId}"]`);
  if (btn) btn.click();
}

// ROI Hub Tracker Log Functions
function setupROILogger() {
  proposalLogForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const linked = pendingLogJob;
    const newLog = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString(),
      submittedAt: new Date().toISOString(),
      title: logTitleInput.value.trim(),
      connects: parseInt(logConnectsInput.value, 10),
      boost: logBoostSelect.value,
      status: logStatusSelect.value,
      // Linked entries carry the job id so they can sync; the score is frozen as it was when applying
      ...(linked && { jobId: linked.jobId, jobUrl: linked.jobUrl, scoreSnapshot: linked.scoreSnapshot })
    };

    proposalLogs = await updateLogs(logs => [newLog, ...logs]); // newest first
    trackProposalSubmitted(newLog);

    // Reset form fields
    logTitleInput.value = "";
    logConnectsInput.value = 16;
    logBoostSelect.value = "none";
    logStatusSelect.value = "applied";
    pendingLogJob = null;
    updateLogLinkUI();

    renderLogsList();
    updateROIStats();
  });

  btnLogJob.addEventListener("click", () => {
    if (!currentScrapedJob || !currentScrapedJob.jobId || !currentRoi) return;
    pendingLogJob = {
      jobId: currentScrapedJob.jobId,
      jobUrl: currentScrapedJob.jobUrl,
      title: currentScrapedJob.title,
      scoreSnapshot: buildScoreSnapshot(currentScrapedJob, currentRoi)
    };
    logTitleInput.value = currentScrapedJob.title;
    logConnectsInput.value = currentScrapedJob.connectsNeeded || 16;
    logBoostSelect.value = "none";
    logStatusSelect.value = "applied";
    updateLogLinkUI();
    switchTab("roi-tab");
    logTitleInput.focus();
  });

  // Proposals captured from Upwork's apply page are written by the service worker
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.logs) {
      proposalLogs = changes.logs.newValue || [];
      renderLogsList();
      updateROIStats();
    }
  });

  btnUnlinkJob.addEventListener("click", () => {
    pendingLogJob = null;
    updateLogLinkUI();
  });
  updateLogLinkUI();

  btnClearHistory.addEventListener("click", async () => {
    if (confirm("Are you sure you want to delete all proposal tracking logs? This cannot be undone.")) {
      proposalLogs = await updateLogs(() => []);
      renderLogsList();
      updateROIStats();
    }
  });
}

// Load logs database
async function loadProposalLogs() {
  const data = await chrome.storage.local.get(["logs"]);
  if (data.logs) {
    proposalLogs = data.logs;
  }
  renderLogsList();
  updateROIStats();
}

function updateROIStats() {
  const totalProposals = proposalLogs.length;
  let totalConnects = 0;
  let totalInterviews = 0;
  
  proposalLogs.forEach(log => {
    totalConnects += log.connects;
    if (log.status === "interviewing" || log.status === "hired") {
      totalInterviews += 1;
    }
  });

  statTotalConnects.textContent = totalConnects;
  statTotalProposals.textContent = totalProposals;
  statTotalInterviews.textContent = totalInterviews;
  
  const conversionRate = totalProposals > 0 ? Math.round((totalInterviews / totalProposals) * 100) : 0;
  statConversion.textContent = `${conversionRate}%`;
}

function renderLogsList() {
  if (proposalLogs.length === 0) {
    historyContainer.innerHTML = `
      <p class="empty-list-message">No proposals logged yet. Run analyses and click 'Log to ROI Hub' to record your bidding data.</p>
    `;
    return;
  }

  historyContainer.innerHTML = "";
  proposalLogs.forEach(log => {
    const item = document.createElement("div");
    item.className = "history-item";
    
    let boostLabel = "";
    if (log.boost !== "none") {
      boostLabel = ` | Boost: ${log.boost.replace("rank", "Rank ")}`;
    }

    item.innerHTML = `
      <div class="history-item-details">
        <div class="history-item-title" title="${escapeHtml(log.title)}">${escapeHtml(log.title)}</div>
        <div class="history-item-sub">
          <span>${log.date}</span>
          <span class="spent">-${log.connects} connects${boostLabel}</span>
          <span>•</span>
          <span class="status-badge ${escapeHtml(log.status)}">${escapeHtml(log.status)}</span>
          ${log.jobId ? "" : '<span class="local-only-tag" title="Not linked to a job, so it stays on this device. Use \'Log proposal\' on a scanned job to sync.">local only</span>'}
        </div>
      </div>
      <button class="btn-delete-log" data-id="${log.id}">×</button>
    `;
    
    // Status click cycle toggle
    const badge = item.querySelector(".status-badge");
    badge.addEventListener("click", () => cycleLogStatus(log.id));
    badge.style.cursor = "pointer";

    // Bind delete listener
    item.querySelector(".btn-delete-log").addEventListener("click", () => deleteLog(log.id));
    
    historyContainer.appendChild(item);
  });
}

async function cycleLogStatus(id) {
  const statusCycle = ["applied", "interviewing", "hired", "rejected"];
  let changed = null;

  proposalLogs = await updateLogs(logs => {
    const log = logs.find(l => l.id === id);
    if (!log) return logs;
    log.status = statusCycle[(statusCycle.indexOf(log.status) + 1) % statusCycle.length];
    changed = log;
    return logs;
  });
  if (changed) trackStatusChanged(changed);

  renderLogsList();
  updateROIStats();
}

async function deleteLog(id) {
  proposalLogs = await updateLogs(logs => logs.filter(l => l.id !== id));
  renderLogsList();
  updateROIStats();
}

// ─── Error Log UI ─────────────────────────────────────────────────────────────

function setupErrorLog() {
  const btnCopyDiag = document.getElementById("btn-copy-diag");
  if (btnCopyDiag) {
    btnCopyDiag.addEventListener("click", async () => {
      try {
        const entries = await readDiag();
        await navigator.clipboard.writeText(formatDiag(entries, chrome.runtime.getManifest().version));
        btnCopyDiag.textContent = entries.length ? `Copied ${entries.length}` : "Nothing to copy";
        setTimeout(() => { btnCopyDiag.textContent = "Copy diagnostics"; }, 2000);
      } catch (err) {
        logError("sidepanel → copy diagnostics", err.message, "", err.stack);
      }
    });
  }
  if (btnClearErrorLog) {
    btnClearErrorLog.addEventListener("click", async () => {
      if (confirm("Clear all error logs?")) {
        await clearErrorLog();
        await clearDiag();
        renderErrorLog([]);
      }
    });
  }
  loadErrorLog();
}

async function loadErrorLog() {
  const logs = await getErrorLog();
  renderErrorLog(logs);
}

function renderErrorLog(logs) {
  if (!errorLogContainer) return;

  if (logs.length === 0) {
    errorLogContainer.innerHTML = '<p class="empty-list-message">No errors logged. All systems running smoothly.</p>';
    return;
  }

  // Most recent first, cap at 20 entries in the UI
  const recent = [...logs].reverse().slice(0, 20);
  errorLogContainer.innerHTML = recent.map(entry => {
    const date = new Date(entry.ts).toLocaleString();
    return `
      <div class="error-log-entry">
        <div class="error-log-meta">
          <span class="error-log-context">${escapeHtml(entry.context)}</span>
          <span class="error-log-time">${date}</span>
        </div>
        <div class="error-log-message">${escapeHtml(entry.message)}</div>
        ${entry.url ? `<div class="error-log-url">${escapeHtml(entry.url)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
