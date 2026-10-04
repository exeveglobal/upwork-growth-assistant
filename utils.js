// utils.js - Shared utilities and calculations (ROI scoring, error log)

// Connect cost tier label
export function getConnectsTier(n) {
  if (n === null || n === undefined) return "Unknown";
  if (n > 50) return "Extremely High";
  if (n > 30) return "High";
  if (n >= 16) return "Average";
  return "Cheap";
}

// ─── Bucket model helpers (not exported) ─────────────────────────────────────

function parseProposalCount(rangeText) {
  if (!rangeText) return null;
  const t = rangeText.toLowerCase().trim();
  if (t.includes("50+"))         return 55;
  if (t.includes("less than 5")) return 2;
  const range = t.match(/(\d+)\s+to\s+(\d+)/);
  if (range) return (parseInt(range[1]) + parseInt(range[2])) / 2;
  const single = t.match(/^(\d+)\+?$/);
  if (single) return parseInt(single[1]);
  return null;
}

function scoreHireRate(rate) {
  if (rate === null || rate === undefined) return 50;
  if (rate >= 85) return 90;
  if (rate >= 70) return 75;
  if (rate >= 35) return 55;
  if (rate >= 1)  return 30;
  return 10; // 0% — never hired
}

function scoreRating(rating) {
  if (rating === null || rating === undefined) return 50;
  if (rating >= 4.7) return 85;
  if (rating >= 4.0) return 60;
  return 20; // < 4.0 — concerning history
}

function parseSpendScore(spendStr) {
  if (!spendStr) return 40;
  const s = spendStr.toUpperCase().replace(/,/g, "").replace(/\+$/, "").trim();
  // Convert K/M/B suffix to raw number before comparing thresholds.
  // parseFloat("7.7K") = 7.7 in JS, so suffix must be handled explicitly.
  let num;
  if (/[MB]$/.test(s))   num = parseFloat(s) * 1000000;
  else if (/K$/.test(s)) num = parseFloat(s) * 1000;
  else                   num = parseFloat(s);
  if (isNaN(num)) return 40;
  if (num >= 1000000) return 95;
  if (num >= 100000)  return 85;
  if (num >= 50000)   return 75;
  if (num >= 10000)   return 65;
  if (num >= 5000)    return 55;
  if (num >= 1000)    return 50;
  return 40;
}

function scoreAge(hours) {
  if (hours === null || hours === undefined) return 55;
  if (hours < 0.5)  return 90; // < 30 min
  if (hours <= 1)   return 75; // 30 min – 1 hr
  if (hours <= 3)   return 55; // 1–3 hr
  if (hours <= 6)   return 40; // 3–6 hr
  if (hours <= 24)  return 25; // 6–24 hr
  if (hours <= 72)  return 15; // 1–3 d
  return 5;                     // > 3 d
}

function scoreProposals(count) {
  if (count === null || count === undefined) return 55;
  if (count < 5)  return 90;
  if (count < 10) return 75;
  if (count < 15) return 55;
  if (count < 20) return 40;
  if (count < 50) return 25;
  return 10; // 50+
}

function scoreInvitesSent(inv) {
  if (inv === null || inv === undefined) return 60;
  if (inv === 0) return 70;
  if (inv <= 2)  return 55;
  if (inv <= 5)  return 40;
  return 25; // > 5
}

function scoreLastViewed(hours) {
  if (hours === null || hours === undefined) return 50;
  if (hours < 3)   return 80;
  if (hours < 24)  return 65;
  if (hours <= 72) return 40;
  return 15; // > 3 d
}

function scoreInterviewing(ic, isFresh) {
  if (ic === null || ic === undefined) return isFresh ? 60 : 45;
  if (ic === 0) return isFresh ? 70 : 45;
  if (ic === 1) return 25;
  return 15; // ≥ 2
}

function scoreUnanswered(un, inv) {
  if (un === null || un === undefined || inv === null || inv === 0) return 50;
  if (un === inv)       return 75; // all unanswered
  if (un > inv / 2)     return 60; // > half
  if (un === 0)         return 25; // none unanswered
  return 50;                        // partial
}

