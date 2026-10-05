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
import { updateLogs, recordManualLog, roiCounts, connectsLabel, findLoggedByTitle, visibleLogs, adoptLegacyLogs } from './logs.js';
import { scanDisplay, PARTIAL_AFTER_TICKS } from './scan-state.js';
import { refreshNudge } from './proposals-check.js';
import { readDiag, formatDiag, clearDiag } from './diag.js';
import {
  buildScoreSnapshot,
  jobFromInputs,
  ageJob,
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
// The ROI Hub only ever shows (and syncs) the connected member's proposals; see logs.js visibleLogs
const mine = (all) => visibleLogs(all || [], connection?.member?.id);

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

// A job view can be on screen long before Upwork has finished rendering it. Until it is complete we
// show "loading" (never a score built from half the data) and keep re-reading it.
let awaitingLoad = false;
let awaitingTicks = 0;

// Initialize Extension Sidepanel
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadProposalLogs();
  setupTabs();
  setupSettingsUI();
  setupConnectionUI();
  setupROILogger();
  setupErrorLog();

  setupCheckBanner();

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
      if (awaitingLoad && !scanInProgress) {
        awaitingTicks++;
        // every tick for the first ~15 s, then only now and then (e.g. a page that never shows Connects)
        if (awaitingTicks <= PARTIAL_AFTER_TICKS || awaitingTicks % 7 === 0) scanActivePage();
      }
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
  // Only this window's tab switches count: with several Chrome windows open, each has its own panel,
  // and working in another window must not clear this one.
  let myWindowId = null;
  chrome.windows.getCurrent().then(w => { myWindowId = w.id; }).catch(() => {});
  chrome.tabs.onActivated.addListener((info) => {
    if (myWindowId !== null && info.windowId !== myWindowId) return;
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

// "Open your Proposals page" reminder. The extension never opens Upwork pages by itself: this button
// opens the page on the member's own click, and the status is read while they look at it.
function setupCheckBanner() {
  const banner = document.getElementById("check-banner");
  const text = document.getElementById("check-banner-text");
  const button = document.getElementById("btn-check-open");
  const note = document.getElementById("check-banner-note");
  let url = null;

  const render = (nudge) => {
    banner.classList.toggle("hide", !nudge);
    if (!nudge) return;
    url = nudge.url;
    const n = nudge.count;
    const proposals = `${n} open proposal${n === 1 ? "" : "s"}`;
    if (nudge.kind === "archive") {
      text.textContent = `${n} proposal${n === 1 ? " has" : "s have"} left your Active list. Open Archived so their outcome can be recorded.`;
      button.textContent = "Open Archived";
      // Upwork pages the list 10 at a time and we never load pages for the member: say what to look for
      const names = (nudge.titles || []).map(t => `“${t}”`).join(", ");
      note.textContent = `Upwork shows 10 proposals per page, and only the page you have open is read. Look for ${names}${nudge.more ? ` and ${nudge.more} more` : ""}; if they are not listed, open the next page.`;
    } else {
      text.textContent = nudge.never
        ? `You have ${proposals}. Open your Proposals page so their status can be updated.`
        : `Your proposals haven't been checked for ${nudge.days} days (${proposals}). Open your Proposals page to update them.`;
      button.textContent = "Open Proposals";
      note.textContent = "Opening the page is enough: its statuses are read while you look. Nothing is clicked or sent for you.";
    }
  };

  button.addEventListener("click", () => { if (url) chrome.tabs.create({ url }); });
  chrome.storage.local.get("nudge").then(({ nudge }) => render(nudge || null));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.nudge) render(changes.nudge.newValue || null);
    // Logs or the connection changed (a proposal added, closed by hand, device disconnected)
    if (changes.logs || changes.connection || changes.proposalsCheck) refreshNudge().catch(() => {});
  });
  refreshNudge().catch(() => {});
}

// Resets UI to "scanning" state — job header card stays visible so the user sees the
// transition animation; ROI and proposal cards are hidden until new results arrive.
// showFallbackUI() is called later only if the scan returns no job data.
function clearCachedUI() {
  scanInProgress = false;
  awaitingLoad = false;
  awaitingTicks = 0;
  stopApplyWatch();

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
              handleScanData(retryRes.data);
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
      if (response.data.type === 'job' && !response.data.isLoaded) {
        if (retryCount < 3) {
          setTimeout(() => sendMessageToContentScript(tabId, message, retryCount + 1), 700);
          return;
        }
        scanInProgress = false;
        handleScanData(response.data);
        return;
      }
      scanInProgress = false;
      handleScanData(response.data);
    } else {
      scanInProgress = false;
      showFallbackUI();
      // Genuine unexpected scrape failure — log it
      const errMsg = response?.error || 'Unknown scraping error';
      logError('sidepanel → sendMessageToContentScript', errMsg, '');
    }
  });
}

