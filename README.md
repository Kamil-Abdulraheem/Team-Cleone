# Cleone

Cleone shows founders of developer tools and open-source projects **who is paying attention to their project**, scored, with a drafted message for each. You paste a GitHub repo; it reads public GitHub activity (recent stars, forks, similar projects) and returns people and companies in three lanes: **Partners and acquirers**, **Joiners**, **Investors**.

Plain HTML, CSS and JavaScript. No build step, no framework, no TypeScript. It runs on **Vercel** with a **Neon** (PostgreSQL) database.

| Part | Where | What it is |
|---|---|---|
| Screens | `public/index.html`, `public/app.js` | The prototype's look, plus login, settings and plan screens |
| Backend | `lib/app.js` | Every API route, one short handler each |
| Scan engine | `lib/engine.js` | Reads GitHub, split into small steps |
| Scoring and drafts | `lib/score.js` | Rule-based scores, outreach text, the paywall ranking |
| Numbers you may want to change | `lib/config.js`, top of `lib/engine.js` | Plan limits, cutoff, strictness |
| Database | `schema.sql`, `lib/postgres.js` | 11 small tables. The app creates them by itself |
| Vercel entry | `api/[...path].js`, `vercel.json` | Starts the backend on Vercel |

---

## Put it online (works from a phone browser)

**A note on cost.** Vercel's free *Hobby* plan is for personal, non-commercial projects. Building and testing on it is fine. Once you charge customers, Vercel's terms require the *Pro* plan (about $20 a month). Neon has a free plan that is enough to start. The free Neon database goes to sleep when idle, so the first request after a quiet spell can take a few seconds.

**1. Create the site.** Go to vercel.com and sign up with GitHub. *Add New > Project*, import `Team-Cleone`. Leave all settings as they are (they come from `vercel.json`). Do not press Deploy yet.

**2. Create the database (Neon).** Two ways, pick one:

