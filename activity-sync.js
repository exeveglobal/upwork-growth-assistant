// activity-sync.js - Service-worker side of active-time tracking.
//
// activity.js reports 5-second "slices" (slice number = floor(epoch ms / 5000)). Slices are
// de-duplicated here, so two visible Upwork tabs never double count, and only kept while a member
// is connected. Accumulated seconds are sent as `activity.time` DELTAS per local day once 5
// minutes have built up, when a tab is left or closed, and on a 5-minute alarm.

import { getConnection } from './connection.js';
import { enqueue } from './outbox.js';

export const SLICE_SECONDS = 5;
export const FLUSH_AT_SECONDS = 300;
const SLICE_MS = SLICE_SECONDS * 1000;
const MAX_SLICES_PER_MESSAGE = 200;
const KEEP_SEEN = 1500; // ~2 hours of slices
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Local calendar day, "YYYY-MM-DD". */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

async function load(memberId) {
  const { activityState } = await chrome.storage.local.get('activityState');
  // Seconds counted for a different member (shared browser) are never attributed to this one
  return activityState && activityState.memberId === memberId ? activityState : { memberId, seen: [], pending: {} };
}

export function handleActivityTicks({ slices, final } = {}, now = Date.now()) {
  return serial(async () => {
    const conn = await getConnection();
    if (!conn) return { counted: 0 }; // Free tier / disconnected: nothing is kept
    const state = await load(conn.member.id);

    const seen = new Set(state.seen);
    let counted = 0;
    for (const slice of Array.isArray(slices) ? slices.slice(0, MAX_SLICES_PER_MESSAGE) : []) {
      const ms = slice * SLICE_MS;
      if (!Number.isInteger(slice) || ms > now + SLICE_MS || ms < now - MAX_AGE_MS || seen.has(slice)) continue;
      seen.add(slice);
      const day = localDay(ms);
      state.pending[day] = (state.pending[day] || 0) + SLICE_SECONDS;
      counted++;
    }
    state.seen = [...seen].sort((a, b) => a - b).slice(-KEEP_SEEN);

    const total = Object.values(state.pending).reduce((a, b) => a + b, 0);
    if (final || total >= FLUSH_AT_SECONDS) await send(state);
    await chrome.storage.local.set({ activityState: state });
    return { counted };
  });
}

/** Sends whatever has accumulated (used by the 5-minute alarm). */
export function flushActivity() {
  return serial(async () => {
    const conn = await getConnection();
    if (!conn) return;
    const { activityState } = await chrome.storage.local.get('activityState');
    if (!activityState || activityState.memberId !== conn.member.id) return;
    await send(activityState);
    await chrome.storage.local.set({ activityState });
  });
}

async function send(state) {
  for (const [day, seconds] of Object.entries(state.pending)) {
    if (seconds <= 0) continue;
    // Keep the seconds if queuing fails (e.g. just disconnected); they go out on a later flush
    if (await enqueue('activity.time', { day, activeSeconds: Math.min(seconds, 86_400) })) delete state.pending[day];
  }
}
