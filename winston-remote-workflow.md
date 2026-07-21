# Winston — Remote Workflow

## URLs

| What | URL |
|---|---|
| Winston UI | `https://pgs-mac-mini-2.tail33f2a4.ts.net:8443` |
| Schedules page | `https://pgs-mac-mini-2.tail33f2a4.ts.net:8443/schedules` |
| SSH (over Tailscale) | `ssh pgs-mac-mini-2.tail33f2a4.ts.net` |

All URLs are tailnet-only — must be on Tailscale to reach.

## Where to edit

| Want to change… | Edit | Then |
|---|---|---|
| An agent prompt (e.g. `rivalytics-marketing`) | `~/projects/agent-workbench/agents/rivalytics/rivalytics-marketing.md` | Commit + push, or kick the sync (below) |
| The Go router / scheduler / Slack handler | `~/projects/winston/internal/...` | Rebuild + restart router (below) |
| A schedule (cron, prompt, channel) | Winston UI → Schedules page | Saves immediately |

`~/.claude/agents/*.md` are **symlinks** into `agent-workbench` — don't edit them directly.

## Agent edits → live in three ways

**A. Git (recommended).** Edit anywhere, commit + push to `agent-workbench`. Picked up automatically at the **07:00** daily sync. To deploy sooner:
```bash
launchctl kickstart gui/$(id -u)/com.winston.sync-agents
```

**B. SSH-and-edit.** Edit the file on the Mac mini directly, then restart the router:
```bash
ssh pgs-mac-mini-2.tail33f2a4.ts.net
vim ~/projects/agent-workbench/agents/rivalytics/rivalytics-marketing.md
launchctl kickstart -k gui/$(id -u)/com.winston.router
```

**Gotcha:** the sync script skips the pull if the workbench has uncommitted changes. Check with `cd ~/projects/agent-workbench && git status --short`.

## Go code edits

```bash
ssh pgs-mac-mini-2.tail33f2a4.ts.net
cd ~/projects/winston
go build -o bin/winston ./cmd/winston
launchctl kickstart -k gui/$(id -u)/com.winston.router
```

## Iterating on a scheduled agent without waiting

Use the Schedules page (run button), or from the tailnet:
```bash
curl -X POST https://pgs-mac-mini-2.tail33f2a4.ts.net:8443/api/schedules/sched_22/run
```

`sched_22` = `rivalytics-marketing` (fires daily 17:05 America/Denver, posts to `#rivalytics`).

## Reply-in-thread

When a scheduled run posts its `:alarm_clock:` trigger in Slack, **reply in that thread** to continue the conversation. Winston's scheduler keys the session to the trigger's `thread_ts`; replies elsewhere will get "No active session for this thread."

## Logs

```bash
tail -f ~/Library/Logs/winston-router.out.log
tail -f ~/Library/Logs/winston-sync-agents.log
```
