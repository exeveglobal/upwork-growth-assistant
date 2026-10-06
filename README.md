# Upwork Growth Assistant

*A product of the EXEVE Growth Engine (EGE).* Connected members report to the EGE portal at https://ege.exeve.global.

A Chrome Extension (Manifest V3) that sits in the browser side panel and helps freelancers win on Upwork by scoring the ROI of applying to a job and tracking proposals and Connects spend. AI proposal writing and profile optimization are coming soon.

## Free vs Connected

| | Free (no key) | Connected (Exeve key) |
|---|---|---|
| Job ROI score | ✅ local, nothing is sent anywhere | ✅ |
| ROI Hub (proposal tracking) | 🔒 | ✅ |
| AI proposal writer / profile optimizer | 🔜 coming soon | 🔜 coming soon |

Agency members connect with a one-time access key issued by their Exeve admin (Settings → Exeve Connection). Connecting requires accepting a notice that lists what is tracked. If the admin revokes the device or disables the member, the extension drops back to Free and asks for a new key. If the server is unreachable, an existing connection is kept.

The engine address is in `config.js`; for local development set `devEngineUrl` in `chrome.storage.local` (localhost / 127.0.0.1 only). `manifest.json` lists localhost host permissions for that; remove them in release builds.

---

## Working within Upwork
The extension is built to stay inside how Upwork works for a person using it:
- It only **reads pages the member opens themselves**. It never clicks, scrolls, loads or navigates Upwork pages, and never submits or sends anything for the member.
- It does not read messages. It reads job pages, the apply form at the moment the member clicks Send, and the Proposals lists while they are on screen.
- Reminders (toolbar badge and a panel banner) ask the member to open their Proposals page; the button opens it on the member's own click.
- Upwork lists archived proposals 10 per page. Only the rows on the page the member has open are updated; the reminder names the proposals to look for.
- The notice shown before connecting says all of this, and its version (`CONSENT_VERSION`) is raised whenever the wording or the data collected changes.

## Developing against a local engine
The released extension may only talk to `https://ege.exeve.global` (its manifest has no other host permission, by design). To try it against a local engine, in **your working copy** add `"http://127.0.0.1/*"` to `host_permissions` in `manifest.json` (do not commit it), then set `devEngineUrl` to `http://127.0.0.1:8787` in the extension's storage. Only `localhost` / `127.0.0.1` addresses are ever accepted there.

## Features

| Feature | Description |
|---|---|
| **Connects ROI Score** | Weighted bucket algorithm scores every job 0–100 with an Apply / Consider / Skip verdict |
| **AI Proposal Generator** | 🔜 Coming soon (will run on the server) |
| **Profile SEO Optimizer** | 🔜 Coming soon |
| **ROI Hub Tracker** | Logs proposals with connects spent, boost position, and outcome status (Connected only) |
| **SPA Auto-Scanner** | Polls the active Upwork tab every 1.5 s and re-scans whenever the job changes |

---

## Installation

1. Clone or download the repository.
2. Open Chrome → `chrome://extensions/` → enable **Developer Mode**.
3. Click **Load unpacked** and select the project folder.
4. Click the extension icon to open the side panel.
5. Job scoring works immediately. To unlock tracking, open **Settings → Exeve Connection** and enter the access key from your Exeve admin.

---

## Configuration (Settings Tab)

| Field | Notes |
|---|---|
| **Exeve Connection** | Access key from your admin; connect / disconnect this device |
| **Freelancer Niche, Target Hourly Rate, Achievements Bio** | Stored on this device only; will feed the upcoming AI proposal writer |

Older versions stored AI provider keys and a license key in settings; they are removed from storage automatically.

---

## Architecture Overview