// Decides what a scan result may show. A job that is not completely rendered never gets a score
// built from half the data: it shows "loading", the poll keeps re-reading it, and only after
// PARTIAL_AFTER_TICKS does it show what there is, clearly marked as incomplete.
function handleScanData(data) {
  const display = scanDisplay(data, awaitingTicks);
  if (display === "show") {
    awaitingLoad = false;
    awaitingTicks = 0;
    handleScrapeResult(data);
    return;
  }
  awaitingLoad = true;
  if (display === "partial") {
    handleScrapeResult(data);
    jobPageStatus.className = "status-alert info";
    jobPageStatus.querySelector(".status-text").textContent =
      "Some details weren't found on this page, so this score may be incomplete.";
  } else {
    showJobLoading(data);
  }
}

// The job is on screen but Upwork has not finished rendering it: say so, show no score
function showJobLoading(data) {
  currentScrapedJob = null;
  currentRoi = null;
  updateLogJobButton();
  jobDetailsCard.classList.remove("hide");
  analyzerFallback.classList.add("hide");
  roiScoreCard.classList.add("hide");
  aiComingSoonCard.classList.add("hide");
  scrapedJobTitle.textContent = data.title || "Loading job...";
  scrapedJobConnects.textContent = "...";
  scrapedJobCountry.classList.add("hide");
  jobPageStatus.className = "status-alert info";
  jobPageStatus.querySelector(".status-text").textContent = "Waiting for Upwork to finish loading this job...";
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
    jobPageStatus.querySelector(".status-text").textContent = data.stalePage
      ? `This page has been open for ${data.pageAgeMin} min, so its numbers may be old. Reload the job page for a fresh score.`
      : "Upwork Job Details Scraped!";
    
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
    renderRoiBreakdown(roi);
  }
  else if (data.type === "page") {
    showPageInfo(data);
  } else if (data.type === "profile") {
    showPageInfo({ kind: "profile" });
  }
}

// What each non-job Upwork page gets, instead of a placeholder score.
const PAGE_MESSAGES = {
  feed: { icon: "🔍", title: "Pick a job to score", text: "Click a job card in the feed or search results and its score appears here.", status: "Browsing jobs" },
  proposals: { icon: "📋", title: "Your proposals", text: "Proposal statuses are read from this page to keep your tracking up to date. Nothing else to do here.", status: "Proposals page" },
  profile: { icon: "👤", title: "Profile page", text: "The profile optimizer is coming soon.", status: "Profile page" },
  other: { icon: "🧭", title: "Nothing to score here", text: "Scores appear on job pages. Open a job from the feed or search results.", status: "Not a job page" },
  apply: { icon: "✍️", title: "This job wasn't scored", text: "Open the job from the feed or its job page once and the score will be kept for this proposal.", status: "Submitting a proposal" }
};

function showPageInfo(data) {
  awaitingLoad = false;
  awaitingTicks = 0;
  // The apply page shows the saved score for its job; only without one does it fall back to a message
  if (data.kind === "apply" && data.jobId) {
    showSavedScore(data.jobId, data).then(shown => { if (!shown) showPageMessage(data); });
    return;
  }
  showPageMessage(data);
}

function showPageMessage(data) {
  const m = PAGE_MESSAGES[data.kind] || PAGE_MESSAGES.other;
  showFallbackUI(); // also stops the apply-page refresh
  jobPageStatus.querySelector(".status-text").textContent = m.status;
  document.getElementById("fallback-icon").textContent = m.icon;
  document.getElementById("fallback-title").textContent = m.title;
  document.getElementById("fallback-text").textContent = m.text;
  btnReloadJob.classList.toggle("hide", data.kind !== "feed");
}

// The apply page has no job details to score from, so show the score saved when the job was viewed.
// It cannot see client or competition stats, and the extension never fetches Upwork pages on the
// member's behalf, so after STALE_AFTER_MS the score is recalculated from what can still be known:
// the job is older, the client last looked longer ago, and the Connects cost the page shows now.
const STALE_AFTER_MS = 3 * 60 * 1000;
const APPLY_REFRESH_MS = 20 * 1000;
let applyWatch = null;

function stopApplyWatch() {
  if (applyWatch) { clearInterval(applyWatch); applyWatch = null; }
}

