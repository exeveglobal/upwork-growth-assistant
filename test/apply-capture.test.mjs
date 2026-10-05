import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the classic content script with no DOM: it only exposes its pure parsers.
const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL('../apply-capture.js', import.meta.url), 'utf8'), sandbox);
const cap = sandbox.__ugaApplyCapture;
// Objects built inside the vm sandbox have a foreign Object.prototype; copy them into this realm for deepEqual.
const plain = (o) => ({ ...o });
const parseSummary = (t) => plain(cap.parseSummary(t));
const parseApplyAs = (t) => plain(cap.parseApplyAs(t));
const { parseBoostRank, parseTitle, money } = cap;

// Text copied from live apply pages (2026-10-03)
const HOURLY_TEXT = `Submit a proposal
Proposal settings
This proposal requires 20 Connects
When you submit this proposal, you'll have 169 Connects remaining.
Job details
Professional website redesign for a specialist B2B treatment service (7 pages, Elementor)
Web Design Posted Oct 3, 2026
Hourly rate
Freelancer Service Fee: 10%
Boost your proposal (optional)
Rank
Bid
1st place
50 Connects 5 minutes ago

2nd place
31 Connects 12 minutes ago

3rd place
30 Connects 19 minutes ago

4th place
22 Connects 8 minutes ago
Your bid
Bid 51 Connects or higher to be ranked in 1st place.
Set bid
Remaining balance: 169 Connects
Summary
Bid to boost:
0 Connects
Required for proposal:
20 Connects
Total:
20 Connects
Send for 20 Connects Cancel`;

const FIXED_NO_BIDS = `Job details
Build a Wordpress Website
Your bid
Bid 1 Connect or higher to be ranked in 1st place.
1st place
No bids

2nd place
No bids

3rd place
No bids

4th place
No bids
Bid to boost:
0 Connects
Required for proposal:
14 Connects
Total:
14 Connects
When you submit this proposal, you'll have 175 Connects remaining.`;

test('summary: connects and fee are parsed from the real text', () => {
  assert.deepEqual(parseSummary(HOURLY_TEXT), {
    connectsRequired: 20, connectsBoost: 0, connectsTotal: 20, connectsRemainingAfter: 169, serviceFeePct: 10
  });
  assert.deepEqual(parseSummary(FIXED_NO_BIDS), {
    connectsRequired: 14, connectsBoost: 0, connectsTotal: 14, connectsRemainingAfter: 175, serviceFeePct: undefined
  });
});

test('summary: thousands separators and a boost', () => {
  const t = 'This proposal requires 1,200 Connects\nBid to boost:\n1,050 Connects\nTotal:\n2,250 Connects';
  assert.deepEqual(
    [parseSummary(t).connectsRequired, parseSummary(t).connectsBoost, parseSummary(t).connectsTotal],
    [1200, 1050, 2250]
  );
});

test('summary: missing text yields undefined, never a crash or NaN', () => {
  assert.deepEqual(Object.values(parseSummary('')), Array(5).fill(undefined));
  assert.deepEqual(Object.values(parseSummary(undefined)), Array(5).fill(undefined));
});

test('apply as: freelancer vs agency, with the connects pool of that choice', () => {
  assert.deepEqual(parseApplyAs('As a freelancer (189 Connects available.)'), { applyAs: 'freelancer', connectsAvailableBefore: 189 });
  assert.deepEqual(parseApplyAs('As an agency member under EXEVE Global (0 Connects available.)'), { applyAs: 'agency:EXEVE Global', connectsAvailableBefore: 0 });
  assert.deepEqual(parseApplyAs('As an agency member under Foo & Bar, Inc. (1,250 Connects available.)'), { applyAs: 'agency:Foo & Bar, Inc.', connectsAvailableBefore: 1250 });
  assert.deepEqual(parseApplyAs(''), { applyAs: 'freelancer', connectsAvailableBefore: undefined });
});

test('boost rank: ties lose, "No bids" counts as nobody, below 4th is no rank', () => {
  assert.equal(parseBoostRank(HOURLY_TEXT, 0), undefined);        // no boost
  assert.equal(parseBoostRank(HOURLY_TEXT, 51), 1);               // "Bid 51 or higher to be 1st"
  assert.equal(parseBoostRank(HOURLY_TEXT, 50), 2);               // tie with the top bid loses
  assert.equal(parseBoostRank(HOURLY_TEXT, 31), 3);
  assert.equal(parseBoostRank(HOURLY_TEXT, 23), 4);
  assert.equal(parseBoostRank(HOURLY_TEXT, 22), undefined);       // ties 4th, so not in the top 4
  assert.equal(parseBoostRank(HOURLY_TEXT, 5), undefined);
  assert.equal(parseBoostRank(FIXED_NO_BIDS, 1), 1);
  assert.equal(parseBoostRank('', 5), 1);                         // empty list: nobody to beat
});

test('title: first line after "Job details"', () => {
  assert.equal(parseTitle(HOURLY_TEXT), 'Professional website redesign for a specialist B2B treatment service (7 pages, Elementor)');
  assert.equal(parseTitle(FIXED_NO_BIDS), 'Build a Wordpress Website');
  assert.equal(parseTitle('nothing here'), undefined);
});

test('money parsing ignores signs, symbols and thousands separators', () => {
  assert.equal(money('$100.00'), 100);
  assert.equal(money('$1,250.50'), 1250.5);
  assert.equal(money('-$10.00'), 10);
  assert.equal(money(''), undefined);
  assert.equal(money(undefined), undefined);
});

test('readPaymentMode reads the fixed-price "How do you want to be paid?" choice', () => {
  const { readPaymentMode } = cap;
  const docWith = (value) => ({ querySelector: (s) => (s.includes('milestoneMode') && value ? { value } : null) });
  assert.equal(readPaymentMode(docWith('milestone')), 'milestone');
  assert.equal(readPaymentMode(docWith('default')), 'project');
  assert.equal(readPaymentMode(docWith(null)), undefined);
});

test('summary: both Upwork wordings of the job cost, with and without a bid', () => {
  const now = 'Summary\nBid to boost:\n9 Connects\nRequired for proposal:\n20 Connects\nTotal:\n29 Connects\nSend for 29 Connects';
  assert.deepEqual([parseSummary(now).connectsRequired, parseSummary(now).connectsBoost, parseSummary(now).connectsTotal], [20, 9, 29]);
  const old = 'This proposal requires 20 Connects\nBid to boost: 9 Connects\nTotal: 29 Connects';
  assert.deepEqual([parseSummary(old).connectsRequired, parseSummary(old).connectsBoost, parseSummary(old).connectsTotal], [20, 9, 29]);
  // no wording for the job cost at all: derived from total - boost
  assert.equal(parseSummary('Bid to boost:\n9 Connects\nTotal:\n29 Connects').connectsRequired, 20);
  assert.equal(parseSummary('Total: 29 Connects').connectsRequired, undefined, 'cannot derive without the boost');
});