```
manifest.json          Extension metadata and permissions (MV3)
background.js          Service worker — enables side panel on icon click
content.js             Injected into Upwork tabs — DOM scraper
sidepanel.html         Side panel markup (4 tabs)
sidepanel.css          Dark-theme styles
sidepanel.js           Side panel controller — orchestrates scraping, scoring, AI calls
utils.js               Shared module — ROI scorer, error log
connection.js          Exeve engine connection: connect with key, device token, 401 handling, tier
outbox.js              Offline-safe event queue + sender (also driven by background.js alarms)
apply-capture.js       Content script: reads the Upwork "Submit a proposal" form when Send is clicked
capture.js             Service-worker side: confirms a send (tab leaves the apply page), queues + logs it
logs.js                ROI Hub history storage shared by the side panel and the service worker
proposals-scan.js      Content script: reads rows on Upwork's Proposals page while the member has it open
proposals-sync.js      Service worker: matches rows to known proposals, verifies them, updates status
activity.js            Content script: counts active 5-second slices (visible tab + recent input)
activity-sync.js       Service worker: de-duplicates slices, sends per-day active-time deltas
tracking.js            Pure helpers: scored-job / proposal event payloads, status mapping, dedupe rules
config.js              Engine URL and consent-notice version
test/                  Unit tests (`npm test`, Node's built-in runner, no dependencies)
```

When connected, proposals you send on Upwork are captured automatically (cover letter, bid or hourly rate, Connects and boost, which pool you applied from, screening answers) and appear in the ROI Hub with no manual entry. Opening Upwork's Proposals page verifies them and keeps their status current (submitted → interviewing → hired / archived); active time on Upwork is tracked as seconds only. Scanned jobs, proposals and status changes are queued in an outbox and sent to the engine (retried automatically when offline). Free tier sends nothing.

Free tier is entirely client-side. When connected, the extension talks to the Exeve growth engine with a per-device token; any 401 from the engine ends the connection. No API keys or provider endpoints exist in this extension.

---

## Technical Deep Dive

### 1. Content Scraper — `content.js`

Injected at `document_end` into all `*.upwork.com` pages. Listens for two messages from the side panel:

| Message | Handler |
|---|---|
| `scrapePage` | Calls `scrapeCurrentPage()` and returns a typed data object |
| `checkPageIdentifier` | Returns a lightweight string fingerprint of the current page state |

#### Page Type Detection

```
URL contains /freelancers/ or /nx/find-work/profile
  └─ scrapeProfilePage()
else
  └─ scrapeJobDetailsPage()
```

#### Page Identifier

`getPageIdentifier()` uses the same root-finding logic as the scraper (drawer → main → body) and returns:

| Format | When |
|---|---|
| `job:<title>:<url>` | Job title AND description both present in the DOM |
| `profile:<title>:<url>` | Profile title element found |
| `nonjob:<url>` | All other pages (feed, archive, etc.) |

The side panel polls this identifier every 1.5 s. Any change triggers `clearCachedUI()` and a fresh scrape.

#### Job Scrape — Load Guard

The scraper will not report data as ready until **all three** of these are true:

1. A non-empty job title element is found inside the active drawer or `<main>`.
2. The job description element contains ≥ 50 characters.
3. The connects cost matches in the page text.

If any condition fails, `isLoaded = false` is returned. The side panel retries up to 3 times with 700 ms gaps. After retries exhaust, `handleScrapeResult` renders whatever data is available. `connectsNeeded === null` shows "Connects: Loading..." in the UI and omits the flat modifier from the score — this is intentional, because the connects section can sit outside the drawer's DOM scope on feed pages, making `isLoaded` persistently false even on fully visible job posts.

#### SPA Stale-Content Detection

For direct job detail URLs (`/jobs/…`), the scraper cross-checks the job title against the URL slug. At least 40% of the title's significant words (> 3 chars) must appear in the URL. If not, `isLoaded = false` is returned, forcing a re-scan.

#### Extracted Fields

| Field | Extraction Method |
|---|---|
| `title` | `h1`, `[data-test='job-title']`, `.job-title` (scoped to root) |
| `description` | `[data-test='job-description']`, `[data-qa='job-description']` |
| `connectsNeeded` | `div[data-v-cc3ef634]` → `.text-body-sm` → fullText regex |
| `isPaymentVerified` | `.payment-verified.text-success` → `.payment-not-verified` → fullText |
| `hireRate` | `[data-qa='client-job-posting-stats']` → fullText regex |
| `rating` | `[data-testid='buyer-rating'] .air3-rating-value-text` → fullText regex |
| `totalSpend` | `[data-qa='client-spend']` → fullText regex |
| `clientCountry` | `[data-qa='client-location']` → regex over 12 country names |
| `clientName` | Heuristic scan of review paragraph text (10 named patterns) |
| `jobAgeHours` | `posted N min/hr/day/week ago` or `just now` → normalised to hours |
| `clientLastViewedHours` | `last viewed by client N …ago` or `just now` → normalised to hours |
| `proposalRangeText` | `ul.client-activity-items` activity map → fullText regex fallback |
| `interviewingCount` | `ul.client-activity-items` activity map → fullText regex fallback |
| `invitesSent` | `ul.client-activity-items` activity map → fullText regex fallback |
| `unansweredInvites` | `ul.client-activity-items` activity map → fullText regex fallback |
| `isHourly` / `budget` | `[data-cy="clock-timelog/clock-hourly/fixed-price"]` icons + price from `<strong>` elements |

