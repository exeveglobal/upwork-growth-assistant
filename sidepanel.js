// sidepanel.js - Controller for Upwork Growth Assistant Side Panel

import {
  checkLicenseStatus,
  calculateROIScore,
  buildProposalPrompt,
  buildProfilePrompt,
  callLLM,
  getConnectsTier
} from './utils.js';

// State
let currentScrapedJob = null;
let currentScrapedProfile = null;
let appSettings = {};
let proposalLogs = [];

// DOM Elements
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");
const licenseBadge = document.getElementById("license-badge");

// Settings Elements
const providerSelect = document.getElementById("settings-provider");
const anthropicConfigBlock = document.getElementById("anthropic-config-block");
const geminiConfigBlock = document.getElementById("gemini-config-block");
const anthropicKeyInput = document.getElementById("settings-anthropic-key");
const anthropicModelSelect = document.getElementById("settings-anthropic-model");
const geminiKeyInput = document.getElementById("settings-gemini-key");
const geminiModelSelect = document.getElementById("settings-gemini-model");
const settingsNicheInput = document.getElementById("settings-niche");
const settingsRateInput = document.getElementById("settings-rate");
const settingsBioInput = document.getElementById("settings-bio");
const settingsLicenseInput = document.getElementById("settings-license");
const saveSettingsBtn = document.getElementById("btn-save-settings");
const saveStatusMsg = document.getElementById("save-status-msg");

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
const proposalGenCard = document.getElementById("proposal-generation-card");
const proposalToneSelect = document.getElementById("proposal-tone");
const btnGenerateProposal = document.getElementById("btn-generate-proposal");
const proposalSpinner = document.getElementById("proposal-spinner");
const proposalResultCard = document.getElementById("proposal-result-card");
const proposalOutputText = document.getElementById("proposal-output-text");
const proposalCopyHint = document.getElementById("proposal-copy-hint");
const btnCopyHooks = document.getElementById("btn-copy-hooks");
const btnCopyProposal = document.getElementById("btn-copy-proposal");
const btnLogProposal = document.getElementById("btn-log-proposal");
const btnReloadJob = document.getElementById("btn-reload-job");
const analyzerFallback = document.getElementById("analyzer-fallback");

// Optimizer Elements
const profileStatus = document.getElementById("profile-status");
const profileDetectedCard = document.getElementById("profile-detected-card");
const scrapedProfileTitle = document.getElementById("scraped-profile-title");
const profileControlCard = document.getElementById("profile-control-card");
const optimizerNicheInput = document.getElementById("optimizer-niche");
const btnOptimizeProfile = document.getElementById("btn-optimize-profile");
const profileSpinner = document.getElementById("profile-spinner");
const profileResultCard = document.getElementById("profile-result-card");
const profileOutputText = document.getElementById("profile-output-text");
const profileCopyHint = document.getElementById("profile-copy-hint");
const btnCopyProfile = document.getElementById("btn-copy-profile");
const btnReloadProfile = document.getElementById("btn-reload-profile");
const optimizerFallback = document.getElementById("optimizer-fallback");

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

// Auto-scanner tracking variables
let lastPageIdentifier = "";
let scanInProgress = false;

// Initialize Extension Sidepanel
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadProposalLogs();
  setupTabs();
  setupSettingsUI();
  setupROILogger();
  
  // Set initial UI state — show fallbacks, hide all result cards
  showFallbackUI("analyzer");
  showFallbackUI("optimizer");
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
          showFallbackUI("analyzer");
          showFallbackUI("optimizer");
        }
      }
    } catch (err) {
      console.error("Auto-scan check failed:", err);
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
  if (btnReloadProfile) btnReloadProfile.addEventListener("click", () => {
    clearCachedUI();
    scanActivePage();
  });
});

