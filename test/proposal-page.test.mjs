import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL('../proposals-scan.js', import.meta.url), 'utf8'), sandbox);
const { DETAIL, describeProposalPage } = sandbox.__ugaProposalsScan;

const el = (tag, o = {}) => ({ tagName: tag.toUpperCase(), type: o.type || '', id: o.id || '', name: o.name || '', innerText: o.text || '', getAttribute: (a) => (o.attrs || {})[a] ?? null });
const doc = (nodes) => ({ querySelectorAll: (sel) => nodes.filter(n => sel.split(',').some(s => n.tagName === s.trim().toUpperCase() || (s.includes('role') && n.attrs?.role === 'button'))) });

test('a submitted proposal page is recognised, the lists and the apply page are not', () => {
  for (const ok of ['/nx/proposals/2096409461684633601', '/nx/proposals/2096409461684633601/', '/nx/proposals/2096409461684633601/edit', '/nx/proposals/2096409461684633601/change-terms']) assert.ok(DETAIL.test(ok), ok);
  for (const no of ['/nx/proposals/', '/nx/proposals/archived', '/nx/proposals/job/~0221999/apply/', '/nx/proposals/interview/uid/123', '/nx/find-work']) assert.ok(!DETAIL.test(no), no);
});

test('only structure is described: field ids and types, button labels, never what was typed', () => {
  const d = describeProposalPage(doc([
    el('input', { type: 'text', id: 'step-rate' }), el('textarea', { name: 'cover', attrs: { 'aria-labelledby': 'x' } }),
    el('input', { type: 'hidden', id: 'csrf' }), el('input', { type: 'file', id: 'upload' }),
    el('button', { text: 'Update proposal' }), el('button', { text: 'Withdraw proposal' }), el('button', { text: 'Some very personal client name button' })
  ]), '/nx/proposals/2096409461684633601/edit');
  assert.equal(d.path, '/nx/proposals/<id>/edit', 'the proposal id is not recorded');
  assert.deepEqual([...d.controls], ['input|text|step-rate||', 'textarea|||cover|labelled']);
  assert.deepEqual([...d.buttons], ['Update proposal', 'Withdraw proposal']);
});
