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

`GITHUB_TOKEN` can be a read-only token. Without it GitHub allows only 60 requests an hour and a scan will fail.

## API

| Method and path | Body or query | Returns |
|---|---|---|
| POST /api/scan | `{repoUrl}` | `{matches, hiddenBelowCutoff, collected, scored}` |
| GET /api/scan | `?repoUrl=` | stored matches |
| POST /api/outreach | `{matchId}` | `{email}` |
| POST /api/feedback | `{matchId, action: "like"\|"dismiss", reason?}` | `{ok: true}` |
| GET /api/cron/scan | header `Authorization: Bearer $CRON_SECRET` | rescan results |

## How it works

1. `lib/github.ts` reads the repo and README, then collects up to 12 recent forkers and up to 15 owners of similar repos (by first topic and language). Each is enriched with profile and recent repos. Organizations go to the `strategic` lane, individuals to `joiners`.
2. `lib/claude.ts` scores candidates in batches of 10 with `SCORE_MODEL` (significance, resonance, timing, each 0-100). Final score = 0.3 x significance + 0.4 x resonance + 0.3 x timing.
3. `lib/pipeline.ts` keeps matches of 75 or higher, scores only new candidates on rescans, and sorts by score plus a per-lane bias of +2 per like and -2 per dismissal, capped at +/-10.
4. Outreach is drafted on request with `OUTREACH_MODEL` (under 120 words). Send it manually; the tool never sends email.

Schema (4 tables): `projects`, `candidates`, `matches`, `feedback`. See `lib/db.ts`.

## Not built yet

Investors lane, arXiv/RSS ingestion, the real UI wired to the API, accounts and billing, contact-detail enrichment (GitHub emails are often hidden).

## Notes

- The SQLite file lives in `./data` (gitignored). Use a host with a persistent disk, not a serverless filesystem.
- Match quality is unproven. Judge the first real scan output before building more.
