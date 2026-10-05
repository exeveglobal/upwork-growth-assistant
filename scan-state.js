// scan-state.js - What the side panel may show for a scan result.
//
// Upwork renders a job view in stages, so a scrape can find the title and description well before
// the Connects cost and client stats exist. Scoring that half-read job gives a plausible but wrong
// number, so an unfinished job shows "loading" until it is complete. Only after `partialAfterTicks`
// polls (a page that never shows, say, a Connects cost) is what exists shown, marked as incomplete.

export const PARTIAL_AFTER_TICKS = 10;

/** 'show' (complete or not a job), 'loading' (wait, show no score) or 'partial' (show, marked incomplete). */
export function scanDisplay(data, ticksWaited, partialAfterTicks = PARTIAL_AFTER_TICKS) {
  if (!data || data.type !== 'job' || data.isLoaded) return 'show';
  return ticksWaited >= partialAfterTicks ? 'partial' : 'loading';
}
