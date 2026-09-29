# Autoresearch Extension

Karpathy-style autonomous experiment loop, generalized to any measurable target: try an idea, measure it, keep improvements (git commit), discard regressions (git revert), repeat. Works for test speed, build time, bundle size, benchmark scores — anything a shell command can measure.

## Usage

```text
autoresearch (action=init, objective="Reduce test runtime", metric="seconds", direction="lower",
              measure="node scripts/bench.js  # prints 'METRIC seconds=12.3'", checks="npm test")
```

The agent then loops: edit code → `action=run` → `action=log` with `status=keep` (commits) or `status=discard` (reverts). While the loop is active the extension re-prompts the agent after each turn, with runaway guards.

## How It Works

- **State in `.pi/autoresearch/`**: `config.json` (metric, commands, cap), `prompt.md` (objective and notes so a fresh session can resume), `log.jsonl` (append-only run record), `pending.json` (an in-flight measurement), `untracked-snapshot.json` (untracked files present at the experiment base; keeps never stage them and discards never remove them). `.pi/autoresearch/` is excluded from git locally during init so revert cycles can never destroy the experiment record.
- **Baseline first**: init requires a clean worktree (commit or stash first) and measures the untouched state; every later result is compared against it.
- **Correctness gate**: if `checks` is configured, it runs before measuring; a failure auto-reverts the changes and logs `checks_failed`.
- **Spread score**: after 3+ measured runs the tool reports `|best − baseline|` relative to observed run-to-run variation (1.4826 × MAD over baseline and kept runs). This is a descriptive number, not a confidence measure — every run comes from a different code revision, so the spread mixes treatment effects with variation. Below 1x the delta is small relative to the observed spread and the agent is told to re-measure before trusting it.
- **Runaway guards**: iteration cap (`maxIterations`) stops the loop; two consecutive prompts without a newly logged experiment stop the loop and hand control back.
- **Keeps are commits**: only the current experiment's changes are staged and committed with the metric in the message; discards restore only those changes. Work that predates the experiment is never consumed.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("autoresearch")` | init / run / log / status / stop |
| `pi.on("agent_end")` | Loop continuation with cap and stall guards |
| `pi.sendUserMessage(..., { deliverAs: "followUp" })` | Continue the loop |
| `pi.on("session_start")` | Resume loop state from `.pi/autoresearch/` |
| `pi.events.emit("autoresearch:state")` | Publish state for future consumers |
| `setStripWidget` (`lib/widget-strip.ts`) | Framed panel above the input at `WIDGET_PRIORITY_AUTORESEARCH` while a campaign is active: `it n[/max]` in the frame corner, best/spread and latest run lines |
| `ctx.ui.setStatus("autoresearch", …)` | Fallback footer line for pi's default footer (skipped by the bundled status bar, which shows the widget instead) |

State lives in `<cwd>/.pi/autoresearch/` (locally git-excluded; keep it out of remotes).

The state files are shared per project, but the orchestration UI is single-session: only the session that created the campaign shows the widget and footer status and drives the continuation loop. Other sessions see nothing (their turns are never hijacked into running someone else's experiment), and `status` is the only tool action they can use — `run`, `log`, and `stop` throw for non-owner sessions, so re-initialize to take ownership. Campaigns created before ownership stamping (no `ownerSessionId` in the config) remain visible in every session and accept actions from any session.

## Cost Control

Experiment loops burn tokens. Set `maxIterations` at init, and prefer provider-side budgets for unattended runs.