- *Easiest:* after the project exists, open it and go to the **Storage** tab, choose **Create Database**, pick **Neon**, and follow the prompts. Vercel adds a variable called `DATABASE_URL` for you.
- *Or by hand:* sign up at neon.com, create a project (choose the **AWS US East (N. Virginia)** region, which sits next to Vercel's default), copy its **pooled connection string**, and add it in Vercel as a variable named `DATABASE_URL`.

You do not need to create any tables. The app creates them the first time it runs.

**3. Add the other variables.** In Vercel: *Project > Settings > Environment Variables*:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | A GitHub token (see below). Required |
| `ADMIN_EMAILS` | Your email, so you get Pro for testing |

**The GitHub token (`GITHUB_TOKEN`).** It is used by **Repo scan only**. Job Radar does not need it. It is the *app's* token, not each user's: the server uses it to read public repositories on behalf of everyone, and it is never shown to the browser.

1. Go to github.com/settings/personal-access-tokens and choose **Generate new token (fine-grained)**.
2. Give it a name, set an expiry, and under **Repository access** choose **Public repositories (read-only)**. Add no permissions.
3. Copy it (it starts with `github_pat_`) into Vercel as `GITHUB_TOKEN`, then redeploy.

Without it GitHub allows only 60 calls an hour, shared with strangers, and Repo scans fail. **Never paste a token into a chat, an issue or a commit.** If you do, revoke it at the same page and make a new one. To scan from your own computer: `GITHUB_TOKEN=... npm run scan -- owner/repo`.

**4. Deploy.** Press **Deploy** (or *Deployments > Redeploy* if you already did). Open the link, create an account with the email you put in `ADMIN_EMAILS`, and paste a repo. If something is wrong the app says so, for example "The database is not connected".

### Optional extras (each switches on one feature)

| Add this variable | To get |
|---|---|
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE`, `PRO_AMOUNT`, `PRO_CURRENCY` | Real subscriptions (see below) |
| `RESEND_API_KEY`, `MAIL_FROM` | Password-reset emails (resend.com has a free tier) |
| `PREVIEW_MODE` | `1` lets anyone in with any email and password, into an isolated test workspace, so you can look around a new deployment. **Turn it off before real users arrive** (see Trying it out) |
| `HEALTH_DETAIL` | Set to `0` to hide recent error messages on `/api/health` once everything works |
| `SOURCE_MODE` | Leave UNSET in production. `sandbox` serves clearly-labelled sample vacancies for development with no internet (see Sandbox mode) |
| `DEFAULT_FEATURES` | Optional. Which features start switched on for new accounts, e.g. `{"repo":true}`. Default: Job Radar on, Repo scan off |
| `JOB_CHEAP_MODEL`, `JOB_STRONG_MODEL` | Job Radar AI models (defaults `claude-haiku-5-5` and `claude-sonnet-5-5`). Only used when `ANTHROPIC_API_KEY` is set |
| `CV_ENCRYPTION_KEY` | Job Radar: encrypts saved CVs (AES-GCM). Without it, CV text is read for skills but never stored |
| `CRON_SECRET` | Job Radar: authorizes the scheduled run (`/api/cron/jobs`). It syncs sources, expires old vacancies, audits "open" verdicts and sends Pro alerts. Without it the run refuses to start. Vercel's free plan runs it daily (vercel.json); for every 30 minutes: add the repo secrets `APP_URL` and `CRON_SECRET`, then copy `deploy/github-sync-workflow.yml` to `.github/workflows/sync.yml` (do this in GitHub's web editor, or push with a token that has the `workflow` permission) |
| `ANTHROPIC_API_KEY` (and optionally `SCORE_MODEL`) | Claude for Pro accounts: Repo scan scoring, and Job Radar CV reading, borderline-job reading and letters. Off until you add it. Falls back to the rules if it ever fails |

**Paystack** (works for Nigerian businesses; Stripe does not). Create a Paystack account, create a monthly **Plan**, then set the variables above. `PRO_AMOUNT` is in the smallest unit (kobo or cents) and should match the plan. In Paystack's settings set the webhook URL to `https://YOUR-SITE/api/billing/webhook`. Until these are set, the plan page shows the waitlist form, as in the prototype.

## Trying it out, and fixing it when it does not work

**Open `/api/health` first** (for example `https://your-site.vercel.app/api/health`). It works even when the database does not, and it tells you in plain words what is wrong and what to do: missing or wrong `DATABASE_URL`, wrong password, a sleeping database, tables not created, and the last few unexpected errors. It never shows a secret. If that page itself is an error page from Vercel, open Vercel > your project > **Logs** and read the newest red line for `/api`.

After you add or change any variable in Vercel, go to **Deployments > the latest one > Redeploy**. Changes do not apply until you do.

**Preview mode.** Set `PREVIEW_MODE` to `1` in Vercel and redeploy. The login and sign-up screens then accept any email and any password and open a separate preview workspace. This is safe by design, but it is for testing only:

- A preview login never opens a real account. If the email belongs to a real account or is in `ADMIN_EMAILS`, the normal password check applies. So the owner signs up once with a real password (as the admin) and keeps full access.
- Preview workspaces are never admin, never use AI or send email, and have their own limits (20 scans a month, all matches unlocked) so every feature can be looked at.
- Each typed email gets its own workspace, and anyone typing the same email enters the same one. Do not put anything real in it.
- A yellow bar on every screen says it is on. **Delete the variable and redeploy before real users arrive**, otherwise nobody can create a real account.

**The home screen** is an "Ask for anything" bar. Type what you want in plain words, such as "backend developer jobs in Lagos" or "only remote now", or paste a GitHub repo. The "+" adds your CV or switches on Repo scan, the microphone fills the box by voice, Recent activities shows what you did, and the bottom tabs are Home, Explore (your matches), History (everything you did) and Account.

## Features (switch on what you need)

Cleone is a set of features, switched on from **Menu > Features**.

- **Job Radar** (on for everyone): global job discovery, with Nigeria as one of the first markets.
- **Repo scan** (off until you switch it on): scans a GitHub repo for partners and acquirers, joiners, investors and **co-founders**. Every result opens to full details.

### Job Radar: how it works

1. **Sources** (`lib/sources/`). Independent adapters turn each source into one standard vacancy shape. Greenhouse, Lever and Ashby public job-board APIs; configurable RSS/Atom feeds; employer career pages (only with the employer's authorization, and only if `robots.txt` allows it); public feeds from Remotive, Arbeitnow and RemoteOK. **Adding a source means adding one adapter**: nothing in the matching engine changes.
2. **Sync** (`lib/sync.js`). Sources are fetched in parallel and stored one at a time. One broken source never stops the others. Every request has a timeout, retries with backoff, per-host rate limiting, and is logged. Vacancies a source stops listing are marked **removed**; ones past their closing date are marked **expired**; a suspiciously small response never wipes out records.
3. **Truth about "open".** A job on an employer's own board (Greenhouse, Lever, Ashby, career page) is open because that board lists it right now. A job from a feed is "could not verify" until its apply page is checked. We never guess.
4. **Safety.** Scam warnings (pay-to-apply, WhatsApp-only, personal email, fake-cheque patterns), ghost and repeat-posting flags, duplicates across boards shown once.
5. **Matching** (`lib/match.js`). A weighted, explainable score over skills, role, experience, responsibilities, location, salary, qualifications and work type. **Missing information is "not stated", not a mismatch.** Every match shows strengths, missing requirements, what could not be compared, transferable skills ("your Flask experience transfers to Django") and adjacent roles you could move into.
6. **Pro.** Continuous monitoring: the scheduled run keeps watching and alerts you when a highly relevant, confirmed-open job appears, re-checked just before sending, plus a "this just closed" update. **Cleone never applies for you.**

### Adding sources (admins)

Menu > **Source Intelligence** > *Add a source*. Examples (find the names in the employer's job-board URL, then press *Run live diagnostic* to confirm it responds):

| Type | You enter | Where the name comes from |
|---|---|---|
| Greenhouse | board token | `boards.greenhouse.io/<token>` |
| Lever | company slug (add `region: eu` for EU) | `jobs.lever.co/<slug>` |
| Ashby | job board name | `jobs.ashbyhq.com/<name>` |
| RSS / Atom | feed URL (https) | the employer's or board's jobs feed |
| Career page | page URL, company, and YES to confirm authorization | only if the employer authorized it |

To write a new adapter, add an entry to `ADAPTERS` in `lib/sources/adapters.js` (`fetch(config)` returns the standard shape) and a sample response to `lib/sources/fixtures.js`.

### Nigerian boards (Jobberman, MyJobMag)

The connectors exist but are **disabled**. These sites publish no API we have permission to use and their terms restrict automated collection, so **Cleone makes no request to them**. To enable one: get written approval from the site, ask for a partner feed (RSS/Atom or API), then in Source Intelligence press **Record approval** and enter the feed URL they gave you and `YES`. Until then they stay off, and the dashboard says why. Nigeria is still covered today by the global sources (remote roles open to Africa are recognised, and US-only remote roles are flagged), by any Nigerian employer using Greenhouse, Lever or Ashby, and by any Nigerian RSS feed you are allowed to use.

### Sandbox mode and sample data

With `SOURCE_MODE=sandbox` the sources serve built-in sample responses (every link ends in `sample.invalid`, a domain that cannot exist), everything stored is marked synthetic, and the app shows a red **SANDBOX DATA** banner. Sample and real vacancies are never mixed, the live diagnostic refuses to run, and no alert is ever sent for sample data. **Leave `SOURCE_MODE` unset in production.**

### Source Intelligence dashboard (admins)

Active sources, healthy sources, jobs collected, new jobs today, expired jobs, failed requests (24 h) and last synchronization, plus per-source status, last success, HTTP status, jobs retrieved and the error message. **Run live diagnostic** makes real HTTP requests from the deployed server (it is a hard error in sandbox mode, because a diagnostic must never be simulated). A red banner appears if no source has synced recently, so you can tell new findings from old records.

### The 98% "open" target

Two measurements, both on the dashboard: (1) a daily random sample of jobs we called open is re-checked by an independent page check and we count agreement; (2) the share of alerts people reported as "already closed". The target is only shown as **met** when the 95% confidence interval's lower bound is at least 98% over at least 100 audits. Until then it says **not enough audits** or **inconclusive**. Audits of page-based verdicts reuse the same method, so they are weaker evidence than audits of feed-based ones; the dashboard separates them.

### With and without an Anthropic API key

Everything works with no key, from rules. With `ANTHROPIC_API_KEY`, **Pro accounts only**, and capped at 300 calls per person per month: a **cheap model** reads borderline jobs the rules found too little in; a **strong model** reads a CV once and writes tailored letters. Answers are cached, validated, and any failure falls back to the rules. AI never decides what is open or a scam, and nothing is ever sent for you.

Not built yet: Telegram; Nigerian boards until they approve access; employer career-page integrations need each employer's authorization.

## What is live and what is not

Live: accounts (email and password), Free and Pro plans, the paywall, scans, scoring, outreach drafts, Useful/Dismiss feedback, settings, data export, account deletion, billing through Paystack once you add the keys.

Not built yet: weekly email alerts (the setting is saved, nothing is sent), email verification at signup, sign-in with Google. Password reset needs the Resend variables.

## How scores work (and how to check them)

Scores are **rule-based**, from public facts only, so they are repeatable and never invent anything. They are not AI judgement. They are a first calibration: nobody has yet checked them against who actually replies.

That check is built in. When you copy an outreach draft, it goes into *Settings > Outreach log*. Mark who replied. The log shows the reply rate for each score band (75 to 79, 80 to 89, 90 and up). If higher scores do not get more replies, change the formulas in `lib/score.js`.

## The paywall is real

Locked matches are never sent to the browser. The Free plan gets the names and details of 1 match per lane; the rest arrive as "locked" with no data at all. The blur you see is only decoration over placeholder text.

## Run a scan from the command line (also the Actions button)

    npm install
    GITHUB_TOKEN=... npm run scan -- owner/repo --verbose

This prints the matches and how many GitHub calls each step used. The *Actions > Scan a repo* button runs the same thing on GitHub's servers.

## Tests

    npm test

Needs nothing installed. It runs the backend against a real PostgreSQL that runs inside Node (PGlite), and the real page in a simulated browser. It fakes GitHub, Paystack, Resend and Anthropic, so it costs nothing and needs no keys. To test against a real PostgreSQL server instead, run `TEST_DATABASE_URL=postgres://user:pass@localhost/dbname npm test`.