---

### 2. ROI Scoring Algorithm — `utils.js → calculateROIScore()`

Uses a **weighted bucket model** that separates scoring into three independent dimensions, each rated 0–100, combined with a payment trust multiplier.

#### Formula

```
Final = (A×0.30 + B×0.45 + C×0.25) × payment_multiplier + connects_modifier
```

#### Buckets

| Bucket | Weight | Signals |
|---|---|---|
| **A — Client Track Record** | 30% | Hire rate (40%), Rating (40%), Total spend (20%) |
| **B — Competitive Window** | 45% | Job age (40%), Proposal count (40%), Invites sent (20%) |
| **C — Conversion Signal** | 25% | Client last viewed (40%), Interviewing count (40%), Unanswered invites (20%) |

#### Payment Multiplier

Applied after bucket combination — not inside any bucket. Acts as a trust gate that scales the whole score.

| State | Multiplier |
|---|---|
| Verified | ×1.10 |
| Unknown (`null`) | ×1.00 |
| Unverified | ×0.75 |

#### Connects Modifier (flat, post-multiplier)

| Tier | Modifier |
|---|---|
| < 16 (Cheap) | +3 |
| 16–30 (Average) | 0 |
| 31–50 (High) | -5 |
| > 50 (Extremely High) | -10 |

#### Verdict Thresholds

| Score | Verdict | Colour |
|---|---|---|
| ≥ 75 | **Apply** | Emerald `#10b981` |
| 45–74 | **Consider** | Amber `#eab308` |
| < 45 | **Skip** | Crimson `#ef4444` |

#### Bucket Score Bands

**A — Client Track Record**

| Signal | Input | Score |
|---|---|---|
| Hire Rate | ≥ 85% | 90 |
| | 70–84% | 75 |
| | 35–69% | 55 |
| | 1–34% | 30 |
| | 0% / never hired | 10 |
| | unknown | 50 |
| Rating | ≥ 4.7★ | 85 |
| | 4.0–4.69★ | 60 |
| | < 4.0★ | 20 |
| | unknown | 50 |
| Total Spend | $1M+ | 95 |
| | $100K+ | 85 |
| | $50K+ | 75 |
| | $10K+ | 65 |
| | $5K+ | 55 |
| | $1K+ | 50 |
| | < $1K / none | 40 |

**B — Competitive Window**

| Signal | Input | Score |
|---|---|---|
| Job Age | < 30 min | 90 |
| | 30 min–1 hr | 75 |
| | 1–3 hr | 55 |
| | 3–6 hr | 40 |
| | 6–24 hr | 25 |
| | 1–3 days | 15 |
| | > 3 days | 5 |
| | unknown | 55 |
| Proposals | < 5 | 90 |
| | 5–9 | 75 |
| | 10–14 | 55 |
| | 15–19 | 40 |
| | 20–49 | 25 |
| | 50+ | 10 |
| | unknown | 55 |
| Invites Sent | 0 | 70 |
| | 1–2 | 55 |
| | 3–5 | 40 |
| | > 5 | 25 |
| | unknown | 60 |

**C — Conversion Signal**

"Fresh" = job age ≤ 1 hr (or unknown). Interviewing score differs for fresh vs stale jobs.

| Signal | Input | Score |
|---|---|---|
| Client Last Viewed | < 3 hr | 80 |
| | 3–24 hr | 65 |
| | 1–3 days | 40 |
| | > 3 days | 15 |
| | unknown | 50 |
| Interviewing Count | 0, fresh job | 70 |
| | 0, old job | 45 |
| | 1 | 25 |
| | ≥ 2 | 15 |
| | unknown, fresh | 60 |
| | unknown, old | 45 |
| Unanswered Invites | all unanswered | 75 |
| | > half unanswered | 60 |
| | 0 unanswered | 25 |
| | partial / unknown | 50 |

---

### 3. Side Panel Controller — `sidepanel.js`

