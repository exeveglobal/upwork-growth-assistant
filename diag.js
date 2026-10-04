// diag.js - Local diagnostics log (chrome.storage.local["diag"], newest last, capped).
//
// Upwork's pages change without notice. Whenever the extension meets something it cannot read or
// does not recognise (a selector that found nothing, a status reason it has never seen, a Connects
// history action it has no rule for), it records ONE short entry here so selectors can be fixed from
// real evidence instead of guesses. Entries hold structure only (selector names, labels, counts):
// never cover letters, messages, client names or other page content.
// The member can copy the log from the side panel; nothing is sent automatically.

const KEY = 'diag';
export const DIAG_MAX = 200;
const DEDUPE_MS = 60 * 60 * 1000; // the same finding is recorded at most once an hour

let chain = Promise.resolve();

/** Records a finding. Never throws: diagnostics must not break tracking. */
export function logDiag(kind, detail = {}, now = Date.now()) {
  const run = chain.then(async () => {
    const { [KEY]: entries = [] } = await chrome.storage.local.get(KEY);
    const sig = `${kind}|${JSON.stringify(detail)}`;
    const dup = [...entries].reverse().find(e => e.sig === sig);
    if (dup && now - dup.at < DEDUPE_MS) {
      dup.count = (dup.count || 1) + 1;
    } else {
      entries.push({ at: now, kind, detail, sig, count: 1 });
    }
    await chrome.storage.local.set({ [KEY]: entries.slice(-DIAG_MAX) });
  });
  chain = run.catch(() => {});
  return run.catch(() => {});
}

export async function readDiag() {
  const { [KEY]: entries = [] } = await chrome.storage.local.get(KEY);
  return entries;
}

export const clearDiag = () => chrome.storage.local.remove(KEY);

/** Plain-text export for the "Copy diagnostics" button. */
export function formatDiag(entries, version = '') {
  const lines = entries.map(e =>
    `${new Date(e.at).toISOString()}  ${e.kind}${e.count > 1 ? ` x${e.count}` : ''}  ${JSON.stringify(e.detail)}`
  );
  return [`Upwork Growth Assistant diagnostics${version ? ` v${version}` : ''} (${entries.length} entries)`, ...lines].join('\n');
}
