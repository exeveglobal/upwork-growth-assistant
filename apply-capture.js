// apply-capture.js - Reads Upwork's "Submit a proposal" form at the moment the member clicks Send.
//
// Runs on every upwork.com page (the apply page is often reached by in-app navigation, which
// never re-injects content scripts) and only acts when the URL is an apply page. It does not
// click, type or navigate anything: it only reads what the member entered and reports it to the
// service worker, which decides whether the proposal was really sent (see capture.js).
//
// Selectors were observed on live pages; see docs/UPWORK-APPLY-PAGE.md. Keep them all in here.

(() => {
  if (globalThis.__ugaApplyCapture) return; // already injected

  const APPLY_PATH = /\/nx\/proposals\/job\/(~[0-9A-Za-z]{10,40})\/apply/;
  const MAX_QUESTIONS = 30;

  // ── pure text parsers (unit-tested without a DOM) ──────────────────────────
  const intIn = (text, re) => {
    const m = re.exec(text || '');
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : undefined;
  };

  /** "$1,000.50" -> 1000.5, "-$10.00" -> 10 (sign ignored), "" -> undefined */
  function money(value) {
    const m = /(\d[\d,]*\.?\d*)/.exec(String(value ?? ''));
    return m ? Number(m[1].replace(/,/g, '')) : undefined;
  }

  function parseSummary(text) {
    return {
      connectsRequired: intIn(text, /This proposal requires\s+([\d,]+)\s+Connects?/i),
      connectsBoost: intIn(text, /Bid to boost:\s*([\d,]+)\s*Connects?/i),
      connectsTotal: intIn(text, /Total:\s*([\d,]+)\s*Connects?/i),
      connectsRemainingAfter: intIn(text, /you['’]ll have\s+([\d,]+)\s+Connects?\s+remaining/i),
      serviceFeePct: intIn(text, /Service Fee:\s*(\d+)\s*%/i)
    };
  }

  /** From the checked radio's label: "As an agency member under EXEVE Global (0 Connects available.)" */
  function parseApplyAs(label) {
    const agency = /agency member under (.+?)\s*\(/i.exec(label || '');
    return {
      applyAs: agency ? `agency:${agency[1].trim()}` : 'freelancer',
      connectsAvailableBefore: intIn(label, /\(\s*([\d,]+)\s+Connects? available/i)
    };
  }

  /**
   * Position our boost would take among the listed top-4 bids. Ties lose ("Bid 51 or higher to be
   * 1st" when the top bid is 50). undefined when there is no boost or it would rank below 4th.
   */
  function parseBoostRank(text, boost) {
    if (!boost) return undefined;
    const bids = [...(text || '').matchAll(/(?:1st|2nd|3rd|4th) place\s*(?:No bids|([\d,]+)\s*Connects?)/gi)]
      .map(m => (m[1] ? parseInt(m[1].replace(/,/g, ''), 10) : null))
      .filter(v => v !== null);
    const rank = 1 + bids.filter(b => b >= boost).length;
    return rank <= 4 ? rank : undefined;
  }

  /** The job title is the first line after the "Job details" heading. */
  function parseTitle(text) {
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const i = lines.indexOf('Job details');
    return i >= 0 ? lines[i + 1] : undefined;
  }

  // ── DOM reader ─────────────────────────────────────────────────────────────
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));

  function readDuration(doc) {
    for (const toggle of doc.querySelectorAll('[data-test="dropdown-toggle"]')) {
      for (let el = toggle, i = 0; el && i < 5; el = el.parentElement, i++) {
        if (/How long will this project take/i.test(el.innerText || '')) {
          const text = (toggle.innerText || '').trim();
          return /^select/i.test(text) ? undefined : text;
        }
      }
    }
    return undefined;
  }

  /**
   * Fixed-price terms. "By project" = one payment at the end; "By milestone" = several, each with
   * its own amount. Milestone rows are read by what their inputs are called, since the layout of
   * that section has not been observed yet: whatever cannot be read is reported through `unread`.
   */
  function readPaymentMode(doc) {
    const radio = doc.querySelector('input[name="milestoneMode"]:checked');
    if (!radio) return undefined;
    return radio.value === 'milestone' ? 'milestone' : 'project';
  }

  function readMilestones(doc) {
    const fields = [...doc.querySelectorAll('input, textarea')].filter(el =>
      /milestone/i.test(`${el.id} ${el.name} ${el.getAttribute('aria-label') || ''}`) && el.name !== 'milestoneMode' && el.type !== 'radio'
    );
    const rows = new Map();
    for (const el of fields) {
      const row = el.closest('[data-test*="milestone" i], li, fieldset, .form-group') || el.parentElement;
      if (!rows.has(row)) rows.set(row, { description: undefined, amount: undefined, dueDate: undefined });
      const entry = rows.get(row);
      const hint = `${el.id} ${el.name} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-test') || ''}`;
      if (/amount|price|currency/i.test(hint) || el.getAttribute('data-test') === 'currency-input') entry.amount = money(el.value);
      else if (/due|date/i.test(hint) || el.type === 'date') entry.dueDate = (el.value || '').trim().slice(0, 40) || undefined;
      else entry.description = (el.value || '').trim().slice(0, 300) || undefined;
    }
    return [...rows.values()].map(clean).filter(m => m.amount !== undefined || m.description).slice(0, 20);
  }

  function readForm(doc, url) {
    const main = doc.querySelector('main') || doc.body;
    const text = main.innerText || '';
    const jobId = (APPLY_PATH.exec(url) || [])[1];

    const radio = doc.querySelector('input[name="contractor-selector"]:checked');
    const radioLabel = radio ? (radio.closest('label') || {}).innerText || '' : '';
    const summary = parseSummary(text);

    const fixedBid = doc.querySelector('#charged-amount-id');
    const hourlyRate = doc.querySelector('#step-rate');
    const contractType = fixedBid ? 'fixed' : hourlyRate ? 'hourly' : undefined;
    const received = doc.querySelector('#earned-amount-id, #receive-step-rate');

    const questions = safe(() =>
      [...doc.querySelectorAll('.fe-proposal-job-questions .form-group')]
        .slice(0, MAX_QUESTIONS)
        .map(g => ({
          question: ((g.querySelector('label') || {}).innerText || '').trim().slice(0, 1000),
          answer: ((g.querySelector('textarea') || {}).value || '').trim().slice(0, 10000)
        }))
        .filter(q => q.question)
    );

    const paymentMode = contractType === 'fixed' ? safe(() => readPaymentMode(doc)) : undefined;
    const milestones = paymentMode === 'milestone' ? safe(() => readMilestones(doc)) : undefined;
    const unread = [];
    if (!contractType) unread.push('contractType');
    if (contractType === 'fixed' && !paymentMode) unread.push('paymentMode');
    if (paymentMode === 'milestone' && !(milestones && milestones.length)) unread.push('milestones');

    const cover = safe(() => doc.querySelector('textarea[aria-labelledby="cover_letter_label"]').value.trim());

    return clean({
      jobId,
      title: safe(() => parseTitle(text)),
      ...safe(() => parseApplyAs(radioLabel)),
      ...summary,
      boostRank: safe(() => parseBoostRank(text, summary.connectsBoost)),
      contractType,
      paymentMode,
      milestones: milestones && milestones.length ? milestones : undefined,
      unread: unread.length ? unread : undefined,
      bidAmount: contractType === 'fixed' ? safe(() => money(fixedBid.value)) : undefined,
      hourlyRate: contractType === 'hourly' ? safe(() => money(hourlyRate.value)) : undefined,
      youReceive: safe(() => money(received.value)),
      duration: safe(() => readDuration(doc)),
      coverLetter: cover ? cover.slice(0, 20000) : undefined,
      questions: questions && questions.length ? questions : undefined
    });
  }

  globalThis.__ugaApplyCapture = { readPaymentMode, readMilestones, parseSummary, parseApplyAs, parseBoostRank, parseTitle, money, readForm };

  // ── wiring ─────────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

  const report = (action, data) => {
    try { chrome.runtime.sendMessage({ action, data }).catch(() => {}); } catch { /* extension reloaded */ }
  };

  // Capture phase so we read the form before Upwork's own handler can navigate away.
  document.addEventListener('click', (e) => {
    if (!APPLY_PATH.test(location.pathname)) return;
    const button = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!button) return;
    const label = (button.innerText || '').trim();
    if (/^Send for\s+[\d,]+\s+Connects?$/i.test(label)) {
      report('applySendClicked', readForm(document, location.href));
    } else if (/^Cancel$/i.test(label)) {
      report('applyCancelled');
    }
  }, true);
})();
