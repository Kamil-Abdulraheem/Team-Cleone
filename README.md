# Cleone

Cleone shows founders of developer tools and open-source projects **who is paying attention to their project**, scored, with a drafted message for each. You paste a GitHub repo; it reads public GitHub activity (recent stars, forks, similar projects) and returns people and companies in three lanes: **Partners and acquirers**, **Joiners**, **Investors**.

Plain HTML, CSS and JavaScript. No build step, no framework, no TypeScript.

| Part | Where | What it is |
|---|---|---|
| Screens | `public/index.html`, `public/app.js` | The prototype's look, plus login, settings and plan screens |
| Backend | `functions/api/[[path]].js` | Every API route, one short handler each |
| Scan engine | `functions/_lib/engine.js` | Reads GitHub, split into small steps |
| Scoring and drafts | `functions/_lib/score.js` | Rule-based scores, outreach text, the paywall ranking |
| Numbers you may want to change | `functions/_lib/config.js`, top of `engine.js` | Plan limits, cutoff, strictness |
| Database | `schema.sql` | Cloudflare D1 (SQLite): 11 small tables |

It runs free on **Cloudflare Pages + D1** (no Vercel). Cloudflare's free plan allows 100,000 requests a day.

---

## Put it online (all of this works from a phone browser)

**1. Create the site.** In the Cloudflare dashboard: *Workers & Pages > Create > Pages > Connect to Git*, pick this repo and the `main` branch. Framework preset: **None**. Build command: leave empty. Build output directory: **`public`**. Save and deploy.

**2. Create the database.** *Storage & Databases > D1 SQL database > Create*, name it `cleone`. Open it, go to the **Console** tab, paste the whole contents of `schema.sql`, and run it.

**3. Connect them.** Open your Pages project > *Settings > Bindings > Add > D1 database*. Variable name: **`DB`**. Choose `cleone`. Save, then redeploy (*Deployments > Retry deployment*).

**4. Add your GitHub token (required).** Pages project > *Settings > Variables and Secrets > Add*, type **Secret**, name **`GITHUB_TOKEN`**. Create the token at github.com/settings/personal-access-tokens: fine-grained, **public repositories read-only**, nothing else. Without it GitHub only allows 60 calls an hour shared with strangers, and scans fail.

**5. Make yourself Pro for testing.** Add a variable **`ADMIN_EMAILS`** with your email. Sign up with that email and you get Pro without paying.

Open your site, create an account, paste a repo. That is the whole setup.

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
