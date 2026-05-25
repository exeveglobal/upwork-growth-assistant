// content.js - Scraper for Upwork Job Details and Profile Pages

// Rolling error logger — writes up to 50 entries into chrome.storage.local["errorLog"]
function logError(context, message, stack = '') {
  chrome.storage.local.get({ errorLog: [] }, ({ errorLog }) => {
    errorLog.push({
      id: Date.now().toString(),
      ts: new Date().toISOString(),
      context,
      url: window.location.href,
      message,
      stack
    });
    if (errorLog.length > 50) errorLog.splice(0, errorLog.length - 50);
    chrome.storage.local.set({ errorLog });
  });
}

// Listen for messages from the sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scrapePage") {
    try {
      const data = scrapeCurrentPage();
      sendResponse({ success: true, data: data });
    } catch (error) {
      // Only genuine unexpected errors reach here — log and report
      logError('content.js → scrapePage', error.message, error.stack);
      console.warn('[UGA] Unexpected scrape error:', error.message);
      sendResponse({ success: false, error: error.message });
    }
  } else if (request.action === "checkPageIdentifier") {
    try {
      const identifier = getPageIdentifier();
      sendResponse({ success: true, identifier: identifier });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  }
  return true; // Keep the message channel open for async response
});

// Unique page identifier for auto-scan detection.
// Uses the same root-finding logic as scrapeJobDetailsPage so the poll accurately
// reflects what the scraper will actually find — no more guessing about drawer selectors.
function getPageIdentifier() {
  const url = window.location.href;

  // Profile page — check first so it doesn't fall into job logic
  const profileEl = document.querySelector("[data-test='profile-title']");
  if (profileEl) {
    return `profile:${profileEl.textContent.trim()}:${url}`;
  }

  // Use the same root the scraper uses: drawer → main → body
  const drawerEl = document.querySelector(
    "[role='dialog'], .up-slider, .job-details-panel, .slider-panel, [role='region'] .slider"
  );
  const root = drawerEl || document.querySelector("main, article") || document.body;

  const jobTitleEl  = root.querySelector("h1, h2.job-title, [data-test='job-title'], .job-title");
  const jobDescEl   = root.querySelector(
    "[data-test='job-description'], .job-description, .fe-job-description, [data-qa='job-description']"
  );

  const jobTitle = jobTitleEl ? jobTitleEl.textContent.trim() : "";

  // A job is "open" only when BOTH title AND description are present
  // (title alone can match the feed's own headings)
  if (jobTitle && jobDescEl) {
    return `job:${jobTitle}:${url}`;
  }

  // Feed, archive, or other non-job page — use URL only so any navigation triggers a re-check
  return `nonjob:${url}`;
}

function scrapeCurrentPage() {
  const url = window.location.href;
  
  if (url.includes("/freelancers/") || url.includes("/nx/find-work/profile") || document.querySelector("[data-test='profile-title']")) {
    return scrapeProfilePage();
  } else {
    // Default to scraping job details (since it could be a job feed, job details page, or slider)
    return scrapeJobDetailsPage();
  }
}

// Scrape profile details
function scrapeProfilePage() {
  
  // Try selectors for profile title, overview, skills, rate
  const titleEl = document.querySelector("h1, [data-test='profile-title'], .fe-profile-title");
  const overviewEl = document.querySelector("[data-test='profile-description'], .fe-profile-overview, .profile-description");
  const rateEl = document.querySelector("[data-test='profile-rate'], .fe-profile-rate h2");
  
  // Skills tags
  const skillEls = document.querySelectorAll("[data-test='skill-link'], .skills-list-item, .o-tag-skill");
  const skills = Array.from(skillEls).map(el => el.textContent.trim()).filter(Boolean);
  
  const title = titleEl ? titleEl.textContent.trim() : "";
  const overview = overviewEl ? overviewEl.textContent.trim() : "";
  const rate = rateEl ? rateEl.textContent.trim() : "";
  
  // Fallback: If overview is empty, get the main text container of the profile
  let rawText = "";
  if (!overview) {
    const profileContainer = document.querySelector("main, #main, article, .fe-profile-main");
    if (profileContainer) {
      rawText = cleanText(profileContainer.textContent);
    }
  }

  return {
    type: "profile",
    title,
    overview,
    rate,
    skills,
    rawText
  };
}

