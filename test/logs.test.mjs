import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './fake-chrome.mjs';

installChrome();
const { applyManualLog, upsertCapturedLog, roiCounts, connectsLabel, findLoggedByTitle, normalizeTitle } = await import('../logs.js');

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

test('a client reply counts as a response but not as an interview', () => {
  const logs = ['applied', 'viewed', 'replied', 'interviewing', 'hired', 'rejected'].map((status, i) => ({ id: String(i), status, connects: 10 }));
  assert.deepEqual(roiCounts(logs), { proposals: 6, connects: 60, interviews: 2, responseRatePct: 50 });
  assert.deepEqual(roiCounts([]), { proposals: 0, connects: 0, interviews: 0, responseRatePct: 0 });
});

test('a captured boosted proposal keeps what the total was made of, and a hand override drops that split', async () => {
  globalThis.chrome.storage.local.set({ logs: [] });
  await upsertCapturedLog({ jobId: '~B', title: 'T', connectsTotal: 29, connectsRequired: 20, connectsBoost: 9, boostRank: 2, submittedAt: '2026-10-04T10:00:00.000Z' });
  let { logs } = await globalThis.chrome.storage.local.get('logs');
  assert.equal(connectsLabel(logs[0]), '29 connects (20 job + 9 bid)');
  assert.equal(connectsLabel({ connects: 20 }), '20 connects');
  assert.equal(connectsLabel({ connects: 20, connectsJob: 20, connectsBid: 0 }), '20 connects');

  const r = applyManualLog(logs, { ...manual({ jobId: '~B', connects: 31, boost: 'rank2' }) });
  assert.equal(r.log.connectsJob, undefined);
  assert.equal(connectsLabel(r.log), '31 connects');
});

test('a hand entry with the title of exactly one synced proposal finds it; anything unclear does not', () => {
  const logs = [
    { id: '1', jobId: '~A', title: 'WordPress Developer Needed!', connects: 20 },
    { id: '2', jobId: '~B', title: 'Website redesign', connects: 14 },
    { id: '3', jobId: '~C', title: 'Website  Redesign', connects: 14 },
    { id: '4', title: 'Local only job', connects: 10 }
  ];
  assert.equal(findLoggedByTitle(logs, '  wordpress developer needed ').jobId, '~A', 'case, spacing and punctuation do not matter');
  assert.equal(findLoggedByTitle(logs, 'website redesign'), null, 'two proposals share the title: do not guess');
  assert.equal(findLoggedByTitle(logs, 'Local only job'), null, 'a device-only entry has no job to sync to');
  assert.equal(findLoggedByTitle(logs, 'Something else'), null);
  assert.equal(findLoggedByTitle(logs, '   '), null);
  assert.equal(normalizeTitle('Café – Redesign!'), 'café redesign');
});

test('matching by title turns a typed correction into an override of the synced entry, not a device-only copy', () => {
  const logs = [{ id: '1', jobId: '~A', title: 'Design Project', connects: 20, boost: 'none', status: 'applied', source: 'capture' }];
  const match = findLoggedByTitle(logs, 'design project');
  const r = applyManualLog(logs, { id: '9', jobId: match.jobId, title: 'design project', connects: 29, boost: 'none', status: 'applied' });
  assert.equal(r.action, 'overridden');
  assert.equal(r.logs.length, 1);
  assert.equal(r.log.connects, 29);
  assert.equal(r.log.jobId, '~A', 'still synced');
});
