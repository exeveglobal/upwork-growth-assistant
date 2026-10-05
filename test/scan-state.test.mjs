import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDisplay, PARTIAL_AFTER_TICKS } from '../scan-state.js';

test('a fully loaded job is shown', () => {
  assert.equal(scanDisplay({ type: 'job', isLoaded: true }, 0), 'show');
});

test('a half-rendered job shows "loading", never a score, while the page may still finish', () => {
  const half = { type: 'job', isLoaded: false, title: 'T', description: 'x'.repeat(80), connectsNeeded: null };
  for (let ticks = 0; ticks < PARTIAL_AFTER_TICKS; ticks++) assert.equal(scanDisplay(half, ticks), 'loading');
});

test('a job that never finishes is shown after the wait, marked partial', () => {
  assert.equal(scanDisplay({ type: 'job', isLoaded: false }, PARTIAL_AFTER_TICKS), 'partial');
});

test('the wait ends the moment the job completes', () => {
  assert.equal(scanDisplay({ type: 'job', isLoaded: false }, 3), 'loading');
  assert.equal(scanDisplay({ type: 'job', isLoaded: true }, 4), 'show');
});

test('other pages and profiles are never held back', () => {
  assert.equal(scanDisplay({ type: 'page', kind: 'feed' }, 0), 'show');
  assert.equal(scanDisplay({ type: 'profile' }, 0), 'show');
});