#### SPA Auto-Scanner

A `setInterval` runs every **1500 ms**. On each tick it sends a `checkPageIdentifier` message to the active Upwork tab. When the identifier changes:

1. `clearCachedUI()` shows a "Scanning page..." state in the job header card immediately (ROI and proposal cards are hidden to prevent stale data from showing).
2. An **800 ms delay** fires before `scanActivePage()` is called — this gives Upwork's SPA time to finish rendering before the scrape runs.

When the scan returns no job (archive, feed without a selected job, non-Upwork page), `showFallbackUI("analyzer")` hides all job cards and shows the "No Job Post Detected" panel.

`scanInProgress` boolean prevents parallel retry chains from running simultaneously. `chrome.tabs.onActivated` handles browser tab switches via a `"__tab_switch__"` sentinel so the 1.5 s poll absorbs the change without launching a second concurrent scan.

#### Retry Logic

`sendMessageToContentScript(tabId, message, retryCount = 0)` — if the scrape response comes back with `isLoaded === false`, the function schedules itself again after **700 ms**. Maximum **3 retries**.

```
Attempt 1 (immediate)
  └─ isLoaded false → wait 700ms
Attempt 2
  └─ isLoaded false → wait 700ms
Attempt 3
  └─ isLoaded false → wait 700ms
Attempt 4
  └─ render whatever data is available (connects shows "Loading..." if null)
```

#### ROI Breakdown Display

The reasons list renders in collapsible `<details>` sections per bucket:

1. **Payment multiplier** line (first — scales the whole score)
2. **`── A · Client Track Record: N/100`** — hire rate / rating / spend
3. **`── B · Competitive Window: N/100`** — age / proposals / invites
4. **`── C · Conversion Signal: N/100`** — last-viewed / interviewing / unanswered
5. **Connects** note at the bottom

Positive signals render in green, negative in crimson, neutral in muted grey. Each bucket header shows a colour-coded score bar (green ≥ 70, amber ≥ 45, red < 45).

---

### 4. ROI Hub Tracker — `sidepanel.js`

Proposal logs are stored in `chrome.storage.local` under the key `logs`. Each log entry:

```json
{
  "id": "1716480000000",
  "date": "5/23/2025",
  "title": "React Developer for SaaS Dashboard",
  "connects": 16,
  "boost": "none",
  "status": "applied"
}
```

Status cycle (click the badge to advance): `applied → interviewing → hired → rejected → applied`

Stats computed in real time from the log array:
- **Spent Connects** — sum of all `connects`
- **Proposals Logged** — array length
- **Interviews** — count where `status === "interviewing" || "hired"`
- **Response Rate** — interviews / proposals × 100

---

## Known Selectors (Upwork DOM)

These selectors are used for structured extraction before falling back to regex on `fullText`:

| Data | Selector |
|---|---|
| Job Title | `h1`, `h2.job-title`, `[data-test='job-title']` |
| Job Description | `[data-test='job-description']`, `[data-qa='job-description']` |
| Client Location | `[data-qa='client-location']` |
| Activity Items | `ul.client-activity-items li.ca-item` (proposals, hires, invites, interviewing) |
| Contract Type | `[data-cy="clock-timelog"]`, `[data-cy="clock-hourly"]`, `[data-cy="fixed-price"]` |
| Client Spend | `[data-qa='client-spend']` |
| Buyer Rating | `[data-testid='buyer-rating'] .air3-rating-value-text` |
| Job Stats | `[data-qa='client-job-posting-stats']` |
| Active Drawer | `[role='dialog']`, `.up-slider`, `.job-details-panel` |

Upwork frequently changes its DOM. If structured selectors miss, the scraper falls back to regex over `root.textContent` for all numeric and boolean fields.

---

## File Dependency Map

```
sidepanel.html
  └─ sidepanel.js  (ES module, type="module")
       ├─ imports utils.js       (calculateROIScore, getConnectsTier, error log)
       ├─ imports connection.js  (connect, verify, disconnect)
       └─ messages content.js  (scrapePage, checkPageIdentifier)
            └─ runs inside the active Upwork tab
```

---

## Generating Icons

```bash
npm install       # first time only
npm run icons     # renders icons/icon.svg → icon16.png, icon32.png, icon48.png, icon128.png
```

Requires Node.js and the `sharp` package (installed by `npm install`).