// Scrape job details
function scrapeJobDetailsPage() {

  const url = window.location.href;
  // /details/ paths are direct job views rendered in <main> — not a feed slider
  const isDirectJobDetail = url.includes("/details/");
  const isFeedPage = !isDirectJobDetail && (
    url.includes("/nx/find-work") || url.includes("/search") || url.includes("/ab/jobs/")
  );
  const drawer = document.querySelector("[role='dialog'], .up-slider, .job-details-panel, .slider-panel, [role='region'] .slider");

  // Feed page with no slider open — expected state, not an error
  if (isFeedPage && !drawer) {
    console.info('[UGA] Feed page with no active job slider — showing fallback.');
    return { type: 'nojob', isLoaded: false };
  }

  // Set the search scope: active drawer if open, otherwise main element, falling back to body
  const root = drawer || document.querySelector("main, article") || document.body;

  // 1. Job Title
  const titleEl = root.querySelector("h1, h2.job-title, [data-test='job-title'], .job-title");
  const title = titleEl ? titleEl.textContent.trim() : "";

  // 2. Job Description
  const descEl = root.querySelector("[data-test='job-description'], .job-description, .fe-job-description, [data-qa='job-description']");
  const description = descEl ? descEl.textContent.trim() : "";

  // Full text — fallback only when DOM selectors fail
  const fullText = root.textContent || "";

  // --- Activity Section ---
  // Read all ul.client-activity-items li.ca-item entries into a map keyed by label text.
  // This scopes proposals/invites/hires/interviewing to the job's own activity block,
  // preventing collisions with client-profile stats elsewhere on the page.
  const activityMap = {};
  root.querySelectorAll('ul.client-activity-items li.ca-item').forEach(li => {
    const labelEl = li.querySelector('span.title');
    const valueEl = li.querySelector('div.value, span.value');
    if (labelEl && valueEl) {
      const key = labelEl.textContent.trim().replace(/:$/, '').toLowerCase();
      activityMap[key] = valueEl.textContent.trim();
    }
  });

  // Proposals range text — "15 to 20", "less than 5", "50+", etc.
  const proposalRaw = activityMap['proposals'];
  const proposalRangeText = proposalRaw
    ? proposalRaw.toLowerCase().trim()
    : (fullText.match(/proposals[:\s]+(less\s+than\s+\d+|\d+\s+to\s+\d+|\d+\+)/i)?.[1]?.toLowerCase().trim() ?? null);

  // Job-specific hires — only present in activity list when someone was actually hired
  const hiresCount = activityMap['hires'] ? parseInt(activityMap['hires'], 10) : null;

  // Interviewing count
  const interviewingCount = activityMap['interviewing']
    ? parseInt(activityMap['interviewing'], 10)
    : (fullText.match(/interviewing[:\s]+(\d+)/i) ? parseInt(fullText.match(/interviewing[:\s]+(\d+)/i)[1], 10) : null);

  // Invites sent
  const invitesSent = activityMap['invites sent']
    ? parseInt(activityMap['invites sent'], 10)
    : (fullText.match(/invites?\s*sent[:\s]+(\d+)/i) ? parseInt(fullText.match(/invites?\s*sent[:\s]+(\d+)/i)[1], 10) : null);

  // Unanswered invites
  const unansweredInvites = activityMap['unanswered invites']
    ? parseInt(activityMap['unanswered invites'], 10)
    : (fullText.match(/unanswered\s*invites?[:\s]+(\d+)/i) ? parseInt(fullText.match(/unanswered\s*invites?[:\s]+(\d+)/i)[1], 10) : null);

  // Client last viewed
  let clientLastViewedHours = null;
  const lastViewedRaw = activityMap['last viewed by client'];
  const lastViewedText = lastViewedRaw
    || (fullText.match(/last\s+viewed\s+by\s+client[:\s]+(.+?)(?:\n|$)/i)?.[1] ?? null);
  if (lastViewedText) {
    if (/just\s*now/i.test(lastViewedText)) {
      clientLastViewedHours = 0;
    } else {
      const m = lastViewedText.match(/(\d+)\s*(minute|min|hour|hr|day|week)s?/i);
      if (m) {
        const amt = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        if (unit.startsWith('min'))      clientLastViewedHours = amt / 60;
        else if (unit.startsWith('h'))   clientLastViewedHours = amt;
        else if (unit.startsWith('d'))   clientLastViewedHours = amt * 24;
        else if (unit.startsWith('w'))   clientLastViewedHours = amt * 168;
      }
    }
  }

  // --- Client Stats (data-qa attributes scoped to client info section) ---
  // Hire rate — "[data-qa='client-job-posting-stats']" → "82% hire rate, 1 open job"
  const jobPostingStatsEl = root.querySelector('[data-qa="client-job-posting-stats"]');
  let hireRate = null;
  if (jobPostingStatsEl) {
    const m = jobPostingStatsEl.textContent.match(/(\d+)%\s*hire\s*rate/i);
    if (m) hireRate = parseInt(m[1], 10);
  }
  if (hireRate === null) {
    const m = fullText.match(/(\d+)%\s*hire\s*rate/i);
    if (m) hireRate = parseInt(m[1], 10);
  }

  // Active jobs — "N open job(s)" from the same stats element
  let activeJobsCount = null;
  if (jobPostingStatsEl) {
    const m = jobPostingStatsEl.textContent.match(/(\d+)\s+open\s+job/i);
    if (m) activeJobsCount = parseInt(m[1], 10);
  }
  if (activeJobsCount === null) {
    const m = fullText.match(/(\d+)\s+open\s+job/i);
    if (m) activeJobsCount = parseInt(m[1], 10);
  }

  // Rating — "[data-testid='buyer-rating'] .air3-rating-value-text"
  const ratingEl = root.querySelector('[data-testid="buyer-rating"] .air3-rating-value-text');
  let rating = ratingEl ? parseFloat(ratingEl.textContent.trim()) : null;
  if (rating === null) {
    const m = fullText.match(/(\d+(\.\d+)?)\s*of\s*5\s*stars/i) || fullText.match(/rating\s*is\s*(\d+(\.\d+)?)/i);
    if (m) rating = parseFloat(m[1]);
  }

  // Total spend — "[data-qa='client-spend']" → span containing "$7.7K"
  const spendEl = root.querySelector('[data-qa="client-spend"]');
  let totalSpend = null;
  if (spendEl) {
    const m = spendEl.textContent.match(/\$([\d,\.]+[KMB]?\+?)/i);
    if (m) totalSpend = m[1];
  }
  if (totalSpend === null) {
    const m = fullText.match(/\$([\d,]+[KMB]?\+?)\s*spent/i);
    if (m) totalSpend = m[1];
  }

  // Reviews count
  const reviewsEl = root.querySelector('[data-qa="client-reviews-count"]');
  let reviewsCount = null;
  if (reviewsEl) {
    const m = reviewsEl.textContent.match(/(\d+)/);
    if (m) reviewsCount = parseInt(m[1], 10);
  }
  if (reviewsCount === null) {
    const m = fullText.match(/of\s*(\d+)\s*reviews/i) || fullText.match(/(\d+)\s*feedback/i);
    if (m) reviewsCount = parseInt(m[1], 10);
  }

  // Avg rate paid
  const avgRateMatch = fullText.match(/\$([\d\.]+)\s*\/hr\s+avg/i) || fullText.match(/\$([\d\.]+)\s*avg\s+hourly/i);
  const avgRatePaid = avgRateMatch ? `$${avgRateMatch[1]}/hr` : "N/A";

  // --- Contract Type ---
  // data-cy is on the icon div INSIDE the li, not on the li itself.
  // Find the div by data-cy, then walk up to the containing li for price extraction.
  let contractLi = null;
  let isHourly = false;

  const timelogIcon  = root.querySelector('[data-cy="clock-timelog"]');
  const hourlyIcon   = root.querySelector('[data-cy="clock-hourly"]');
  const fixedIcon    = root.querySelector('[data-cy="fixed-price"]');

  if (timelogIcon) {
    isHourly = true;  contractLi = timelogIcon.closest('li');
  } else if (hourlyIcon) {
    isHourly = true;  contractLi = hourlyIcon.closest('li');
  } else if (fixedIcon) {
    isHourly = false; contractLi = fixedIcon.closest('li');
  } else {
    // Fallback: scan features list li items by their .description label text
    for (const li of root.querySelectorAll('ul.features li, ul.list-unstyled li')) {
      const desc = li.querySelector('.description');
      if (!desc) continue;
      const t = desc.textContent.trim().toLowerCase();
      if (t === 'hourly') {
        isHourly = true;  contractLi = li; break;
      } else if (t.startsWith('fixed')) {
        isHourly = false; contractLi = li; break;
      }
    }
  }

  // Extract price from the matched li.
  // Normalise amounts to bare numeric strings (strip leading $) so we add it once.
  // Priority: dollar amounts inside strong elements → regex over full li text.
  let budget = "Not specified";
  if (contractLi) {
    const fromStrongs = [...contractLi.querySelectorAll('strong')]
      .flatMap(el => { const m = el.textContent.match(/\$([\d,]+\.?\d*)/); return m ? [m[1]] : []; });
    const amounts = fromStrongs.length
      ? fromStrongs
      : [...contractLi.textContent.matchAll(/\$([\d,]+\.?\d*)/g)].map(m => m[1]);

    if (isHourly) {
      if (amounts.length >= 2) budget = `$${amounts[0]} – $${amounts[1]}/hr`;
      else if (amounts.length === 1) budget = `$${amounts[0]}/hr`;
      else budget = "Hourly (rate not listed)";
    } else {
      if (amounts.length >= 1) budget = `$${amounts[0]}`;
    }
  }

  // --- Payment Verification ---
  // Three-state: true = verified badge present, false = unverified badge/text, null = not loaded yet
  let isPaymentVerified = null;
  const payVerifiedEl   = root.querySelector('.payment-verified.text-success');
  const payUnverifiedEl = root.querySelector('.payment-not-verified');
  if (payVerifiedEl) {
    isPaymentVerified = true;
  } else if (payUnverifiedEl
    || /payment\s*(method\s*)?not\s*verified/i.test(fullText)
    || /no\s*payment\s*method/i.test(fullText)) {
    isPaymentVerified = false;
  }

  // --- Connects Needed ---
  let connectsNeeded = null;
  // Format 1: div[data-v-cc3ef634] "Required Connects to submit a proposal: N"
  const connectsEl1 = root.querySelector('div[data-v-cc3ef634]');
  if (connectsEl1) {
    const m = connectsEl1.textContent.match(/:\s*(\d+)/) || connectsEl1.textContent.match(/(\d+)\s*connects?/i);
    if (m) connectsNeeded = parseInt(m[1], 10);
  }
  // Format 2: "Send a proposal for: N Connects"
  if (connectsNeeded === null) {
    const connectsEls = root.querySelectorAll('div.text-light-on-muted.text-body-sm');
    for (const el of connectsEls) {
      const m = el.textContent.match(/for:\s*(\d+)/i);
      if (m) { connectsNeeded = parseInt(m[1], 10); break; }
    }
  }
  // Fallback to fullText
  if (connectsNeeded === null) {
    const m = fullText.match(/proposal\s*for:\s*(\d+)/i)
      || fullText.match(/required\s*connects[^:]*:\s*(\d+)/i)
      || fullText.match(/(\d+)\s*connects/i);
    if (m) connectsNeeded = parseInt(m[1], 10);
  }

  // --- Client Location ---
  let clientCountry = "";
  const locationEl = root.querySelector('[data-qa="client-location"] strong, [data-qa="client-location"]');
  if (locationEl) {
    clientCountry = locationEl.textContent.trim();
  } else {
    const locMatch = fullText.match(/(United States|United Kingdom|Canada|Australia|Germany|France|Netherlands|Singapore|India|Pakistan|Ukraine|Poland)\b/i);
    clientCountry = locMatch ? locMatch[0] : "Unknown";
  }

  // --- Job Age ---
  const justNowPosted = /posted\s+just\s+now/i.test(fullText);
  const postedMatch = fullText.match(/posted\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\s*ago/i);
  let jobAgeHours = null;
  if (justNowPosted) {
    jobAgeHours = 0;
  } else if (postedMatch) {
    const amt = parseInt(postedMatch[1], 10);
    const unit = postedMatch[2].toLowerCase();
    if (unit.startsWith("min"))      jobAgeHours = amt / 60;
    else if (unit.startsWith("h"))   jobAgeHours = amt;
    else if (unit.startsWith("day")) jobAgeHours = amt * 24;
    else if (unit.startsWith("w"))   jobAgeHours = amt * 168;
  }

  // isLoaded — requires title, non-trivial description, and connects section all present
  let isLoaded = true;
  if (!title || description.length < 50) {
    isLoaded = false;
  } else if (connectsNeeded === null) {
    isLoaded = false;
  }

  // Verify title matches URL slug to catch stale SPA cache
  if (isLoaded && !isFeedPage && url.includes("/jobs/")) {
    if (!verifyScrapeMatch(url, title)) {
      // Stale SPA cache: URL slug doesn't match rendered title — wait for correct content
      isLoaded = false;
    }
  }

  // Client name from review text (heuristic)
  let clientName = "";
  const reviewContainers = root.querySelectorAll(".review-feedback, [data-test='review-feedback'], .feedback-item, .comment");
  const reviewTexts = Array.from(reviewContainers).map(el => el.textContent.trim());
  if (reviewTexts.length === 0) {
    root.querySelectorAll("p").forEach(p => {
      const text = p.textContent.trim();
      if (text.length > 10 && text.length < 300) reviewTexts.push(text);
    });
  }
  for (const reviewText of reviewTexts) {
    const name = findNameInText(reviewText);
    if (name) { clientName = name; break; }
  }

  const rawText = cleanText(root.textContent || "");

  return {
    type: "job",
    title,
    description,
    clientCountry,
    rating,
    hireRate,
    totalSpend,
    connectsNeeded,
    isPaymentVerified,
    isHourly,
    budget,
    clientName,
    hiresCount,
    activeJobsCount,
    avgRatePaid,
    reviewsCount,
    jobAgeHours,
    clientLastViewedHours,
    interviewingCount,
    invitesSent,
    unansweredInvites,
    proposalRangeText,
    isLoaded,
    rawText: rawText.substring(0, 8000)
  };
}

