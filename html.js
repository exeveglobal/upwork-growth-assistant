// html.js - Escaping for the few places the side panel builds HTML from strings.
// Page text (job titles, error messages, URLs) is untrusted: it must never reach innerHTML unescaped.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Safe for element text and for attribute values in single or double quotes. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => MAP[ch]);
}
