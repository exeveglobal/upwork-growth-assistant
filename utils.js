// utils.js - Shared utilities, API clients, and calculations

// Placeholder license check for future commercialization
export async function checkLicenseStatus() {
  // In future versions, this will read a license key from chrome.storage.local 
  // and verify it against a server (e.g. Stripe, ExtensionPay, or Gumroad).
  try {
    const data = await chrome.storage.local.get(["licenseKey"]);
    if (data.licenseKey) {
      // Mock validation: keys starting with 'PREM-' are premium
      if (data.licenseKey.startsWith("PREM-")) {
        return { status: "active", tier: "premium", expires: "2027-12-31" };
      }
    }
    // Default fallback to active free tier for open-source version
    return { status: "active", tier: "free_tier", expires: "lifetime" };
  } catch (e) {
    return { status: "active", tier: "free_tier" };
  }
}

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

  return { score: finalScore, label, color, reasons };
}

// Generate the specific prompt for proposal hooks and full proposal
export function buildProposalPrompt(job, freelancer, tone) {
  const bioContext = freelancer.bio ? `Freelancer Experience Summary:\n${freelancer.bio}` : "";
  const nicheContext = freelancer.niche ? `Target Niche/Keywords: ${freelancer.niche}` : "";
  const rateContext = freelancer.rate ? `Hourly Rate: ${freelancer.rate}` : "";
  const clientNameContext = job.clientName 
    ? `Client Name (extracted from review history): ${job.clientName}` 
    : "Client Name: Unknown (use a friendly general greeting like 'Hi,' or 'Hi there,')";

  return `
You are a world-class freelancer copywriting expert. Your goal is to write a highly persuasive, non-templated Upwork proposal that reads like a natural, high-value consultant, NOT a robotic AI.

=== JOB POST DETAILS ===
Title: ${job.title}
${clientNameContext}
Budget: ${job.budget}
Hourly/Fixed: ${job.isHourly ? "Hourly" : "Fixed-Price"}
Description: 
${job.description || job.rawText}

=== FREELANCER CONTEXT ===
${bioContext}
${nicheContext}
${rateContext}

=== INSTRUCTIONS & CUSTOMER PSYCHOLOGY RULES ===
1. **Personalization / Greeting**: If the Client Name is provided, greet them directly (e.g. 'Hi ${job.clientName || "[Name]"},' or 'Hi ${job.clientName || "[Name]"} -'). If the Client Name is unknown, use a friendly generic greeting like 'Hi,' or 'Hi there,'. NEVER use robotic or archaic templates like 'Dear Hiring Manager', 'Dear Client', or 'Hi [Hiring Manager]'.
2. **No Technical Dumps**: Do not write a bullet-point list of every technology you know. Instead, focus entirely on the client's core problem and how you will solve it.
3. **Strictly Ban Generic Openings**: NEVER start the first line with "Hello, my name is...", "I am writing to apply...", or "I am a senior developer...".
4. **The "First 2 Lines" Rule**: The client only sees the first 2 lines in their proposal feed. The hook must instantly state a solution, reference a similar project, or ask a sharp, insightful technical question about their specific problem to stand out.
5. **The Case Study Hook**: Give a single-sentence proof of execution: "I recently solved a similar issue with X by doing Y, which resulted in Z."
6. **No AI Clichés**: Avoid words like "leverage", "delve", "testament", "innovative", "cutting-edge", "robust", "game-changing". Keep the tone human, confident, and professional.
7. **Low-Friction CTA**: Close with an easy, low-commitment question or offer (e.g. "Should I send over a quick 2-line draft of how we would structure this?" or "I have a specific question about [variable] in your post—could you clarify?").

=== OUTPUT FORMAT ===
Generate your response in EXACTLY the following structure. Use clear markdown sections. Do not include any meta-introductions (like "Here is your proposal").

### 1. Three Opening Hook Options (First 2 Lines Only)
Create 3 distinct psychological approaches for the hook:
- **Option A (Case Study/Proof-centric)**: Focuses on a similar result you've achieved.
- **Option B (Question/Discovery-centric)**: Focuses on asking a highly relevant technical/scoping question about their job description.
- **Option C (Immediate Value/Solution-centric)**: Focuses on outlining the immediate first step to resolve their issue.

---

### 2. Tailored Proposal Body
Write a concise, complete proposal (under 250 words total) using the Hook Option A. It should flow naturally:
- **Opening**: Hook Option A.
- **Body**: How you approach their problem, why your experience aligns, and what result they can expect. Keep it brief and focused.
- **Closing**: A low-friction Call to Action (CTA) asking a clarifying question or offering a small quick win.
`;
}

// Generate the specific prompt for profile optimization
export function buildProfilePrompt(profile, targetNiche) {
  return `
You are an SEO and copywriting expert specializing in Upwork profile optimization. Your goal is to analyze the freelancer's current profile details and provide highly actionable recommendations to increase search visibility and client conversion.

=== CURRENT PROFILE ===
Title: ${profile.title}
Hourly Rate: ${profile.rate}
Skills: ${profile.skills.join(", ")}
Overview Bio:
${profile.overview || profile.rawText}

=== TARGET NICHE ===
${targetNiche || "General Freelancer (optimize for current skills)"}

=== INSTRUCTIONS ===
1. **Analyze Title**: Is it clear, keyword-optimized, and hook-focused? Suggest 3 alternative titles.
2. **Analyze Skills Tags**: Are there missing key tags Upwork's search engine searches for? Suggest additions.
3. **Overview Review**: Does it have an engaging hook in the first 3 lines? Is it structured with bullet points and clear value propositions?
4. **Draft Optimized Bio**: Rewrite the profile bio overview. Keep it professional, structured (Hook, Pain point, Solutions, Social proof/results, CTA), and highly readable.

=== OUTPUT FORMAT ===
Generate your response in clean markdown with the following sections:
- **SEO & Search Visibility Score (0-100)**: Rate the profile and give 2 key reasons.
- **Title Optimizations**: 3 suggested alternatives.
- **Recommended Skills Tags**: Up to 5 tags to add/swap.
- **Key Critique Points**: 2-3 bullet points of what's currently holding them back.
- **Optimized Bio Rewrite**: Complete, drop-in replacement bio.
`;
}

// API Dispatcher supporting Gemini and Anthropic
export async function callLLM({ provider, model, apiKey, prompt }) {
  if (provider === "gemini") {
    return callGemini(model, apiKey, prompt);
  } else if (provider === "anthropic") {
    return callClaude(model, apiKey, prompt);
  } else {
    throw new Error("Unsupported API provider selected.");
  }
}

// Google Gemini API Client
async function callGemini(model, apiKey, prompt) {
  const modelName = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Gemini API returned status ${response.status}`);
  }

  const resData = await response.json();
  const text = resData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Empty response returned from Gemini API.");
  }
  return text;
}

// Anthropic Claude API Client
async function callClaude(model, apiKey, prompt) {
  const modelName = model || "claude-sonnet-4-6";
  const url = "https://api.anthropic.com/v1/messages";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Crucial header allowing browser extensions to call Anthropic directly
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Claude API returned status ${response.status}`);
  }

  const resData = await response.json();
  const text = resData.content?.[0]?.text;
  if (!text) {
    throw new Error("Empty response returned from Claude API.");
  }
  return text;
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
