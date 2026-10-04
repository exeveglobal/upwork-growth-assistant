// activity.js - Counts active time on upwork.com.
//
// A 5-second slice counts only when this tab is visible AND the member did something (mouse,
// keys, scroll, touch) within the last 60 seconds. It records only slice numbers: no URLs, no
// page content, nothing about what was on screen. The service worker de-duplicates slices
// across tabs and only keeps them while the member is connected.

(() => {
  if (globalThis.__ugaActivity) return;
  globalThis.__ugaActivity = true;
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

  const TICK_MS = 5000;
  const IDLE_MS = 60 * 1000;
  const SEND_EVERY_MS = 30 * 1000;

  let lastInput = Date.now();
  let slices = [];

  const touch = () => { lastInput = Date.now(); };
  for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart']) {
    window.addEventListener(type, touch, { passive: true, capture: true });
  }

  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS) {
      slices.push(Math.floor(Date.now() / TICK_MS));
    }
  }, TICK_MS);

  function send(final) {
    if (!slices.length && !final) return;
    const batch = slices;
    slices = [];
    try {
      chrome.runtime.sendMessage({ action: 'activityTicks', slices: batch, final: !!final }).catch(() => {});
    } catch { /* extension reloaded */ }
  }

  setInterval(() => send(false), SEND_EVERY_MS);
  // Leaving the tab or closing it flushes immediately, so short visits aren't lost.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true); });
  window.addEventListener('pagehide', () => send(true));
})();
