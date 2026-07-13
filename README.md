<div align="center">

# Winston

A personal AI assistant that runs on a machine you control, exposes its agents through Slack, a web dashboard, and a REST API, and lets you schedule any of them as cron jobs.

[![CI](https://github.com/codephilip/winston-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/codephilip/winston-ai/actions/workflows/ci.yml)
[![Go 1.25](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

</div>

![Winston dashboard](docs/img/dashboard.webp)

---

## What this is

Winston is a small Go service that wraps the [Claude CLI](https://github.com/anthropics/claude-code) on a dedicated machine and turns it into a multi-surface assistant.

Each "agent" is just a Markdown file on disk — a `name`, a `description`, and a system prompt. When the router starts, every agent file becomes four things at once:

- a Slack slash command (`/marketing`, `/winston`, …)
- an HTTP endpoint (`POST /api/agents/{name}/run`)
- a card on the web dashboard with chat + voice
- something the scheduler can run on a cron expression

The point of running on your own box rather than in a cloud sandbox is that agents inherit the whole machine — your shell, `PATH`, SSH keys, the Gmail/Drive credentials cached by the [Google Workspace MCP](https://github.com/anthropics/anthropic-cookbook/tree/main/mcp), your databases, your local CLIs. A scheduled agent can scrape a site at 8am, drop the result in Drive, and post a summary to Slack — using the same tools you'd use by hand.

This README covers the base platform. Two feature branches show what's possible on top of it:

- [`feat/jobs-pipeline`](../../tree/feat/jobs-pipeline) — multi-marketplace job scraper (LinkedIn / Indeed / Glassdoor / Upwork / Google Jobs via Apify) with scoring, a jobs board UI, and Drive-backed auto-apply packages.
- [`feat/social-workflow`](../../tree/feat/social-workflow) — branded social-content pipeline with image generation skills (Google Nano Banana / Gemini 3 Pro Image), demoed on a fictional "Acme Insights" brand.

![Jobs board with 756 scraped listings, scored against the resume, with multi-select auto-apply](docs/img/jobs-board.webp)
<sub>*The jobs board from `feat/jobs-pipeline` — 756 listings scraped across LinkedIn / Indeed / Glassdoor / Upwork / Google Jobs, scored against the candidate's resume, with a multi-select auto-apply flow on top.*</sub>

---

## The agent-workflow pattern

```
~/.claude/agents/winston.md          → /winston (Slack)
                                      → POST /api/agents/winston/run
                                      → dashboard card with chat + voice
                                      → schedulable on a cron expression
```

A single Markdown file:

```markdown
---
name: researcher
description: Deep research on any topic
model: opus            # opus | sonnet | haiku
timeout: 600
max_turns: 25
---

You are a research agent. Given a topic, research it thoroughly with web
search, synthesize findings, and present a clear summary with sources.
```

Drop it in `~/.claude/agents/`, restart the router, and the agent is immediately reachable from every surface. The agent runs as a `claude --print` subprocess in your environment, so it has access to:

- every CLI on your `PATH`
- your `~/.ssh` and `~/.config` credentials
- any [MCP](https://modelcontextprotocol.io) servers you've configured (Google Workspace, Figma, Postman, Firecrawl, etc.)
- your local files and databases

Threaded Slack replies resume the same Claude session (`claude --resume <id>`), so a conversation in a thread keeps its context.

---

## Architecture

```
Your phone / laptop
  → Slack: "/winston what changed in my project this week?"
    → Slack servers
      → outbound websocket (Socket Mode) into your machine    ← no inbound port
        → Go router on 127.0.0.1:49710
          → rate-limit → auth → input sanitization
            → claude --print --model … (subprocess)
              → MCP tools · scripts · DBs · APIs · SSH …
                → response streamed back into the Slack thread
```

The router binds to `127.0.0.1` only — nothing on the public internet ever reaches it. Slack works because the worker holds an outbound Socket Mode websocket. For remote access to the web UI, [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) is a good fit (your tailnet only, no public endpoint).

```
cmd/winston/main.go            HTTP server + Socket Mode loop
internal/
  agents/manager.go           Agent registry, sessions, Claude subprocess exec
  router/                     HTTP routes, Next.js proxy, auth, audit log, rate limit
  scheduler/                  Cron-driven scheduled agent runs
  slack/                      Socket Mode, slash commands, events, interactive
  sanitize/                   Input validation + prompt-injection defence
  voice/                      ElevenLabs TTS/STT
  notify/                     Ops notifications (router up/down)
  kali/                       SSH wrapper for an optional Kali VM (pentester agent)
web/src/app/                  Next.js dashboard — agents, chat, voice, schedules
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/OVERVIEW.md`](docs/OVERVIEW.md) · [`docs/AGENTS.md`](docs/AGENTS.md).

---

## Running it locally

### Docker (simplest)

You need Docker, Docker Compose, and the [Claude CLI](https://github.com/anthropics/claude-code) authenticated once (`npm i -g @anthropic-ai/claude-code && claude`).

```bash
git clone https://github.com/codephilip/winston-ai.git winston
cd winston
cp .env.example .env          # fill in Slack + other tokens
mkdir -p ~/.claude/agents     # your agents live here (mounted into the container)

cat > ~/.claude/agents/winston.md <<'EOF'
---
name: winston
description: Personal assistant and orchestrator
model: sonnet
---
You are Winston, a personal AI assistant with full access to this machine.
Be concise and practical.
EOF

docker compose up -d --build
curl http://localhost:49710/health        # {"status":"ok",...}
open http://localhost:49710               # dashboard
```

`docker-compose.yml` mounts `~/.claude/agents` read-through, persists config and logs in named volumes, and publishes **only** `127.0.0.1:49710`. Slack tokens come later — the dashboard works without them.

### Native (Go + Node)

```bash
# Prereqs: Go 1.25+, Node 20+, Claude CLI authenticated
make deps                          # go mod tidy + npm install
make build                         # bin/winston
cd web && npm run build && cd ..

# Two tabs:
make run                           # tab 1 — Go router on :49710
cd web && npm start                # tab 2 — Next.js on :49711

# Or install as a launchd / systemd service:
make install-services
```

Full ops reference: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Connecting Slack

Slack is the only piece of setup that needs clicking through a web UI, and it's also the one place where the security model gets nontrivial — see [Security](#security) below. With **Socket Mode** there are no request URLs to host and nothing inbound to your machine: the router dials out to Slack and receives events over a websocket.

The setup is ~5 minutes:

1. **[api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.** Name it `Winston`, pick your workspace.
2. **Basic Information → App Credentials** → copy **Signing Secret** → `.env` `SLACK_SIGNING_SECRET=…`.
3. **Socket Mode → enable.** Generate an App-Level Token with scope `connections:write` → `.env` `SLACK_APP_TOKEN=xapp-…`.
4. **App Home** → set Display Name `Winston`, username `winston`.
5. **OAuth & Permissions → Bot Token Scopes** → add: `chat:write`, `chat:write.customize`, `commands`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`.
6. **Install to Workspace** → copy **Bot User OAuth Token** → `.env` `SLACK_BOT_TOKEN=xoxb-…`.
7. **Slash Commands** → create `/winston` (and one per agent you want a shortcut for). No Request URL needed.
8. **Event Subscriptions → enable** → subscribe to `app_mention`, `message.channels`, `message.groups`, `message.im`. No Request URL needed.
9. **Interactivity & Shortcuts → enable.** No Request URL needed.

Restart the worker so it picks up the new tokens:

```bash
docker compose up -d --force-recreate router
docker compose logs -f router | grep slack/socket   # expect: [slack/socket] connected
```

Then from any channel the app is in:

```
/winston hello
```

You get a `_thinking…_` placeholder, then a reply in a new thread. Reply in that thread to continue the conversation — Winston resumes the same Claude session and context carries over.

<p align="center"><img src="docs/img/slack-thread.webp" alt="Slack thread where Winston introduces itself, names the model, and lists the available sub-agents and MCP tools" width="540"></p>
<sub>*A threaded Slack reply. Winston identifies the model it's running, the machine it's on, and the sub-agents and MCP tools it has on hand — because everything runs in your local environment, "what can you do" has a concrete, machine-specific answer.*</sub>

---

## Scheduling

The scheduler is just `robfig/cron` running inside the router process. A schedule is `(agent, cron expression, prompt, optional Slack channel)`. Create one via the dashboard, the API, or in Slack:

```bash
curl -X POST -u "$USER:$PASS" http://localhost:49710/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "researcher",
    "cron": "0 8 * * 1",
    "prompt": "Summarise what shipped in our repos last week.",
    "slack_channel": "#general"
  }'
```

Because the scheduled run is just another invocation of the same agent, it has access to the same tools — including anything you've authenticated locally (Gmail, Drive, internal APIs, SSH). That's the part that's awkward to get from a cloud-hosted scheduler.

![Schedules day view showing a rivalytics Social run at 7:30 AM](docs/img/schedules-day.webp)
<sub>*Schedules day view: a `rivalytics-social` agent fires at 07:30 every day — scrapes competitor signals, drafts a post, generates the visuals, drops the package in Drive. Cron entries are agents, not text-only completions.*</sub>

---

## Surfaces

| Surface | How |
|---|---|
| **Slack** | `/marketing analyze the Acme campaign` — every agent is a slash command. Reply in-thread to continue. |
| **Model override** | `/winston opus: write a detailed architecture proposal` — switch model per prompt. |
| **@mention** | `@Winston /researcher what's trending in tech?` in any channel the bot is in. |
| **Web dashboard** | `http://localhost:49710` — agent cards, chat, voice, schedules. |
| **REST API** | `POST /api/agents/{name}/run`, `GET/POST/DELETE /api/schedules` — all Basic-Auth'd. |
| **Voice** | Speak to agents, hear replies (needs `ELEVENLABS_API_KEY`). |

```bash
curl -X POST -u "$USER:$PASS" http://localhost:49710/api/agents/winston/run \
  -H 'Content-Type: application/json' -d '{"prompt": "what changed in my project this week?"}'
```

---

## Security

Two things are worth being honest about:

**The HTTP surface is small and locked down.** The router and the Next.js frontend bind to `127.0.0.1` only. Every `/api/*` request goes through rate limiting, input sanitization (4k char truncation, known prompt-injection patterns stripped), and an audit log. CSP, `X-Frame-Options: DENY`, nosniff, and referrer policy are set on every response. Full threat model: [`docs/SECURITY.md`](docs/SECURITY.md).

**Slack is the one piece that meaningfully widens the trust boundary.** Slash commands and DMs to the bot become prompts that run on your machine with your user's permissions. The mitigation is: (1) input sanitization on the way in, (2) Socket Mode so the path is outbound-only with no public endpoint, (3) workspace-level controls in Slack itself (who can install the app, who can see the bot, who can DM it). It's still worth knowing that anyone with access to that Slack workspace can ask Winston to do things, and that "things" can include running shell commands. If you're putting Winston in a busy workspace, scope every agent's system prompt deliberately and consider an allow-list of channels in `internal/slack/` before going further.

Other operational notes:

- `.env` is git-ignored; never commit secrets.
- Each agent runs as your user — there is no sandbox. Treat agent prompts as part of your attack surface.
- Keep the Claude CLI updated (`npm i -g @anthropic-ai/claude-code`).
- Rotate the Slack tokens if a laptop with the `.env` walks off.

---

## Repo quality

- CI on every PR ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — Go unit tests with `-race`, ≥60% coverage gate, build verification, security checks (hardcoded-secret scan, dangerous-pattern audit), `golangci-lint`, frontend type-check + lint + build.
- `make test` runs the suite with the race detector; `make test-security` runs the security tests; `make test-cover` produces an HTML coverage report.
- Subsystem docs in [`docs/`](docs/). Conventions in [`CONTRIBUTING.md`](CONTRIBUTING.md).

```bash
make test          # race-enabled unit tests
make test-cover    # coverage report
make lint          # go vet + golangci-lint
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: claude` | `npm i -g @anthropic-ai/claude-code`; ensure npm global bin is on `PATH`. |
| Slack bot silent | `SLACK_APP_TOKEN` set and starts with `xapp-`? Router log shows `[slack/socket] connected`? Regenerate the App-Level Token if stuck. |
| Connects but ignores events | Re-check OAuth scopes & Event Subscriptions, then reinstall the app. |
| Old bot name shown | App Home display name + `chat:write.customize` scope, then reinstall. |
| Empty agent list | `ls ~/.claude/agents/` — each `.md` needs valid frontmatter with `name:`. |
| Empty/error agent reply | `claude --print --model sonnet "hello"` — if that fails, re-auth the CLI. |
| 502 Bad Gateway | Router crashed — `docker compose logs router` (or `/tmp/winston-router.err.log`). |

---

## License

[MIT](LICENSE)
