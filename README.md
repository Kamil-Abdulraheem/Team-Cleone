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

The GitHub token: create it at github.com/settings/personal-access-tokens as a fine-grained token with **public repositories, read-only** and nothing else. Without it GitHub allows only 60 calls an hour, shared with strangers, and scans fail.

**4. Deploy.** Press **Deploy** (or *Deployments > Redeploy* if you already did). Open the link, create an account with the email you put in `ADMIN_EMAILS`, and paste a repo. If something is wrong the app says so, for example "The database is not connected".

### Optional extras (each switches on one feature)

| Add this variable | To get |
|---|---|
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE`, `PRO_AMOUNT`, `PRO_CURRENCY` | Real subscriptions (see below) |
| `RESEND_API_KEY`, `MAIL_FROM` | Password-reset emails (resend.com has a free tier) |
| `ANTHROPIC_API_KEY` (and optionally `SCORE_MODEL`) | Claude scoring for Pro accounts. Off until you add it. Falls back to the rules if it ever fails |

**Paystack** (works for Nigerian businesses; Stripe does not). Create a Paystack account, create a monthly **Plan**, then set the variables above. `PRO_AMOUNT` is in the smallest unit (kobo or cents) and should match the plan. In Paystack's settings set the webhook URL to `https://YOUR-SITE/api/billing/webhook`. Until these are set, the plan page shows the waitlist form, as in the prototype.

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
