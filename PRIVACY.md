# Privacy policy: Upwork Growth Assistant

*Last updated: 7 October 2026*

Upwork Growth Assistant is a Chrome extension made by **EXEVE Global** ("Exeve", "we"). It helps people who work on Upwork decide which jobs are worth their Connects and keep a history of their proposals. This page explains what the extension does with data. We wrote it to be read.

The extension is open source: you can read exactly what it does at <https://github.com/exeveglobal/upwork-growth-assistant>.

## Two ways to use it

**Free mode (no access key).** The extension scores the Upwork jobs you open, on your computer. **Nothing is sent to us or anyone else.** Scores and your settings stay in your browser's extension storage.

**Member mode (with an access key).** Members connect with an access key issued by Exeve. When you connect with a key and accept the notice shown in the extension, it also records your Upwork work and sends it to Exeve's server, so your account admin can see how everyone is doing and help you. You can disconnect at any time.

## What the extension reads

Only on pages of upwork.com that you open yourself, and only to do the above:

* **Job pages:** the job's title, description and listed details, and public client statistics Upwork shows with it (country, rating, hire rate, total spent, and similar). These are used to calculate the score.
* **The "Submit a proposal" page,** at the moment you press Send: your cover letter, your answers to the job's screening questions, your rate or bid, the Connects you spent (including any boost bid), and which profile you applied with.
* **Your Proposals page:** the titles, dates and statuses of your proposals, to keep their status up to date.

It never clicks, scrolls, loads pages or submits anything on Upwork for you. It does **not** read your messages with clients, your Upwork password, payment details, or anything on other websites.

## What is sent to Exeve (member mode only)

* The jobs you opened and their score, with the job's link, title and the client statistics above.
* Proposals you send: cover letter, screening answers, rate or bid, Connects, boost, the profile used, the score at the time, and later status changes (viewed, replied, interviewing, hired, closed). Corrections you make in the extension are sent too, with the earlier values kept in the history.
* How long you actively use upwork.com: a count of 5-second periods in which the tab was visible and you were active. **No page contents, no keystrokes, no URLs** are recorded for this.
* When you last looked at your Proposals page, and how many rows it showed.
* Your access key (used once to connect), then a device token that identifies your browser to the server, and a short device label such as "Chrome on Windows".

Everything is sent over HTTPS to `https://ege.exeve.global`.

## Where it is stored and who can see it

* In your browser: your proposal history, settings and the device token, plus two short debug logs: one of field names and counts, and one of error messages (which can include the address of the Upwork page where an error happened). Nothing in them is sent unless you choose to copy it to someone. *Disconnect* removes the device token, so nothing more is sent, but your local history stays; remove the extension (or use the *Clear* buttons inside it) to erase it from your computer.
* On Exeve's server (member mode): in a private database that only the Exeve admins can reach through a password-protected dashboard. The server is a virtual private server operated by Exeve and its hosting provider. Cloudflare sits in front of the dashboard as a security and delivery layer. A weekly summary email goes to the addresses the admins choose. Technical server logs (such as IP address and time of request) are kept by the hosting layers for security.
* **Who sees your data:** you, and the admins who manage your account (at Exeve). We do not share it with anyone else, **we do not sell it**, we do not use it for advertising, and it is not used to decide credit or lending.

## How long we keep it

Member-mode data is kept until Exeve deletes it. If you stop being a member, an admin disables your access and your key stops working. To have your data removed, ask your account admin, or contact us through the project page below.

## Your choices

* Use free mode: nothing leaves your computer.
* Read the notice before connecting. You must tick the box to connect.
* Disconnect at any time in the extension's Settings. After that nothing more is sent.
* Ask to see or delete your member-mode data (see Contact).

## Security

Access keys are single-use and expire; device tokens and the access keys are stored on the server only as irreversible hashes; every request is checked against the account and device; the server only accepts HTTPS. No system is perfect, but we treat this data the way we would want ours treated.

## Limited use

We use the data only to provide and improve the features described above (the job score, your proposal history, and the admin dashboard and report). We do not transfer or sell it to others, and we do not allow people to read it except the admins you agreed to share it with, as required by law, or to protect the service from abuse.

## Children

The extension is for people who work on Upwork, which is for adults. It is not directed at children.

## Changes

If we change what the extension collects, we will update this page and the notice inside the extension, and ask members to accept the new notice.

## Contact

Members: your account admin. Anyone else: open an issue at <https://github.com/exeveglobal/upwork-growth-assistant/issues>.

*Upwork is a trademark of Upwork Global Inc. This extension is made by Exeve and is not affiliated with, endorsed by or sponsored by Upwork.*
