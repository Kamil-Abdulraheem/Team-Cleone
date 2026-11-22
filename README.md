# Cleone backend

Attention radar for developer-tool founders. Paste a GitHub repo, get scored people and organizations who appear to be paying attention, with a drafted outreach email for each.

Next.js 15 route handlers, SQLite (better-sqlite3), GitHub REST API, Anthropic SDK. `index.html` is the clickable UI prototype (v1).

## Run it

Needs Node 20.6 or newer.

    npm install
    cp .env.example .env.local     # then fill in ANTHROPIC_API_KEY and GITHUB_TOKEN
    npm run scan -- github.com/owner/repo --dry   # GitHub collection only, no API key needed for Claude
    npm run scan -- github.com/owner/repo         # full scan with Claude scoring
    npm run dev                                    # API on http://localhost:3000

`GITHUB_TOKEN` can be a read-only token. A scan makes roughly 100-150 GitHub calls; without a token GitHub allows only 60 an hour.
Add `--verbose` to a dry run to see the exact evidence Claude will receive.

## API

| Method and path | Body or query | Returns |
|---|---|---|
| POST /api/scan | `{repoUrl}` | `{matches, hiddenBelowCutoff, collected, scored}` |
| GET /api/scan | `?repoUrl=` | stored matches |
| POST /api/outreach | `{matchId}` | `{email}` |
| POST /api/feedback | `{matchId, action: "like"\|"dismiss", reason?}` | `{ok: true}` |
| GET /api/cron/scan | header `Authorization: Bearer $CRON_SECRET` | rescan results |

## How it works

1. **Collect (`lib/github.ts`).** Three public signals, each optional:
   - *Recent stars* from the repo events feed (timestamped, newest first) plus the stargazers API where available.
   - *Forks*, preferring organizations and forks where the owner pushed their own commits. Untouched forks are weak evidence.
   - *Similar projects* found with multi-topic searches ranked by stars. Generic topics ("cli", language names) count for little; shared specific topics, language and description keywords form a relevance score, and anything under `MIN_RELEVANCE` is dropped.
2. **Merge people.** One person with several signals (starred and forked) stacks evidence. People who name the same employer merge into one *company* candidate in the strategic lane ("3 people from Acme engaged"). A strong individual who names an employer also lands in strategic.
3. **Gate and balance.** Each candidate gets a deterministic evidence strength (0-100) from account quality and recency. Anything under `MIN_SIGNAL` never reaches Claude. Source quotas (12 star / 12 similar / 6 fork, 30 total) stop one noisy source from filling the list.
4. **Score (`lib/claude.ts`).** Batches of 10 go to `SCORE_MODEL` with today's date, evidence strength and the supplied facts only. Significance, resonance and timing are each 0-100. Final = 0.3 x significance + 0.4 x resonance + 0.3 x timing. Matches under 75 are hidden.
5. **Rescan economics (`lib/pipeline.ts`).** Only new candidates, or candidates whose evidence grew by 15+ points, are rescored. Likes and dismissals bias lane ordering (+/-2 each, capped at +/-10).
6. **Outreach.** Drafted on request with `OUTREACH_MODEL`, under 120 words. Public contact details (email, site, X handle) are shown when the person published them. Send manually; the tool never sends email.

All thresholds are constants at the top of `lib/github.ts`. Tune them against real scans.

Schema (4 tables): `projects`, `candidates`, `matches`, `feedback`. See `lib/db.ts`. If you ran an earlier version, delete `data/cleone.db`; the schema changed.

## Privacy

Only public GitHub data is used. Profiling named individuals and cold email fall under GDPR and CAN-SPAM style rules. Keep a human in the loop, honor opt-outs, and do not store more than you need.

## Not built yet

Investors lane, arXiv/RSS ingestion, the real UI wired to the API, accounts and billing, contact-detail enrichment (GitHub emails are often hidden).

## Notes

- The SQLite file lives in `./data` (gitignored). Use a host with a persistent disk, not a serverless filesystem.
- Match quality is unproven. Judge the first real scan output before building more.