async function showSavedScore(jobId, live = {}) {
  try {
    const { scoredIndex = {} } = await chrome.storage.local.get("scoredIndex");
    const entry = scoredIndex[jobId];
    const view = entry?.view;
    if (!view?.roi) return false;

    // Keep the screen current while the member stays on the apply page
    if (!applyWatch) applyWatch = setInterval(() => scanActivePage(), APPLY_REFRESH_MS);

    scrapedJobTitle.textContent = view.title || "Job";
    const connects = live.connectsRequired ?? view.connectsNeeded;
    scrapedJobConnects.textContent = connects != null ? `${connects} Connects (${getConnectsTier(connects)})` : "";
    scrapedJobCountry.textContent = view.clientCountry || "";
    scrapedJobCountry.classList.toggle("hide", !view.clientCountry);
    document.getElementById("scraped-job-client").classList.add("hide");
    jobDetailsCard.classList.remove("hide");
    analyzerFallback.classList.add("hide");

    const elapsed = Date.now() - entry.seenAt;
    const status = (cls, text) => {
      jobPageStatus.className = `status-alert ${cls}`;
      jobPageStatus.querySelector(".status-text").textContent = text;
    };

    if (live.jobClosed) {
      roiScoreCard.classList.add("hide");
      status("info", "Upwork says this job is no longer available. Its score no longer applies.");
      return true;
    }

    let roi = view.roi;
    if (elapsed >= STALE_AFTER_MS && entry.snapshot?.inputs) {
      roi = calculateROIScore(ageJob(jobFromInputs(entry.snapshot.inputs), elapsed, live.connectsRequired ?? undefined));
      status("info", `Score recalculated for the ${timeAgo(entry.seenAt).replace(" ago", "")} since you viewed this job. Client activity is from then: reopen the job to refresh it.`);
    } else {
      status("success", `Score saved ${timeAgo(entry.seenAt)}, when you viewed this job`);
    }
    renderRoiBreakdown(roi);
    return true;
  } catch (err) {
    logError("sidepanel → showSavedScore", err.message, "", err.stack);
    return false;
  }
}

function timeAgo(ms) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}


