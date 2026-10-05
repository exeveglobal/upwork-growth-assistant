import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './fake-chrome.mjs';

installChrome();
const { applyManualLog, upsertCapturedLog } = await import('../logs.js');

const captured = () => ({ id: '1', jobId: '~J', title: 'T', connects: 14, boost: 'none', status: 'applied', source: 'capture', submittedAt: '2026-10-04T10:00:00.000Z' });
const manual = (over = {}) => ({ id: '2', jobId: '~J', title: 'T', connects: 14, boost: 'none', status: 'applied', ...over });

test('a job nobody logged yet is created', () => {
  const r = applyManualLog([], manual());
  assert.equal(r.action, 'created');
  assert.equal(r.logs.length, 1);
});

test('an identical manual entry for an auto-tracked proposal adds nothing', () => {
  const logs = [captured()];
  const r = applyManualLog(logs, manual());
  assert.equal(r.action, 'unchanged');
  assert.equal(r.logs.length, 1);
  assert.equal(r.logs[0].revisions, undefined);
  assert.equal(r.logs[0].source, 'capture', 'still recorded as auto-tracked');
});

test('a different manual entry overrides, and the auto-tracked values are kept as a revision', () => {
  const r = applyManualLog([captured()], manual({ connects: 16, boost: 'rank2', status: 'interviewing' }), Date.parse('2026-10-05T08:00:00Z'));
  assert.equal(r.action, 'overridden');
  assert.equal(r.logs.length, 1, 'never a duplicate row');
  const [log] = r.logs;
  assert.deepEqual([log.connects, log.boost, log.status, log.source], [16, 'rank2', 'interviewing', 'manual']);
  assert.deepEqual(log.revisions, [{ at: '2026-10-05T08:00:00.000Z', source: 'capture', connects: 14, boost: 'none', status: 'applied' }]);
  assert.equal(log.submittedAt, '2026-10-04T10:00:00.000Z', 'original submit time is preserved');
});

test('repeated overrides keep every earlier version, oldest first', () => {
  let logs = [captured()];
  logs = applyManualLog(logs, manual({ connects: 16 }), 1000).logs;
  logs = applyManualLog(logs, manual({ connects: 18 }), 2000).logs;
  assert.deepEqual(logs[0].revisions.map(r => [r.source, r.connects]), [['capture', 14], ['manual', 16]]);
  assert.equal(logs[0].connects, 18);
  assert.equal(applyManualLog(logs, manual({ connects: 18 })).action, 'unchanged');
});

test('entries without a job id never merge', () => {
  const r = applyManualLog([{ ...captured(), jobId: undefined }], manual({ jobId: undefined }));
  assert.equal(r.action, 'created');
  assert.equal(r.logs.length, 2);
});

test('auto-capture after a manual entry still enriches the same row (no duplicate)', async () => {
  globalThis.chrome.storage.local.set({ logs: [manual({ connects: 16 })] });
  await upsertCapturedLog({ jobId: '~J', title: 'T', connectsTotal: 20, submittedAt: '2026-10-04T10:00:00.000Z' });
  const { logs } = await globalThis.chrome.storage.local.get('logs');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].connects, 20);
  assert.equal(logs[0].revisions.length, 1, 'the hand-entered values are kept');
  assert.deepEqual([logs[0].revisions[0].source, logs[0].revisions[0].connects], ['manual', 16]);
});

test('auto-capture that matches what is recorded adds no revision', async () => {
  globalThis.chrome.storage.local.set({ logs: [manual({ connects: 14 })] });
  await upsertCapturedLog({ jobId: '~J', title: 'T', connectsTotal: 14, submittedAt: '2026-10-04T10:00:00.000Z' });
  const { logs } = await globalThis.chrome.storage.local.get('logs');
  assert.equal(logs[0].revisions, undefined);
});
