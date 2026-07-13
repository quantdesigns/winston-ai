# Jobs pipeline

Multi-marketplace job scraper that fans one query across LinkedIn,
Indeed, Glassdoor, Upwork, and Google Jobs via [Apify](https://apify.com),
scores the results against a candidate's resume, persists them to a
local SQLite DB, and renders a searchable jobs board. Optionally
auto-applies via a stealth Playwright agent using resume variants
generated per-role and parked in Google Drive.

This is a feature branch (`feat/jobs-pipeline`) so the base platform
on `main` stays small. To work on or run it, branch from here.

## What this branch adds

- **`internal/jobs/jobs.go`** — typed wrapper around the SQLite DB used by
  the agent pipeline. Lists, filters, mutates rows; runs out-of-process
  Node helper tools for things the agent does end-to-end.
- **`internal/router/jobs_handlers.go`** — `/api/jobs*` and
  `/api/jobs/wizard*` HTTP handlers. Triggers, status updates, manual
  apply flows, scrape-wizard preview/import.
- **`internal/router/drive_preflight.go`** — checks Google Drive is
  reachable (refresh token still valid, scopes present) before spawning
  expensive tailoring agents.
- **`web/src/app/jobs/`** — Next.js pages: the jobs board, the multi-marketplace
  scrape wizard, and a per-run report page.
- **`web/src/app/JobsScraperStatus.tsx`** — top-level status pill that
  re-attaches across page navigation so a running scrape keeps reporting
  even if you bounce around the app.

## Configuration

Set these in `.env` (the jobs handlers read from the environment so the
pipeline is portable):

| Variable | Default | Purpose |
|----------|---------|---------|
| `WINSTON_JOBS_DB` | `~/.claude/data/jobs.db` | SQLite DB the agents read and write. |
| `WINSTON_JOBS_TOOLS_DIR` | `~/.claude/tools/jobs` | Directory holding the Node helper tools. |
| `WINSTON_DRIVE_CREDS_FILE` | `drive-creds.json` | Filename of the google-workspace MCP credentials JSON used by the Drive preflight (typically `<your-email>.json`). |

## Helper tools

The scrape/score/contact tools ship in [`tools/jobs/`](../tools/jobs). Point
`WINSTON_JOBS_TOOLS_DIR` at that directory to run the pipeline from a fresh
clone:

```bash
export WINSTON_JOBS_TOOLS_DIR="$PWD/tools/jobs"
```

They read `APIFY_TOKEN` and `SERPAPI_KEY` from the environment (or
`~/.claude/.env`) — no keys are committed.

| Tool | Purpose |
|------|---------|
| `apify-{linkedin,indeed,glassdoor,upwork}-jobs.js` | Marketplace scrapers (Apify actors). |
| `serpapi-google-jobs.js` | Google Jobs via SerpAPI. Google is deliberately *not* an Apify actor. |
| `company-contacts.js` | Resolves a company's public careers page and corporate role mailbox. Company-level only — rejects anything person-shaped. |
| `jobs-db.js` | Schema + import/update against the jobs SQLite DB. |
| `score-jobs.js` | Rates jobs 0-100 against the resume via the `claude` CLI. The import path stores every row at 0; this fills it in. Runs on subscription auth — no API key. |
| `welcome-package.js` | Deep-research briefing for a run's top matches: what the company does, a sourced growth read, the real Glassdoor rating, company-published contacts, a cover letter, and a resume-gap analysis. Unfound facts stay `null` — nothing is estimated. |

The auto-apply tools (`jobs-apply.js`, `upwork-apply.js`) are **not** in this
repo. They embed the applicant's real name, address, phone, and email in order
to fill application forms, so publishing them would leak personal data. Keep
them in `~/.claude/tools/` and set `WINSTON_JOBS_TOOLS_DIR` there if you use
the apply flow; the endpoints that call them return "tool missing" otherwise.

The agent flow expects companion Claude agent files in
`~/.claude/agents/` named `jobs-weekly`, `jobs-personal-linkedin`, and
`jobs-apply`. The router code references those names — adapt to your
own agent set if you want different ones.

## API

All endpoints are under `/api/jobs/*` and gated by Basic Auth + rate
limit + audit log (same as every other Winston endpoint).

| Method | Path | What |
|---|---|---|
| GET | `/api/jobs` | List jobs (with filter & sort query params). |
| GET | `/api/jobs/stats` | Counts by status / source / score buckets. |
| PUT | `/api/jobs/{id}/status` | Update application status. |
| PUT | `/api/jobs/{id}/flag` | Pin / unpin / mark. |
| PUT | `/api/jobs/{id}/variant` | Switch resume variant for one job. |
| DELETE | `/api/jobs/{id}` | Remove a row. |
| POST | `/api/jobs/trigger` | Kick off the weekly scrape + package pipeline async. |
| POST | `/api/jobs/prune` | Drop stale rows (> 8 weeks, not applied). |
| POST | `/api/jobs/apply-from-drive` | Sync drafted packages from Drive, then auto-apply. |
| POST | `/api/jobs/apply-selected` | Apply to a user-selected list of job IDs. |
| POST | `/api/jobs/apply-selected-interactive` | Same as above but in a foreground browser. |
| POST | `/api/jobs/apply-upwork-selected` | Upwork has its own apply tool. |
| POST | `/api/jobs/wizard/preview` | Start an Apify multi-source scrape preview. |
| GET | `/api/jobs/wizard/preview/{runID}` | Poll preview status. |
| GET | `/api/jobs/wizard/report/{runID}` | Read the wizard report. |
| POST | `/api/jobs/wizard/import/{runID}` | Import wizard results into the jobs DB. |

## Architecture

```
Web UI (jobs board + wizard)
   ↓
HTTP (/api/jobs/*)
   ↓
internal/router/jobs_handlers.go
   ├─→ internal/jobs.Store           — direct SQLite reads/writes for fast list/filter
   ├─→ internal/jobs.RunTool         — execs Node helpers (jobs-db.js, jobs-apply.js, …)
   └─→ agents.Manager.SpawnAgent     — kicks off jobs-weekly / jobs-apply / etc. asynchronously
                                       (agent uses MCP tools: Apify scrapers, Drive, Sheets)
```

The HTTP path is sync for board operations and async for anything that
spawns an agent (an agent run can take 10+ minutes). The status pill
in the UI polls the agent's run state so the user can navigate away
and come back without losing the run.