// Stale title check against URL slug
function verifyScrapeMatch(url, title) {
  if (!url || !title) return false;
  
  // Convert URL and title to clean lowercase words
  const cleanUrl = url.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const words = title.toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3); // check major keywords only
    
  if (words.length === 0) return true;
  
  let matchCount = 0;
  for (const word of words) {
    if (cleanUrl.includes(word)) {
      matchCount++;
    }
  }
  
  // Match threshold: at least 40% of words or at least 2 words
  const requiredMatches = Math.min(2, Math.ceil(words.length * 0.4));
  return matchCount >= requiredMatches;
}

// Heuristic name finder in review text
function findNameInText(text) {
  if (!text) return null;
  
  const patterns = [
    /working\s+with\s+([A-Z][a-z]+)\b/i,
    /thanks\s+to\s+([A-Z][a-z]+)\b/i,
    /great\s+working\s+with\s+([A-Z][a-z]+)\b/i,
    /pleasure\s+working\s+with\s+([A-Z][a-z]+)\b/i,
    /([A-Z][a-z]+)\s+was\s+(a\s+)?(great|wonderful|excellent|awesome|fantastic)\s+client/i,
    /([A-Z][a-z]+)\s+is\s+(a\s+)?(great|wonderful|excellent|awesome|fantastic)\s+client/i,
    /highly\s+recommend\s+([A-Z][a-z]+)\b/i,
    /deal\s+with\s+([A-Z][a-z]+)\b/i,
    /([A-Z][a-z]+)\s+communicated\s+well/i,
    /communication\s+with\s+([A-Z][a-z]+)\b/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const name = match[1];
      const banned = [
        "Client", "Upwork", "Freelancer", "Him", "Her", "Them", "You", "Highly", 
        "Great", "Working", "Thanks", "Very", "Good", "Excellent", "Perfect", 
        "Project", "Job", "Work", "Seller", "Buyer"
      ];
      const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      if (!banned.includes(capitalized)) {
        return capitalized;
      }
    }
  }
  return null;
}

// Utility to normalize whitespace in DOM text content
function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}
