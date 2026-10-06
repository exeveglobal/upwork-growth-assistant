// proposals-scan.js - Reads the rows on Upwork's "Proposals and offers" page.
//
// Only runs while the member has /nx/proposals/ (or /archived) open: it never navigates, clicks or
// pages through the list. It reports the visible rows to the service worker (proposals-sync.js),
// which matches them to proposals the extension already knows about. Selectors observed on a live
// account; see docs/UPWORK-PROPOSALS-PAGE.md. Keep them all in here.

(() => {
  if (globalThis.__ugaProposalsScan) return;

  const PAGE = /^\/nx\/proposals\/?(archived\/?)?$/;
  const MAX_ROWS = 100;
  const POLL_MS = 1500;

  // Which list a row belongs to. Archived is verified; active/submitted are inferred from the section heading.
  function sectionOf(tr) {
    const sub = tr.getAttribute('data-ev-sublocation') || '';
    if (/archived_proposals/i.test(sub)) return 'archived';
    const section = tr.closest('section');
    const heading = section && section.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    const label = `${heading ? heading.innerText : ''} ${sub}`;
    if (/active/i.test(label)) return 'active';
    if (/submitted/i.test(label)) return 'submitted';
    return 'unknown';
  }

  function readRows(doc) {
    const rows = [];
    for (const tr of doc.querySelectorAll('tr.details-row')) {
      const sub = tr.getAttribute('data-ev-sublocation') || '';
      if (/interview|invite|offer|referral/i.test(sub)) continue; // client invitations are not our proposals

      const link = tr.querySelector('a[data-ev-label="jpn_list_details_link"], td.job-info a[href*="/nx/proposals/"]');
      const id = link && /\/nx\/proposals\/(\d{6,30})(?:[/?#]|$)/.exec(link.getAttribute('href') || '');
      if (!id) continue; // e.g. /nx/proposals/interview/uid/...

      const text = (selector) => ((tr.querySelector(selector) || {}).innerText || '').trim();
      rows.push({
        proposalId: id[1],
        title: (link.innerText || '').trim().slice(0, 300),
        initiated: text('td.time-slot').split('\n')[0].trim().slice(0, 60), // "Initiated Sep 6, 2026"
        reason: text('td.reason-slot').slice(0, 100),                        // "Job is closed", "Hired"
        section: sectionOf(tr)
      });
      if (rows.length >= MAX_ROWS) break;
    }
    return rows;
  }

  // ── learning aid: the structure of a submitted proposal's own page ───────────────────────────────
  // Editing a sent proposal's price happens on Upwork, on pages whose layout we have not seen yet. While the
  // member has such a page open, remember only its STRUCTURE (form field ids and types, button labels) so the
  // diagnostics can show how to capture edits automatically in a future version. No text the member wrote.
  const DETAIL = /^\/nx\/proposals\/\d{6,30}(\/[A-Za-z-]+)?\/?$/;

  function describeProposalPage(doc, pathname) {
    const controls = [...doc.querySelectorAll('input, textarea, select')]
      .filter(el => el.type !== 'hidden' && el.type !== 'file')
      .slice(0, 25)
      .map(el => [String(el.tagName).toLowerCase(), el.type || '', el.id || '', el.name || '', (el.getAttribute('aria-labelledby') || el.getAttribute('aria-label')) ? 'labelled' : ''].join('|'));
    const buttons = [...doc.querySelectorAll('button, a[role="button"]')]
      .map(b => String(b.innerText || '').trim())
      .filter(t => t.length > 0 && t.length < 40 && /^(update|save|submit|send|change|edit|withdraw|cancel|view)\b/i.test(t))
      .slice(0, 12);
    return { path: pathname.replace(/\d{6,30}/g, '<id>'), controls, buttons };
  }

  /** Which list this URL shows: the archive, or the Active/Submitted page. */
  const pageOf = (pathname) => (/archived/.test(pathname || '') ? 'archived' : 'active');

  /** The lists render their section headings ("Active proposals (0)") once loaded, even when empty. */
  const listLoaded = (text) => /(Active|Submitted|Archived) proposals\s*\(\d+\)/i.test(text || '');

  globalThis.__ugaProposalsScan = { readRows, PAGE, pageOf, listLoaded, DETAIL, describeProposalPage };

  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

  // The page is a SPA: poll while it is showing, and report whenever the visible rows change. An
  // empty list is reported too (once it has loaded): "nothing is open any more" is a real answer.
  let last = '';
  let lastDetail = '';
  setInterval(() => {
    if (DETAIL.test(location.pathname) && document.visibilityState === 'visible') {
      const d = describeProposalPage(document, location.pathname);
      const fingerprint = JSON.stringify(d);
      if (fingerprint !== lastDetail && (d.controls.length || d.buttons.length)) {
        lastDetail = fingerprint;
        try { chrome.runtime.sendMessage({ action: 'diag', kind: 'proposal.page_structure', detail: d }).catch(() => {}); } catch { /* extension reloaded */ }
      }
      return;
    }
    lastDetail = '';
    if (!PAGE.test(location.pathname) || document.visibilityState !== 'visible') { last = ''; return; }
    const rows = readRows(document);
    const loaded = rows.length > 0 || listLoaded((document.querySelector('main') || document.body).innerText);
    if (!loaded) return;
    const page = pageOf(location.pathname);
    const fingerprint = JSON.stringify([page, rows]);
    if (fingerprint === last) return;
    last = fingerprint;
    try { chrome.runtime.sendMessage({ action: 'proposalsRows', rows, page }).catch(() => {}); } catch { /* extension reloaded */ }
  }, POLL_MS);
})();