// Draws the score ring, verdict and the per-bucket breakdown for a roi result. Works from a live
// scrape and from a score saved earlier (apply page), so both show the same thing.
function renderRoiBreakdown(roi) {
  roiReasonsList.innerHTML = "";
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

// Fallback panels utility
function showFallbackUI() {
  stopApplyWatch();
  awaitingLoad = false;
  awaitingTicks = 0;
  currentScrapedJob = null;
  currentRoi = null;
  updateLogJobButton();
  jobPageStatus.className = "status-alert info";
  jobPageStatus.querySelector(".status-text").textContent = "Detecting active Upwork job post...";
  document.getElementById("fallback-icon").textContent = "🔍";
  document.getElementById("fallback-title").textContent = "No job open";
  document.getElementById("fallback-text").textContent = "Open an Upwork job page or click a job card in the feed, then press Scan Page.";
  btnReloadJob.classList.remove("hide");
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

  // Whoever is connected now sees their own proposals (a different member's rows from this browser stay hidden)
  if (connected) await adoptLegacyLogs(connection.member.id);
  const { logs: storedLogs = [] } = await chrome.storage.local.get("logs");
  proposalLogs = mine(storedLogs);
  renderLogsList();
  updateROIStats();
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

// The ROI Hub entry for the job on screen, if the member already applied to it
function loggedProposalFor(job) {
  return job?.jobId ? proposalLogs.find(l => l.jobId === job.jobId) : null;
}

// "Log proposal" button on the job card: only for a scored, identifiable job while Connected.
// A job that is already logged (auto-tracked or by hand) gets a reminder, and the button edits that entry.
function updateLogJobButton() {
  const show = !!(connection && currentScrapedJob && currentScrapedJob.jobId && currentRoi);
  btnLogJob.classList.toggle("hide", !show);

  const logged = loggedProposalFor(currentScrapedJob);
  const note = document.getElementById("applied-note");
  note.classList.toggle("hide", !logged);
  btnLogJob.textContent = logged ? "Update logged proposal" : "Log proposal for this job";
  if (logged) {
    const how = logged.source === "capture" ? "auto-tracked" : "logged by hand";
    const edits = logged.revisions?.length ? ` · edited ${logged.revisions.length}×, earlier values kept` : "";
    note.innerHTML = `✓ You already applied to this job` +
      `<small>${escapeHtml(logged.date)} · ${escapeHtml(connectsLabel(logged))} · ${escapeHtml(logged.status)} · ${how}${edits}</small>`;
  }
}

function updateLogLinkUI() {
  logLinked.classList.toggle("hide", !pendingLogJob);
  if (pendingLogJob) logLinkedTitle.textContent = pendingLogJob.title;
  // "Save changes" when the form is editing a proposal that is already logged
  const editing = !!(pendingLogJob && proposalLogs.some(l => l.jobId === pendingLogJob.jobId));
  document.getElementById("log-submit").textContent = editing ? "Save changes" : "Add to History";
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
    
    let linked = pendingLogJob;
    // Typed in by hand but clearly the same proposal as one already logged: update that one, so the
    // correction reaches the dashboard instead of sitting in an on-device copy.
    let matchedExisting = false;
    if (!linked) {
      const match = findLoggedByTitle(proposalLogs, logTitleInput.value);
      if (match) {
        linked = { jobId: match.jobId, jobUrl: match.jobUrl, title: match.title, scoreSnapshot: match.scoreSnapshot };
        matchedExisting = true;
      }
    }
    const newLog = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString(),
      submittedAt: new Date().toISOString(),
      memberId: connection?.member?.id,
      title: logTitleInput.value.trim(),
      connects: parseInt(logConnectsInput.value, 10),
      boost: logBoostSelect.value,
      status: logStatusSelect.value,
      // Linked entries carry the job id so they can sync; the score is frozen as it was when applying
      ...(linked && { jobId: linked.jobId, jobUrl: linked.jobUrl, scoreSnapshot: linked.scoreSnapshot })
    };

    // One entry per job: a hand entry for an already logged job updates it (keeping the earlier
    // values) or, when identical, changes nothing.
    const result = await recordManualLog(newLog);
    proposalLogs = mine(await updateLogs(logs => logs));
    if (result.action === "created") {
      trackProposalSubmitted(newLog);
    } else if (result.action === "overridden") {
      trackProposalSubmitted(result.log);
      const before = result.log.revisions[result.log.revisions.length - 1];
      if (before && before.status !== result.log.status) trackStatusChanged(result.log);
    }
    const message = {
      created: "",
      overridden: (matchedExisting ? "Matched your existing proposal for this job and updated it. " : "Updated the logged proposal. ") + "The earlier values are kept in its history.",
      unchanged: "Already logged with the same details. Nothing changed."
    }[result.action];

    // Reset form fields
    logTitleInput.value = "";
    logConnectsInput.value = 16;
    logBoostSelect.value = "none";
    logStatusSelect.value = "applied";
    pendingLogJob = null;
    updateLogLinkUI();
    if (message) logSyncHint.textContent = message;

    renderLogsList();
    updateROIStats();
    updateLogJobButton();
  });

  btnLogJob.addEventListener("click", () => {
    if (!currentScrapedJob || !currentScrapedJob.jobId || !currentRoi) return;
    pendingLogJob = {
      jobId: currentScrapedJob.jobId,
      jobUrl: currentScrapedJob.jobUrl,
      title: currentScrapedJob.title,
      scoreSnapshot: buildScoreSnapshot(currentScrapedJob, currentRoi)
    };
    const logged = loggedProposalFor(currentScrapedJob);
    logTitleInput.value = currentScrapedJob.title;
    logConnectsInput.value = logged ? logged.connects : (currentScrapedJob.connectsNeeded || 16);
    logBoostSelect.value = logged ? logged.boost : "none";
    logStatusSelect.value = logged ? logged.status : "applied";
    updateLogLinkUI();
    if (logged) logSyncHint.textContent = "This job is already logged. Saving updates that entry (no duplicate); its earlier values are kept in its history.";
    switchTab("roi-tab");
    logTitleInput.focus();
  });

  // Proposals captured from Upwork's apply page are written by the service worker
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.logs) {
      proposalLogs = mine(changes.logs.newValue);
      renderLogsList();
      updateROIStats();
      updateLogJobButton();
    }
  });

  btnUnlinkJob.addEventListener("click", () => {
    pendingLogJob = null;
    updateLogLinkUI();
  });
  updateLogLinkUI();

  btnClearHistory.addEventListener("click", async () => {
    if (confirm("Are you sure you want to delete all proposal tracking logs? This cannot be undone.")) {
      const me = connection?.member?.id;
      proposalLogs = mine(await updateLogs(all => all.filter(l => l.memberId !== me)));
      renderLogsList();
      updateROIStats();
    }
  });
}

// Load logs database
async function loadProposalLogs() {
  const data = await chrome.storage.local.get(["logs"]);
  if (data.logs) {
    proposalLogs = mine(data.logs);
  }
  renderLogsList();
  updateROIStats();
}

