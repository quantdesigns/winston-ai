# Winston — Quickstart Guide

**Local personal AI agent platform — runs on the Mac mini, reached via Slack and (optionally) Tailscale.**

---

## What is Winston?

Winston is a self-hosted AI agent platform that runs on a Mac mini. It binds to loopback only — Slack works via outbound Socket Mode, and the web UI is reached locally or over Tailscale. It consists of:

| Component | What it does |
|---|---|
| **Go Router** (`bin/winston`) | HTTP server (loopback), Slack Socket Mode loop, agent orchestration |
| **Next.js Frontend** | Dashboard at `http://localhost:57711` (or via the router's reverse proxy on `:57710`) |

---

## Architecture

```
Slack ── outbound websocket (Socket Mode) ──┐
                                            ▼
Browser ── http://localhost:57710 ────► Go Router :57710
                                            │
                              reverse proxy ▼
                                       Next.js :57711
                                            │
                                  claude CLI (agents/*.md)
```

The Mac mini has no public hostname and no open ports. All inbound paths terminate on `127.0.0.1`.

---

## Services

Three launchd agents run on the mini (auto-start on login):

| Label | Binary | Bind / Schedule |
|---|---|---|
| `com.winston.router` | `~/projects/winston/bin/winston` | `127.0.0.1:57710` |
| `com.winston.frontend` | `npm run start` (Next.js) | `127.0.0.1:57711` |
| `com.winston.sync-agents` | `~/projects/winston/scripts/sync-agents.sh` | Daily at **07:00 local** — pulls `agent-workbench`, symlinks new agents, restarts the router. |

---

## Checking Status

### Quick health check
```bash
curl http://localhost:57710/health
```

Returns: `{ "status": "ok", "uptime": "...", "agents": 12, "frontend": "ok" }`

### Check which services are running
```bash
launchctl list | grep winston
```

- **PID number** = running
- **`-`** with exit code = stopped/crashed

### View live logs
```bash
# Router logs (includes Slack Socket Mode chatter)
tail -f ~/Library/Logs/winston-router.out.log
tail -f ~/Library/Logs/winston-router.err.log

# Frontend logs
tail -f ~/Library/Logs/winston-frontend.out.log
```

---

## Restarting Services

### Restart the router (most common)
```bash
launchctl kickstart -k gui/$(id -u)/com.winston.router
```

### Restart the frontend
```bash
launchctl kickstart -k gui/$(id -u)/com.winston.frontend
```

### Restart all Winston services
```bash
launchctl kickstart -k gui/$(id -u)/com.winston.router
launchctl kickstart -k gui/$(id -u)/com.winston.frontend
```

### After a code change (rebuild + restart)
```bash
cd ~/projects/winston
go build -o bin/winston ./cmd/winston
launchctl kickstart -k gui/$(id -u)/com.winston.router
```

Or just `./scripts/restart.sh` to rebuild both and bounce everything.

---

## Stopping Services

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.winston.router.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.winston.frontend.plist
```

---

## Agents

Agents are `.md` files in `~/.claude/agents/`. The router scans that directory on start and exposes each agent as a Slack slash command (`/<name>`), a REST endpoint, a dashboard card, and a schedulable job.

### Where agent source actually lives

The Mac mini's `~/.claude/agents/` is mostly **symlinks** into the [`agent-workbench`](https://github.com/quantdesigns-engineer/agent-workbench) repo at `~/projects/agent-workbench`. That repo is the source of truth — it's where the work happens, and being a git repo it can be edited from any machine, including the GitHub web UI from a phone.

```
~/projects/agent-workbench/agents/
├── codephil/      ← codephil-* agents (jobs pipeline, YouTube production, etc.)
├── rivalytics/    ← rivalytics-* agents (social, marketing)
├── meta/          ← agents that produce other agents
└── _archive/      ← retired, not synced

~/.claude/agents/
├── rivalytics-social.md     → ../../projects/agent-workbench/agents/rivalytics/rivalytics-social.md
├── codephil-jobs-weekly.md  → ../../projects/agent-workbench/agents/codephil/codephil-jobs-weekly.md
└── …                        (one symlink per active agent)
```

Only `codephil/` and `rivalytics/` are auto-synced. `_archive/` and `meta/` are deliberately excluded.

### Authoring an agent from any machine

You do not need to be at the Mac mini to write a new agent. The git workflow is:

```bash
# 1. On any machine — laptop, second workstation, even github.com web editor
cd ~/projects/agent-workbench
git pull
$EDITOR agents/rivalytics/rivalytics-marketing-campaign.md   # frontmatter + system prompt
git add agents/rivalytics/rivalytics-marketing-campaign.md
git commit -m "agent(rivalytics): add marketing-campaign"
git push
```

What happens next depends on how fast you need the agent live on Winston:

| Path | Latency | What runs |
|---|---|---|
| **Wait for the daily sync** (default) | up to 24h | `com.winston.sync-agents` fires at **07:00 local time**, pulls `agent-workbench`, creates any missing symlinks, and bounces the router. |
| **Run the sync manually** | seconds | SSH/Tailscale into the Mac mini → `~/projects/winston/scripts/sync-agents.sh`. |
| **Ad-hoc (file you authored straight on the mini)** | seconds | `ln -s "$HOME/projects/agent-workbench/agents/rivalytics/<name>.md" ~/.claude/agents/<name>.md && launchctl kickstart -k gui/$(id -u)/com.winston.router` |

The sync script is idempotent and skips machines where `agent-workbench` has uncommitted changes — so you can always run it by hand without worrying about clobbering local work. Logs land at `~/Library/Logs/winston-sync-agents.log`.

### Reflecting agent changes (no new file, just edits)

Agents are read into memory **once at router startup** (`internal/agents/manager.go:149`). Any edit to a registered `.md` — frontmatter *or* system prompt — only takes effect after the router restarts:

```bash
launchctl kickstart -k gui/$(id -u)/com.winston.router
```

The daily sync handles this automatically when it detects pulled changes. For manual edits, run the kickstart yourself. (The exceptions are the dashboard's in-app "edit system prompt" and "change model" actions — those hit an API path that updates both the file and the in-memory struct, so no restart is needed.)

### Calling agents from Slack
```
/rivalytics-marketing analyze our latest campaign
/winston what's on my calendar today?
@Winston /codephil-jobs-weekly run the pipeline
```

Every agent registered in `~/.claude/agents/` needs a matching Slack slash command added in the Winston Slack app config — that's a one-time manual step per agent (Slack does not allow dynamic command registration).

---

## Slack Integration

The router connects to Slack via **Socket Mode** — an outbound websocket. No inbound webhook URL is needed. The router listens for three event types:

| Event | Purpose |
|---|---|
| Slash commands (`/marketing`, `/winston`, etc.) | Spawn an agent in a thread |
| App mentions (`@Winston`) and thread replies | Continue threaded conversations |
| Interactive components | Button clicks on bot messages |

### Troubleshooting Slack "something went wrong"
1. Check the router is running: `curl http://localhost:57710/health`
2. Check the Socket Mode connection is up: `grep '[slack/socket]' ~/Library/Logs/winston-router.err.log | tail`
3. If you see `connection error` or it's stuck on `connecting…`, the `SLACK_APP_TOKEN` (`xapp-…`) is missing or invalid — regenerate it in the Slack app's Basic Information page, update `.env`, and reinstall services.

---

## Configuration

All secrets live in `~/projects/winston/.env` (never committed to git):

```
PORT=57710
SLACK_BOT_TOKEN              # xoxb-... Slack bot token
SLACK_APP_TOKEN              # xapp-... App-Level token (connections:write) for Socket Mode
SLACK_SIGNING_SECRET         # Kept for the legacy HTTP /slack/* path
SLACK_NOTIFY_CHANNEL         # Channel for ops notifications
SLACK_OWNER_ID               # User ID for owner-targeted messages
ELEVENLABS_API_KEY           # Voice synthesis
```

The launchd plists at `~/Library/LaunchAgents/com.winston.router.plist` embed these directly (so the router has them without reading `.env`). Re-run `scripts/install-services.sh` after editing `.env` to regenerate the plists.

---

## Remote Access (Optional)

The router and frontend bind to `127.0.0.1` only. To reach the web UI from another device, use Tailscale Serve:

```bash
# On the Mac mini
tailscale serve --bg --https=443 http://127.0.0.1:57710
tailscale serve status
```

Open the printed `https://<machine>.<tailnet>.ts.net` URL from any device signed in to the same tailnet.

Slack does not need any of this — Socket Mode works regardless.

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Slack "something went wrong" | Router down or Socket Mode disconnected | `curl localhost:57710/health`, check router log for `[slack/socket]` |
| Agent returns "not registered" | Agent `.md` file missing or router not restarted | Check `~/.claude/agents/`, kickstart router |
| New agent pushed to `agent-workbench` not showing up | Daily sync hasn't fired yet, or `agent-workbench` has uncommitted local changes (sync skips pull) | `~/projects/winston/scripts/sync-agents.sh` and check `~/Library/Logs/winston-sync-agents.log` |
| Frontend unreachable | Next.js stopped | Kickstart frontend service |
| Slack bot connects but silent | Missing event subscriptions or OAuth scopes | Re-check the Slack app config |
| `tailscale serve` URL not reachable | Both devices need to be on the same tailnet with HTTPS enabled | `tailscale status` on each device |

---

*Winston is running on bare metal — no Docker, no VMs.*