// Resets UI to "scanning" state — job header card stays visible so the user sees the
// transition animation; ROI and proposal cards are hidden until new results arrive.
// showFallbackUI("analyzer") is called later only if the scan returns no job data.
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
  proposalGenCard.classList.add("hide");
  proposalResultCard.classList.add("hide");

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
      showFallbackUI("analyzer");
      showFallbackUI("optimizer");
      return;
    }
    
    // Try sending message to content script
    sendMessageToContentScript(tab.id, { action: "scrapePage" });
  } catch (error) {
    console.error("Scan error:", error);
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
        showFallbackUI("analyzer");
        showFallbackUI("optimizer");
      }
      return;
    }

    if (response && response.success) {
      if (!response.data.isLoaded && retryCount < 3) {
        setTimeout(() => sendMessageToContentScript(tabId, message, retryCount + 1), 700);
        return;
      }
      scanInProgress = false;
      handleScrapeResult(response.data);
    } else {
      scanInProgress = false;
      showFallbackUI("analyzer");
      console.error("Scraping returned failure status:", response ? response.error : "Unknown");
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
    currentScrapedProfile = null;

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
    proposalGenCard.classList.remove("hide");
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
      roiScoreCard.classList.remove("hide");
      showFallbackUI("optimizer");
      return;
    }

    const roi = calculateROIScore(data);
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

    // Ensure optimizer fallback is visible since it's not a profile page
    showFallbackUI("optimizer");
  } else if (data.type === "profile") {
    currentScrapedProfile = data;
    currentScrapedJob = null;
    
    scrapedProfileTitle.textContent = data.title || "Main Profile Overview";
    profileStatus.className = "status-alert success";
    profileStatus.querySelector(".status-text").textContent = "Freelancer Profile Scraped!";
    
    profileDetectedCard.classList.remove("hide");
    profileControlCard.classList.remove("hide");
    optimizerFallback.classList.add("hide");
    
    // Ensure analyzer fallback is visible
    showFallbackUI("analyzer");
  }
}