function updateROIStats() {
  const counts = roiCounts(proposalLogs);
  statTotalConnects.textContent = counts.connects;
  statTotalProposals.textContent = counts.proposals;
  statTotalInterviews.textContent = counts.interviews;
  statConversion.textContent = `${counts.responseRatePct}%`;
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
          <span class="spent">-${escapeHtml(connectsLabel(log))}${boostLabel}</span>
          ${statusSelectHtml(log)}
          ${log.revisions?.length ? `<span class="local-only-tag" title="${escapeHtml(revisionSummary(log))}">edited</span>` : ""}
          ${log.syncIssue ? `<span class="local-only-tag sync-issue" title="${escapeHtml(syncIssueText(log.syncIssue))}">not synced</span>` : ""}
          ${log.jobId ? "" : '<span class="local-only-tag" title="Not linked to a job, so it stays on this device. Use \'Log proposal\' on a scanned job to sync.">local only</span>'}
        </div>
      </div>
      ${log.jobId ? `<button class="btn-edit-log" data-id="${log.id}" title="Edit connects, boost or status" aria-label="Edit this proposal">✎</button>` : ""}
      <button class="btn-delete-log" data-id="${log.id}" aria-label="Delete this entry">×</button>
    `;
    
    // Status changed by hand (e.g. the client viewed or replied)
    item.querySelector(".status-select").addEventListener("change", (e) => setLogStatus(log.id, e.target.value));

    const edit = item.querySelector(".btn-edit-log");
    if (edit) edit.addEventListener("click", () => startEditingLog(log));

    // Bind delete listener
    item.querySelector(".btn-delete-log").addEventListener("click", () => deleteLog(log.id));
    
    historyContainer.appendChild(item);
  });
}

// Loads a synced proposal into the form, linked to its job, so saving updates it (and its history)
function startEditingLog(log) {
  pendingLogJob = { jobId: log.jobId, jobUrl: log.jobUrl, title: log.title, scoreSnapshot: log.scoreSnapshot };
  logTitleInput.value = log.title;
  logConnectsInput.value = log.connects;
  logBoostSelect.value = log.boost;
  logStatusSelect.value = MANUAL_STATUSES.some(([v]) => v === log.status) ? log.status : "applied";
  updateLogLinkUI();
  logSyncHint.textContent = "Editing a logged proposal. Saving updates it and keeps its earlier values in its history.";
  proposalLogForm.scrollIntoView({ behavior: "smooth", block: "start" });
  logConnectsInput.focus();
}

// Why the engine refused the last change for a row, in plain words
function syncIssueText(issue) {
  if (issue === "unknown_proposal") return "Exeve could not apply your last change: this proposal is not in the connected account. It was probably logged while connected as someone else.";
  return `Exeve could not apply your last change (${issue}). Try the change again, or copy your diagnostics for your admin.`;
}

// Tooltip text: every earlier version of a proposal, oldest first
function revisionSummary(log) {
  return log.revisions.map(r =>
    `${new Date(r.at).toLocaleString()}: was ${r.connects} connects, ${r.boost === "none" ? "no boost" : r.boost}, ${r.status} (${r.source === "capture" ? "auto-tracked" : "by hand"})`
  ).join("\n");
}

// Statuses a member can set by hand, in funnel order. Auto-detected ones (withdrawn, archived)
// are shown when present but not offered, since only Upwork's own pages can tell.
const MANUAL_STATUSES = [
  ["applied", "Applied"],
  ["viewed", "Viewed by client"],
  ["replied", "Client replied"],
  ["interviewing", "Interviewing"],
  ["hired", "Hired"],
  ["rejected", "Rejected / closed"]
];

function statusSelectHtml(log) {
  const known = MANUAL_STATUSES.some(([v]) => v === log.status);
  const options = (known ? MANUAL_STATUSES : [...MANUAL_STATUSES, [log.status, log.status]])
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === log.status ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  return `<select class="status-select ${escapeHtml(log.status)}" data-id="${escapeHtml(log.id)}" aria-label="Proposal status">${options}</select>`;
}

async function setLogStatus(id, status) {
  let changed = null;
  proposalLogs = mine(await updateLogs(logs => {
    const log = logs.find(l => l.id === id);
    if (!log || log.status === status) return logs;
    log.status = status;
    changed = log;
    return logs;
  }));
  if (changed) trackStatusChanged(changed);

  renderLogsList();
  updateROIStats();
  updateLogJobButton();
}

async function deleteLog(id) {
  proposalLogs = mine(await updateLogs(logs => logs.filter(l => l.id !== id)));
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
