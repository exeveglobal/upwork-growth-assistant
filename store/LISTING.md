# Chrome Web Store listing kit

Everything to paste into the Developer Dashboard. Upload: `dist/upwork-growth-assistant-1.0.0.zip` (build with `npm run package`).

## Store listing tab

**Name** (from the manifest): Upwork Growth Assistant
**Summary** (from the manifest, 107 of 132 characters): Score Upwork jobs by Connects ROI before you apply, and keep a history of your proposals and their results.
**Category:** Productivity. **Language:** English.

**Description:**

```
Know which Upwork jobs are worth your Connects before you apply.

Open a job on Upwork and the side panel gives it an ROI score from 0 to 100 with a clear verdict (Apply, Consider or Skip) and the reasons behind it: the client's track record (hire rate, rating, spend), the competition (how fresh the job is, how many proposals, invites) and conversion signals (is the client active and interviewing, what the job costs in Connects).

FREE FOR EVERYONE
• Instant job scores in the side panel, calculated on your computer.
• A full breakdown, line by line, so you can judge for yourself.
• Nothing is sent anywhere in free mode.

FOR MEMBERS (with an access key)
• Your proposals are recorded automatically when you send them: cover letter, bid, Connects (job + boost bid) and the score the job had at that moment.
• Your own history (ROI Hub): statuses from applied to hired, corrections with the earlier values kept, response rate.
• A gentle reminder to check your Proposals page every few days, so outcomes get recorded.
• Your account admin sees how everyone is doing in a private dashboard and weekly report.

HOW IT BEHAVES ON UPWORK
The extension only reads pages you open yourself. It never clicks, scrolls, loads pages or sends anything on Upwork for you, and it does not read your messages. You see what member mode shares before you connect, and you can disconnect at any time.

Open source: https://github.com/exeveglobal/upwork-growth-assistant
Privacy policy: https://github.com/exeveglobal/upwork-growth-assistant/blob/main/PRIVACY.md

Upwork is a trademark of Upwork Global Inc. This extension is made by Exeve and is not affiliated with, endorsed by or sponsored by Upwork.
```

## Store listing tab: every field

| Field | What to enter |
|---|---|
| **Description** | The text above (about 1,700 of 16,000 characters). |
| **Category** | **Productivity**, and if it asks for a subcategory: **Workflow & Planning** (second choice: **Tools**). |
| **Language** | **English**. |
| **Store icon** (128×128) | `assets/store-icon-128x128.png` (the artwork is 96×96 with 16 px transparent padding, as the store asks). |
| **Global promo video** | Leave empty (optional). |
| **Screenshots** (1280×800, up to 5) | Upload in this order: `assets/screenshot-1-score-every-job.png`, `screenshot-2-see-why.png`, `screenshot-3-apply-with-confidence.png`, `screenshot-4-track-proposals.png`, `screenshot-5-stay-on-top.png` |
| **Small promo tile** (440×280) | `assets/promo-tile-440x280.png` |
| **Marquee promo tile** (1400×560) | `assets/marquee-promo-1400x560.png` |

All images use fictional demo data and the EXEVE look.

**Additional fields**

| Field | What to enter |
|---|---|
| **Official URL** | None. (Only available for a website you have verified in Google Search Console; not needed.) |
| **Homepage URL** | `https://github.com/exeveglobal/upwork-growth-assistant` |
| **Support URL** | `https://github.com/exeveglobal/upwork-growth-assistant/issues` |
| **Mature content** | Leave unticked (No). |

## Privacy tab

**Single purpose:** Score the Upwork jobs a user opens by Connects ROI, and keep the user's own history of the proposals they send and their results.

**Permission justifications:**

| Permission | Why |
|---|---|
| `storage` | Keeps the user's score history, proposal history, settings and (member mode) the connection token on their own computer. |
| `sidePanel` | The whole interface is Chrome's side panel next to the Upwork page. |
| `scripting` | Re-injects the page reader into an open Upwork tab if the page was loaded before the extension was installed or updated, so scoring works without reloading. |
| `alarms` | Periodically retries unsent data and re-checks that the connection is still valid (member mode), and refreshes the reminder to check the Proposals page. |
| Host `https://*.upwork.com/*` | The extension's purpose: it reads the job pages, the proposal form and the Proposals list the user opens on upwork.com, and measures active time there. |
| Host `https://ege.exeve.global/*` | The Exeve server that members connect to (member mode only). Nothing is sent in free mode. |

**Remote code:** No. All code is in the package; no remote scripts, no `eval`.

**Data usage** (tick these, and describe as in the privacy policy):

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | Names are set by the account admin, not collected from the user's browser. |
| Health, financial and payment information | No | |
| Authentication information | **Yes** | The one-time access key the user enters, then a device token (member mode). |
| Personal communications | No | Messages are never read. |
| Location | No | |
| Web history | **Yes** | Links to the Upwork jobs the user opens (member mode). |
| User activity | **Yes** | Active time on upwork.com as counts of 5-second periods (member mode); no keystrokes or mouse positions are stored. |
| Website content | **Yes** | Job details and the user's own proposal text (cover letter, screening answers, bid), member mode. |

**Certifications:** tick all three: not sold to third parties; not used or transferred for purposes unrelated to the item's single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/exeveglobal/upwork-growth-assistant/blob/main/PRIVACY.md (publish `PRIVACY.md` to the repository's `main` branch before submitting).

## Distribution tab

* **Visibility:** *Unlisted* is the best fit while this is mainly for your own members: anyone with the link can install it, it is not searchable, and you still get automatic updates. Choose *Public* if you want it found in search.
* Regions: all (or the ones your members work from).

## Instructions for the reviewer ("Test instructions")

```
The extension has two modes.

FREE MODE (works immediately, no account): sign in to upwork.com, open any job (click a job card on the Find Work page, or open a job page), then click the extension's icon. The side panel shows the job's ROI score and breakdown. Nothing is sent anywhere in this mode.

MEMBER MODE needs an access key that Exeve issues to its members, so it cannot be tested with a public account. What it adds: it records the proposals the user sends (visible in the "ROI Hub" tab) and sends them, after the user accepts the notice in Settings, to https://ege.exeve.global. Source code and a description of every data flow: https://github.com/exeveglobal/upwork-growth-assistant (see PRIVACY.md).
```

(If the reviewers ask for a member-mode demo, create a member called "Chrome Review" in the dashboard and send them a fresh key: keys work once and expire after 7 days.)

## Before you press Submit

1. Developer account registered ($5 one-time fee) with 2-step verification on.
2. `PRIVACY.md` is pushed to `main` and the link above opens.
3. `npm run package`, then upload the zip. The dashboard reads the manifest: name, version, description and permissions should match the tables above.
4. Fill the Privacy tab exactly as above; submit for review (usually a few days; extensions with the `scripting` permission and host permissions can take longer).

## After it is published

* **Updates:** raise `version` in `manifest.json` (it must increase), `npm run package`, upload the new zip as a new version. Everyone who installed from the store updates automatically.
* The store gives the extension a **new ID**, so a copy installed from GitHub and the store version are separate installs. Members should switch to the store one and remove the unpacked one (the employee guide's install chapter should be updated to say so).
* **Name and trademark:** the name starts with "Upwork". Chrome and Upwork may object to a product name that begins with a trademark. If that happens, "Growth Assistant for Upwork" is the usual safe form (change `name` in the manifest).