// Fallback panels utility
function showFallbackUI(tabType) {
  if (tabType === "analyzer") {
    currentScrapedJob = null;
    jobPageStatus.className = "status-alert info";
    jobPageStatus.querySelector(".status-text").textContent = "Detecting active Upwork job post...";
    jobDetailsCard.classList.add("hide");
    roiScoreCard.classList.add("hide");
    proposalGenCard.classList.add("hide");
    proposalResultCard.classList.add("hide");
    analyzerFallback.classList.remove("hide");
  } else if (tabType === "optimizer") {
    currentScrapedProfile = null;
    profileStatus.className = "status-alert info";
    profileStatus.querySelector(".status-text").textContent = "Detecting your Upwork profile page...";
    profileDetectedCard.classList.add("hide");
    profileControlCard.classList.add("hide");
    profileResultCard.classList.add("hide");
    optimizerFallback.classList.remove("hide");
  }
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

// AI Settings Config UI Interactions
function setupSettingsUI() {
  providerSelect.addEventListener("change", () => {
    const val = providerSelect.value;
    if (val === "gemini") {
      geminiConfigBlock.classList.remove("hide");
      anthropicConfigBlock.classList.add("hide");
    } else {
      anthropicConfigBlock.classList.remove("hide");
      geminiConfigBlock.classList.add("hide");
    }
  });

  saveSettingsBtn.addEventListener("click", async () => {
    appSettings = {
      provider: providerSelect.value,
      anthropicKey: anthropicKeyInput.value.trim(),
      anthropicModel: anthropicModelSelect.value,
      geminiKey: geminiKeyInput.value.trim(),
      geminiModel: geminiModelSelect.value,
      niche: settingsNicheInput.value.trim(),
      rate: settingsRateInput.value.trim(),
      bio: settingsBioInput.value.trim(),
      licenseKey: settingsLicenseInput.value.trim()
    };

    await chrome.storage.local.set({ settings: appSettings });
    
    // Save Niche context to optimizer tab automatically
    if (appSettings.niche) {
      optimizerNicheInput.value = appSettings.niche;
    }
    
    // Validate licensing badge
    const license = await checkLicenseStatus();
    updateLicenseBadge(license);
    
    saveStatusMsg.textContent = "Settings saved successfully!";
    saveStatusMsg.style.color = "var(--accent-green)";
    setTimeout(() => {
      saveStatusMsg.textContent = "";
    }, 3000);
  });
}

// Loads Saved Configuration
async function loadSettings() {
  const data = await chrome.storage.local.get(["settings"]);
  if (data.settings) {
    appSettings = data.settings;
    
    // Populate form elements
    providerSelect.value = appSettings.provider || "anthropic";
    providerSelect.dispatchEvent(new Event("change")); // Trigger visibility toggle
    
    anthropicKeyInput.value = appSettings.anthropicKey || "";
    anthropicModelSelect.value = appSettings.anthropicModel || "claude-sonnet-4-6";
    
    geminiKeyInput.value = appSettings.geminiKey || "";
    geminiModelSelect.value = appSettings.geminiModel || "gemini-2.5-flash";
    
    settingsNicheInput.value = appSettings.niche || "";
    optimizerNicheInput.value = appSettings.niche || "";
    settingsRateInput.value = appSettings.rate || "";
    settingsBioInput.value = appSettings.bio || "";
    settingsLicenseInput.value = appSettings.licenseKey || "";
  }
  
  // Set premium badge status
  const license = await checkLicenseStatus();
  updateLicenseBadge(license);
}

function updateLicenseBadge(license) {
  licenseBadge.textContent = license.tier === "premium" ? "Premium" : "Free Tier";
  licenseBadge.className = `badge ${license.tier}`;
}

// Setup Proposal Draft Triggering
btnGenerateProposal.addEventListener("click", async () => {
  if (!currentScrapedJob) {
    alert("Please scan an Upwork job details page first.");
    return;
  }
  
  const key = appSettings.provider === "anthropic" ? appSettings.anthropicKey : appSettings.geminiKey;
  if (!key) {
    alert(`Please enter your API Key for ${appSettings.provider === "anthropic" ? "Anthropic Claude" : "Google Gemini"} in the Settings tab first.`);
    switchTab("settings-tab");
    return;
  }

  // Toggle Spinner UI
  btnGenerateProposal.disabled = true;
  proposalSpinner.classList.remove("hide");
  proposalResultCard.classList.add("hide");

  try {
    const tone = proposalToneSelect.value;
    const prompt = buildProposalPrompt(currentScrapedJob, appSettings, tone);
    
    const response = await callLLM({
      provider: appSettings.provider,
      model: appSettings.provider === "anthropic" ? appSettings.anthropicModel : appSettings.geminiModel,
      apiKey: key,
      prompt: prompt
    });

    renderProposalResult(response);
  } catch (err) {
    console.error("API Call error:", err);
    alert(`AI Generation Failed: ${err.message}`);
  } finally {
    btnGenerateProposal.disabled = false;
    proposalSpinner.classList.add("hide");
  }
});

function renderProposalResult(text) {
  proposalResultCard.classList.remove("hide");
  
  // Render clean text structure
  proposalOutputText.innerHTML = formatMarkdownHTML(text);
  
  // Scroll details into view
  proposalResultCard.scrollIntoView({ behavior: "smooth" });
}

// Profile SEO Audit trigger
btnOptimizeProfile.addEventListener("click", async () => {
  if (!currentScrapedProfile) {
    alert("Please scan an Upwork profile editing page first.");
    return;
  }
  
  const key = appSettings.provider === "anthropic" ? appSettings.anthropicKey : appSettings.geminiKey;
  if (!key) {
    alert(`Please enter your API Key for ${appSettings.provider === "anthropic" ? "Anthropic Claude" : "Google Gemini"} in the Settings tab first.`);
    switchTab("settings-tab");
    return;
  }

  btnOptimizeProfile.disabled = true;
  profileSpinner.classList.remove("hide");
  profileResultCard.classList.add("hide");

  try {
    const nicheTarget = optimizerNicheInput.value.trim();
    const prompt = buildProfilePrompt(currentScrapedProfile, nicheTarget);
    
    const response = await callLLM({
      provider: appSettings.provider,
      model: appSettings.provider === "anthropic" ? appSettings.anthropicModel : appSettings.geminiModel,
      apiKey: key,
      prompt: prompt
    });

    profileResultCard.classList.remove("hide");
    profileOutputText.innerHTML = formatMarkdownHTML(response);
    profileResultCard.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error("API Call error:", err);
    alert(`Profile Optimization Failed: ${err.message}`);
  } finally {
    btnOptimizeProfile.disabled = false;
    profileSpinner.classList.add("hide");
  }
});

// Copy Buttons Event Listeners
btnCopyHooks.addEventListener("click", () => {
  const content = proposalOutputText.textContent;
  // Locate the hooks block (typically between ### 1. and ### 2.)
  const hooksBlock = content.match(/Hooks[\s\S]*?(?=### 2\.|\-\-\-)/i);
  const textToCopy = hooksBlock ? hooksBlock[0].trim() : content;
  copyTextToClipboard(textToCopy, proposalCopyHint);
});

btnCopyProposal.addEventListener("click", () => {
  const content = proposalOutputText.textContent;
  // Locate proposal body (typically everything after ### 2. Tailored Proposal Body)
  const proposalBlock = content.split(/Tailored Proposal Body/i)[1] || content;
  copyTextToClipboard(proposalBlock.trim(), proposalCopyHint);
});

btnCopyProfile.addEventListener("click", () => {
  const content = profileOutputText.textContent;
  // Try to copy the bio rewrite section (everything after "Bio Rewrite")
  const bioRewriteBlock = content.split(/Bio Rewrite/i)[1] || content;
  copyTextToClipboard(bioRewriteBlock.trim(), profileCopyHint);
});

function copyTextToClipboard(text, hintEl) {
  navigator.clipboard.writeText(text).then(() => {
    hintEl.classList.add("show");
    setTimeout(() => hintEl.classList.remove("show"), 2000);
  }).catch(err => {
    console.error("Clipboard copy failed:", err);
  });
}

// Log directly to ROI hub pre-filler
btnLogProposal.addEventListener("click", () => {
  if (!currentScrapedJob) return;
  
  // Prefill the form details
  logTitleInput.value = currentScrapedJob.title;
  logConnectsInput.value = currentScrapedJob.connectsNeeded || 16;
  logBoostSelect.value = "none";
  logStatusSelect.value = "applied";
  
  // Switch to ROI tab
  switchTab("roi-tab");
  logTitleInput.focus();
});

// Switch active tab by panel ID
function switchTab(panelId) {
  const btn = document.querySelector(`.tab-btn[data-tab="${panelId}"]`);
  if (btn) btn.click();
}

// ROI Hub Tracker Log Functions
function setupROILogger() {
  proposalLogForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const newLog = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString(),
      title: logTitleInput.value.trim(),
      connects: parseInt(logConnectsInput.value, 10),
      boost: logBoostSelect.value,
      status: logStatusSelect.value
    };

    proposalLogs.unshift(newLog); // Add to beginning of history
    await chrome.storage.local.set({ logs: proposalLogs });
    
    // Reset form fields
    logTitleInput.value = "";
    logConnectsInput.value = 16;
    logBoostSelect.value = "none";
    logStatusSelect.value = "applied";
    
    renderLogsList();
    updateROIStats();
  });

  btnClearHistory.addEventListener("click", async () => {
    if (confirm("Are you sure you want to delete all proposal tracking logs? This cannot be undone.")) {
      proposalLogs = [];
      await chrome.storage.local.set({ logs: proposalLogs });
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
        <div class="history-item-title" title="${log.title}">${log.title}</div>
        <div class="history-item-sub">
          <span>${log.date}</span>
          <span class="spent">-${log.connects} connects${boostLabel}</span>
          <span>•</span>
          <span class="status-badge ${log.status}">${log.status}</span>
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
  const logIndex = proposalLogs.findIndex(l => l.id === id);
  if (logIndex === -1) return;
  
  const statusCycle = ["applied", "interviewing", "hired", "rejected"];
  const currentStatus = proposalLogs[logIndex].status;
  const nextIndex = (statusCycle.indexOf(currentStatus) + 1) % statusCycle.length;
  
  proposalLogs[logIndex].status = statusCycle[nextIndex];
  await chrome.storage.local.set({ logs: proposalLogs });
  
  renderLogsList();
  updateROIStats();
}

async function deleteLog(id) {
  proposalLogs = proposalLogs.filter(l => l.id !== id);
  await chrome.storage.local.set({ logs: proposalLogs });
  renderLogsList();
  updateROIStats();
}

// Mini Markdown-to-HTML parser to display rich formatting in results boxes
function formatMarkdownHTML(md) {
  if (!md) return "";
  
  return md
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Bullet lists
    .replace(/^\s*\-\s*(.*$)/gim, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/sim, '<ul>$1</ul>')
    // Line breaks
    .replace(/\n/g, '<br>');
}
