# Cleone

Cleone shows founders of developer tools and open-source projects **who is paying attention to their project**, scored, with a drafted message for each. You paste a GitHub repo; it reads public GitHub activity (recent stars, forks, similar projects) and returns people and companies in three lanes: **Partners and acquirers**, **Joiners**, **Investors**.

Plain HTML, CSS and JavaScript. No build step, no framework, no TypeScript.

| Part | Where | What it is |
|---|---|---|
| Screens | `public/index.html`, `public/app.js` | The prototype's look, plus login, settings and plan screens |
| Backend | `functions/_lib/app.js` | Every API route, one short handler each |
| Scan engine | `functions/_lib/engine.js` | Reads GitHub, split into small steps |
| Scoring and drafts | `functions/_lib/score.js` | Rule-based scores, outreach text, the paywall ranking |
| Numbers you may want to change | `functions/_lib/config.js`, top of `engine.js` | Plan limits, cutoff, strictness |
| Database | `schema.sql` (copied to `functions/_lib/schema.js`) | SQLite: 11 small tables |
| Vercel entry | `api/[...path].js`, `vercel.json` | Runs the backend on Vercel |
| Cloudflare entry | `functions/api/[[path]].js` | Runs the same backend on Cloudflare Pages |

The backend is the same on both hosts, so you can start on one and move to the other later without rewriting anything.

---

## Put it online on Vercel (works from a phone browser)

**A note on cost.** Vercel's free *Hobby* plan is for personal, non-commercial projects. Building and testing on it is fine. Once you charge customers, Vercel's terms require the *Pro* plan (about $20 a month). Cloudflare's free plan allows commercial use, so you can move there later (see the end of this section). Turso, the database, has a free plan that is enough to start.

**1. Create the database (Turso).** Go to turso.tech and sign up with GitHub. Create a database named `cleone`. Pick the **Frankfurt** location (it sits next to the Vercel region set in `vercel.json`). Open the database and copy two things: its **URL** (starts with `libsql://`) and a **token** (create one from the database page; the dashboard wording may change). You do not need to create any tables. The app creates them itself the first time it runs.

**2. Create the site (Vercel).** Go to vercel.com and sign up with GitHub. *Add New > Project*, import `Team-Cleone`. Leave everything as it is (the settings are in `vercel.json`). Before you press Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | the `libsql://...` URL from step 1 |
| `TURSO_AUTH_TOKEN` | the token from step 1 |
| `GITHUB_TOKEN` | a GitHub token (see step 3) |
| `ADMIN_EMAILS` | your email, so you get Pro for testing |

Press **Deploy**. When it finishes, open the link.

**3. The GitHub token (required).** Create it at github.com/settings/personal-access-tokens: fine-grained, **public repositories, read-only**, nothing else. Without it GitHub allows only 60 calls an hour, shared with strangers, and scans fail.

**4. Use it.** Open your site, create an account with the email you put in `ADMIN_EMAILS`, paste a repo. If something is wrong, the app tells you (for example "The database is not connected").

Changing a variable later: *Project > Settings > Environment Variables*, then *Deployments > Redeploy*.

### Or on Cloudflare Pages + D1 (free, commercial use allowed)

Create a Pages project from this repo with framework **None**, build command empty, output directory **`public`**. Create a D1 database named `cleone`, paste `schema.sql` into its Console, and bind it to the project as **`DB`** (Settings > Bindings). Add `GITHUB_TOKEN` and `ADMIN_EMAILS` as variables. Redeploy.

### Optional extras (each switches on one feature)

| Add this variable | To get |
|---|---|
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE`, `PRO_AMOUNT`, `PRO_CURRENCY` | Real subscriptions (see below) |
| `RESEND_API_KEY`, `MAIL_FROM` | Password-reset emails (resend.com has a free tier) |
| `ANTHROPIC_API_KEY` (and optionally `SCORE_MODEL`) | Claude scoring for Pro accounts. Off until you add it. Falls back to the rules if it ever fails |

**Paystack** (works for Nigerian businesses; Stripe does not). Create a Paystack account, create a monthly **Plan**, then set the variables above. `PRO_AMOUNT` is in the smallest unit (kobo or cents) and should match the plan. In Paystack's settings set the webhook URL to `https://YOUR-SITE/api/billing/webhook`. Until these are set, the plan page shows the waitlist form, as in the prototype.

## What is live and what is not

Live: accounts (email and password), Free and Pro plans, the paywall, scans, scoring, outreach drafts, Useful/Dismiss feedback, settings, data export, account deletion, billing through Paystack once you add the keys.

Not built yet: weekly email alerts (the setting is saved, nothing is sent), email verification at signup, sign-in with Google, Anthropic billing for you. Password reset needs the Resend variables.

## How scores work (and how to check them)

Scores are **rule-based**, from public facts only, so they are repeatable and never invent anything. They are not AI judgement. They are a first calibration: nobody has yet checked them against who actually replies.

That check is built in. When you copy an outreach draft, it goes into *Settings > Outreach log*. Mark who replied. The log shows the reply rate for each score band (75 to 79, 80 to 89, 90 and up). If higher scores do not get more replies, change the formulas in `functions/_lib/score.js`.

## The paywall is real

Locked matches are never sent to the browser. The Free plan gets the names and details of 1 match per lane; the rest arrive as "locked" with no data at all. The blur you see is only decoration over placeholder text.

## Run a scan from the command line (also the Actions button)

    npm install
    GITHUB_TOKEN=... npm run scan -- owner/repo --verbose

This prints the matches and how many GitHub calls each step used. The *Actions > Scan a repo* button runs the same thing on GitHub's servers.

## Tests

    npm test

Runs the backend against an in-memory database and the real page in a simulated browser. It also fakes GitHub, Paystack, Resend and Anthropic, so it costs nothing and needs no keys.
