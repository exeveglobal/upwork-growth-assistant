import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../html.js';

test('escapes everything that can break out of element text or a quoted attribute', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)"> & 'q'`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;');
  assert.equal(escapeHtml('a" onmouseover="x'), 'a&quot; onmouseover=&quot;x');
  assert.equal(escapeHtml("a' onmouseover='x"), 'a&#39; onmouseover=&#39;x');
});

test('is safe for non-strings and missing values', () => {
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml('plain text'), 'plain text');
});
