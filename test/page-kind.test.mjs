import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs content.js against a stubbed page: `els` maps a selector fragment to a fake element.
function pageAt(href, els = {}, tabTitle = '') {
  const url = new URL(href);
  const find = (sel) => {
    for (const [frag, el] of Object.entries(els)) if (sel.includes(frag)) return el;
    return null;
  };
  const el = (text = '') => ({ textContent: text, querySelector: find, querySelectorAll: () => [] });
  const document = { title: tabTitle, visibilityState: 'hidden', querySelector: find, querySelectorAll: () => [], body: el() };
  const sandbox = {
    document, location: { href, pathname: url.pathname }, setInterval: () => 0, console,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} }, storage: { local: { get() {}, set() {} } } }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}
const JOB = '~022106746859492424699';
const jobDom = { 'Description': { textContent: 'x'.repeat(80) }, 'h4': { textContent: 'A title' }, 'role=\'dialog\'': null };

test('the weekly reports page is not a job (no placeholder score there)', () => {
  const p = pageAt('https://www.upwork.com/nx/reports/freelancer/weekly-summary?range=20260928-20261004&group_by=assignment');
  assert.equal(p.classifyPage(), 'other');
  assert.deepEqual({ ...p.scrapeCurrentPage() }, { type: 'page', kind: 'other', jobId: null });
});

test('other non-job pages are classified, not scored', () => {
  assert.equal(pageAt('https://www.upwork.com/nx/messages/rooms/room_1').classifyPage(), 'other');
  assert.equal(pageAt('https://www.upwork.com/nx/find-work/best-matches').classifyPage(), 'feed');
  assert.equal(pageAt('https://www.upwork.com/nx/search/jobs/?q=wordpress').classifyPage(), 'feed');
  assert.equal(pageAt('https://www.upwork.com/nx/proposals/').classifyPage(), 'proposals');
  assert.equal(pageAt('https://www.upwork.com/nx/proposals/archived').classifyPage(), 'proposals');
  assert.equal(pageAt('https://www.upwork.com/freelancers/~0123456789abcdef').classifyPage(), 'profile');
});

test('the apply page is its own kind and carries the job id', () => {
  const p = pageAt(`https://www.upwork.com/nx/proposals/job/${JOB}/apply/`);
  assert.equal(p.classifyPage(), 'apply');
  assert.deepEqual({ ...p.scrapeCurrentPage() }, { type: 'page', kind: 'apply', jobId: JOB, connectsRequired: null, jobClosed: false });
});

test('job pages and sliders are jobs', () => {
  assert.equal(pageAt(`https://www.upwork.com/jobs/Some-Title_${JOB}/`, jobDom).classifyPage(), 'job');
  assert.equal(pageAt(`https://www.upwork.com/jobs/${JOB}`, jobDom).classifyPage(), 'job');
  assert.equal(pageAt(`https://www.upwork.com/nx/find-work/best-matches/details/${JOB}?pageTitle=Job%20Details`, jobDom).classifyPage(), 'job');
});

test('a full job page whose heading has not rendered falls back to the tab title', () => {
  const noHeading = { 'Description': { textContent: 'x'.repeat(80) } };
  const p = pageAt(`https://www.upwork.com/jobs/Some-Title_${JOB}/`, noHeading, 'Fix A - B plugin - Web, Mobile & Software Dev');
  assert.equal(p.readJobTitle({ querySelector: (s) => (s.includes('Description') ? noHeading.Description : null) }), 'Fix A - B plugin');
  // no description on screen yet, or not a full job page: no guessing
  assert.equal(p.readJobTitle({ querySelector: () => null }), '');
  const slider = pageAt(`https://www.upwork.com/nx/search/jobs/details/${JOB}`, noHeading, 'Search Freelance Jobs - Upwork');
  assert.equal(slider.readJobTitle({ querySelector: (s) => (s.includes('Description') ? noHeading.Description : null) }), '');
});

test('"job closed" comes only from an alert that says the job is gone', () => {
  const p = pageAt(`https://www.upwork.com/nx/proposals/job/${JOB}/apply/`);
  assert.equal(p.jobClosedIn(['This job is no longer available.']), true);
  assert.equal(p.jobClosedIn(['This job has been closed by the client']), true);
  // the real false positive: an unrelated Upwork notice on the apply page
  assert.equal(p.jobClosedIn(['Specialized Profiles are no longer available. All your portfolio items have been transferred.']), false);
  assert.equal(p.jobClosedIn(['Your bid is set to 1 Connect.', '']), false);
  assert.equal(p.jobClosedIn([]), false);
  assert.equal(p.jobClosedIn([undefined, null]), false);
});

test('the apply page does not report a closed job from ordinary page text', () => {
  const text = { innerText: 'Job details\nSpecialized Profiles are no longer available. This job is closed to agencies in Spain.', textContent: '' };
  const p = pageAt(`https://www.upwork.com/nx/proposals/job/${JOB}/apply/`, { main: text });
  assert.equal(p.scrapeCurrentPage().jobClosed, false);
});
