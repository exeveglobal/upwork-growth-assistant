// outbox.js - Offline-safe event queue for the Exeve growth engine.
//
// Events are written to chrome.storage.local (one key per event, so concurrent writers in the
// side panel and the service worker can't clobber each other) and sent in order, in batches.
// The engine deduplicates by eventId, so re-sending after a failure is always safe.

import { noteSyncResult } from './sync-issues.js';
import { getConnection, authFetch, NotConnectedError } from './connection.js';
import { logError } from './utils.js';

const PREFIX = 'ob:';
const MAX_QUEUE = 2000;
const MAX_BATCH_EVENTS = 50;
const MAX_BATCH_BYTES = 400_000; // engine body limit is 1 MB

let flushing = null;
let flushAgain = false;
let seq = 0;

// Keys sort by time, then by a per-context counter, so events queued in the same millisecond
// keep their order (a status change must never overtake the proposal it refers to).
const keyFor = (event) =>
  `${PREFIX}${String(Date.now()).padStart(15, '0')}:${String(seq++ % 1_000_000).padStart(6, '0')}:${event.eventId}`;

async function queuedKeys(all) {
  return Object.keys(all ?? (await chrome.storage.local.get(null))).filter(k => k.startsWith(PREFIX)).sort();
}

/**
 * Queues an event for the connected member and kicks off a send. No-op (returns false) when not
 * connected: the Free tier never records or sends anything.
 */
export async function enqueue(type, payload, { occurredAt = new Date().toISOString(), scoringVersion } = {}) {
  const conn = await getConnection();
  if (!conn) return false;

  const event = {
    eventId: crypto.randomUUID(),
    type,
    occurredAt,
    extensionVersion: chrome.runtime.getManifest().version,
    ...(scoringVersion && { scoringVersion }),
    payload
  };
  await chrome.storage.local.set({ [keyFor(event)]: { memberId: conn.member.id, event } });

  const keys = await queuedKeys();
  if (keys.length > MAX_QUEUE) {
    await chrome.storage.local.remove(keys.slice(0, keys.length - MAX_QUEUE));
    logError('outbox → overflow', `Queue exceeded ${MAX_QUEUE}; dropped ${keys.length - MAX_QUEUE} oldest events`);
  }

  flush().catch(() => {});
  return true;
}

export async function pendingCount() {
  return (await queuedKeys()).length;
}

/**
 * Sends queued events. One flush at a time per context; safe to call from anywhere, any time.
 * A call that arrives mid-flush schedules one more pass, so events queued (or a connection made)
 * after the running pass looked at the queue are never left waiting for the next alarm.
 */
export function flush() {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    let sent = 0;
    let result;
    do {
      flushAgain = false;
      result = await doFlush();
      sent += result.sent;
    } while (flushAgain);
    return { ...result, sent };
  })().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  const conn = await getConnection();
  if (!conn) return { sent: 0, stopped: 'not_connected' };

  const all = await chrome.storage.local.get(null);
  let keys = await queuedKeys(all);

  // Never send one member's events under another member's token (shared browser, new key).
  const foreign = keys.filter(k => all[k].memberId !== conn.member.id);
  if (foreign.length) {
    await chrome.storage.local.remove(foreign);
    keys = keys.filter(k => !foreign.includes(k));
  }

  let sent = 0;
  while (keys.length) {
    const batch = takeBatch(keys, all);
    let res;
    try {
      res = await authFetch('/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch.map(k => all[k].event) })
      }, { expectToken: conn.token });
    } catch (err) {
      return { sent, stopped: err instanceof NotConnectedError ? 'not_connected' : 'offline' };
    }

    if (res.status === 200) {
      let results;
      try { ({ results } = await res.json()); } catch { return { sent, stopped: 'retry' }; }
      for (const [i, r] of results.entries()) {
        const rec = all[batch[i]];
        if (r.status === 'rejected') logError('outbox → event rejected', `${rec?.event.type}: ${r.error}`);
        if (rec) await noteSyncResult(rec.event, rec.memberId, r);
      }
      await chrome.storage.local.remove(batch);
      sent += batch.length;
    } else if (res.status === 400 || res.status === 413) {
      // The engine will never accept this batch as-is. Drop it so the queue can't jam forever.
      logError('outbox → batch refused', `HTTP ${res.status} for ${batch.length} events`);
      await chrome.storage.local.remove(batch);
    } else {
      return { sent, stopped: 'retry' }; // 429 / 5xx: keep everything, try again later
    }
  }
  return { sent, stopped: null };
}

// Removes and returns the next batch of keys, bounded by event count and request size.
function takeBatch(keys, all) {
  const batch = [];
  let bytes = 0;
  while (keys.length && batch.length < MAX_BATCH_EVENTS) {
    const size = JSON.stringify(all[keys[0]].event).length;
    if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
    bytes += size;
    batch.push(keys.shift());
  }
  return batch;
}