// Bump when the scoring formula or its bands change, so stored score snapshots stay comparable.
export const SCORING_VERSION = '1';

// ROI Scoring — Weighted Bucket Model
// Final = (A×0.30 + B×0.45 + C×0.25) × payment_multiplier + connects_modifier
// Apply ≥ 75  |  Consider 45–74  |  Skip < 45
export function calculateROIScore(job) {
  const h   = job.jobAgeHours;
  const v   = job.clientLastViewedHours;
  const ic  = job.interviewingCount;
  const inv = job.invitesSent;
  const un  = job.unansweredInvites;
  const isFresh = (h === null || h === undefined || h <= 1);

  const proposalCount = parseProposalCount(job.proposalRangeText);

  // ── A: Client Track Record (30%) ──────────────────────────────────────────
  const hireScore   = scoreHireRate(job.hireRate);
  const ratingScore = scoreRating(job.rating);
  const spendScore  = parseSpendScore(job.totalSpend);
  const A = 0.40 * hireScore + 0.40 * ratingScore + 0.20 * spendScore;

  // ── B: Competitive Window (45%) ───────────────────────────────────────────
  const ageScore      = scoreAge(h);
  const proposalScore = scoreProposals(proposalCount);
  const invSentScore  = scoreInvitesSent(inv);
  const B = 0.40 * ageScore + 0.40 * proposalScore + 0.20 * invSentScore;

  // ── C: Conversion Signal (25%) ────────────────────────────────────────────
  const lastViewedScore   = scoreLastViewed(v);
  const interviewingScore = scoreInterviewing(ic, isFresh);
  const unansweredScore   = scoreUnanswered(un, inv);
  const C = 0.40 * lastViewedScore + 0.40 * interviewingScore + 0.20 * unansweredScore;

  // ── Payment trust multiplier ──────────────────────────────────────────────
  const paymentMult =
    job.isPaymentVerified === true  ? 1.10 :
    job.isPaymentVerified === false ? 0.75 : 1.00;

  // ── Connects cost flat modifier ───────────────────────────────────────────
  let connectsMod = 0;
  if (job.connectsNeeded !== null && job.connectsNeeded !== undefined) {
    if (job.connectsNeeded > 50)      connectsMod = -10;
    else if (job.connectsNeeded > 30) connectsMod = -5;
    else if (job.connectsNeeded < 16) connectsMod = 3;
  }

  const rawScore   = (0.30 * A + 0.45 * B + 0.25 * C) * paymentMult + connectsMod;
  const finalScore = Math.round(Math.max(0, Math.min(100, rawScore)));

  let label = "Consider";
  let color = "#eab308";
  if (finalScore >= 75) { label = "Apply";  color = "#10b981"; }
  else if (finalScore < 45) { label = "Skip"; color = "#ef4444"; }

  // ── Build reasons list ────────────────────────────────────────────────────
  const reasons = [];
  const Ar = Math.round(A), Br = Math.round(B), Cr = Math.round(C);

  // Payment multiplier (shown first — it scales everything)
  if (job.isPaymentVerified === true) {
    reasons.push(`+  Payment verified — ×1.10 trust boost applied`);
  } else if (job.isPaymentVerified === false) {
    reasons.push(`-  Payment UNVERIFIED — ×0.75 risk penalty applied`);
  } else {
    reasons.push(`?  Payment verification unknown`);
  }

  // Bucket A
  reasons.push(`── A · Client Track Record: ${Ar}/100`);
  if (job.hireRate !== null && job.hireRate !== undefined) {
    const dir = hireScore >= 75 ? "+" : hireScore >= 55 ? "=" : "-";
    const tag = job.hireRate >= 85 ? "Excellent" : job.hireRate >= 70 ? "Good" :
                job.hireRate >= 35 ? "Average"   : job.hireRate > 0   ? "Low"  : "Never hired";
    reasons.push(`${dir}  Hire rate ${job.hireRate}% — ${tag}`);
  } else {
    reasons.push(`=  Hire rate unknown`);
  }
  if (job.rating !== null && job.rating !== undefined) {
    const dir = ratingScore >= 75 ? "+" : ratingScore >= 55 ? "=" : "-";
    reasons.push(`${dir}  Rating ${job.rating}★`);
  }
  if (job.totalSpend) {
    reasons.push(`+  Spend $${job.totalSpend}`);
  } else {
    reasons.push(`=  No spend history on file`);
  }

  // Bucket B
  reasons.push(`── B · Competitive Window: ${Br}/100`);
  {
    const dir = ageScore >= 75 ? "+" : ageScore >= 40 ? "=" : "-";
    let ageLabel;
    if (h === null || h === undefined)   ageLabel = "age unknown";
    else if (h === 0)                    ageLabel = "just posted";
    else if (h < 1)                      ageLabel = `${Math.round(h * 60)}min old`;
    else if (h < 24)                     ageLabel = `${Math.round(h)}hr old`;
    else                                 ageLabel = `${Math.round(h / 24)}d old`;
    reasons.push(`${dir}  Posted ${ageLabel}`);
  }
  if (job.proposalRangeText) {
    const dir = proposalScore >= 75 ? "+" : proposalScore >= 40 ? "=" : "-";
    reasons.push(`${dir}  ${job.proposalRangeText} proposals`);
  } else {
    reasons.push(`=  Proposal count unknown`);
  }
  if (inv !== null && inv !== undefined) {
    const dir = invSentScore >= 60 ? "+" : invSentScore >= 40 ? "=" : "-";
    reasons.push(`${dir}  ${inv} invite(s) sent`);
  }

  // Bucket C
  reasons.push(`── C · Conversion Signal: ${Cr}/100`);
  if (v !== null && v !== undefined) {
    const dir = lastViewedScore >= 70 ? "+" : lastViewedScore >= 55 ? "=" : "-";
    const vLabel = v === 0    ? "just now"
                 : v < 1     ? `${Math.round(v * 60)}min ago`
                 : v < 24    ? `${Math.round(v)}hr ago`
                 : `${Math.round(v / 24)}d ago`;
    reasons.push(`${dir}  Client viewed ${vLabel}`);
  } else {
    reasons.push(`=  Client view time unknown`);
  }
  if (ic !== null && ic !== undefined) {
    const dir = interviewingScore >= 60 ? "+" : interviewingScore >= 40 ? "=" : "-";
    reasons.push(`${dir}  ${ic} freelancer(s) interviewing`);
  }
  if (un !== null && un !== undefined && inv !== null && inv > 0) {
    const dir = unansweredScore >= 60 ? "+" : unansweredScore >= 40 ? "=" : "-";
    reasons.push(`${dir}  ${un}/${inv} invites unanswered`);
  }

  // Connects note
  if (job.connectsNeeded !== null && job.connectsNeeded !== undefined) {
    const tier = getConnectsTier(job.connectsNeeded);
    const dir  = connectsMod > 0 ? "+" : connectsMod < 0 ? "-" : "=";
    reasons.push(`${dir}  ${job.connectsNeeded} connects (${tier})`);
  }

  return {
    score: finalScore, label, color, reasons,
    buckets: { A: Ar, B: Br, C: Cr },
    paymentMultiplier: paymentMult,
    connectsModifier: connectsMod
  };
}

// ─── Error Logging ─────────────────────────────────────────────────────────────
// Persists up to 50 error entries in chrome.storage.local["errorLog"].
// Each entry: { id, ts, context, url, message, stack }

export function logError(context, message, url = '', stack = '') {
  chrome.storage.local.get({ errorLog: [] }, ({ errorLog }) => {
    errorLog.push({
      id: Date.now().toString(),
      ts: new Date().toISOString(),
      context,
      url,
      message,
      stack
    });
    if (errorLog.length > 50) errorLog.splice(0, errorLog.length - 50);
    chrome.storage.local.set({ errorLog });
  });
}

export function getErrorLog() {
  return new Promise(resolve => {
    chrome.storage.local.get({ errorLog: [] }, ({ errorLog }) => resolve(errorLog));
  });
}

export function clearErrorLog() {
  return new Promise(resolve => chrome.storage.local.set({ errorLog: [] }, resolve));
}
