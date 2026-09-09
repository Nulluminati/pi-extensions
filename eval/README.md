# Terminal-Bench Evaluation

External-harness evaluation for pi and the extension suite, replacing the
retired homegrown `harness-evals` extension (retired 2026-09-04: its tasks
saturated — every configuration passed everything — so it produced no
discriminating signal; historical results live in
[`docs/harness-eval-results.md`](../docs/harness-eval-results.md)).

This uses the real benchmark: **Terminal-Bench 2.0** (89 tasks), run through
**Harbor** (the official harness) with **`badlogic/pi-terminal-bench`**, the pi
author's own agent adapter. Task verifiers are the benchmark's own — no
homegrown checks, no saturation.

## Setup (one-time, ~5 minutes)

```bash
eval/setup.sh
```

Requires: `uv`, Docker running, git. Installs Harbor, clones the pi adapter,
and applies the documented Harbor `upload_dir` fix (an upstream bug that
corrupts verifiers when the agent creates `/tests`).

## Run

```bash
# Curated 12-task subset, glm flash via OpenRouter (default)
eval/run.sh

# Specific tasks, more parallelism
eval/run.sh --tasks fix-git,regex-log,sqlite-db-truncate --jobs 4

# Strong-model comparison (billed per token)
eval/run.sh --model opencode/go/kimi-k3 2>/dev/null || \
eval/run.sh --model openrouter/~z-ai/glm-latest

# Oracle smoke test — verifies the pipeline with zero LLM cost
eval/run.sh --oracle --tasks fix-git
```

Environment: `OPENROUTER_API_KEY` (default model) or the key matching your
`--model` provider. The adapter forwards OPENROUTER/ANTHROPIC/OPENAI/GEMINI/
GROQ/XAI keys into the task container.

## What it costs

| Run shape | Token cost | Wall time (local Docker, -n 3) |
|---|---|---|
| 12-task subset, glm flash, 1 trial | ≈ $0 on high-usage limits (else cents) | ~30–90 min |
| 12-task subset, frontier model | ~$15–60 | similar |
| Full official run (89 tasks × 5 trials) | $766–$6,891 published receipts | hours, needs cloud (-n 32) |

Published per-run receipts put cached-input tokens at 92–98% of agent token
volume — agent loops replay context, so price the cache line first.

## Results

Each run writes `results/<timestamp>/` (Harbor trial format: per-task results,
agent logs incl. `pi-output.jsonl` with full JSONL trajectories and per-message
token/cost usage). Resolve rate = solved tasks / attempted.

Keep configurations comparable: change one thing at a time (model, extensions,
trials), disclose the agent + model + flags with any number you report — the
benchmark's own leaderboard shows a 5.2-point swing on an identical model
between two harnesses.

## Relationship to the extension suite

The pi sessions Harbor launches are **plain pi** — the container gets a fresh
npm install, so `missions`/`messenger`/`agents`/`autoresearch` are not loaded.
Evaluating the extension suite *on* Terminal-Bench requires baking the
extensions into the adapter's container install (follow-up work; tracked in the
branch notes). Until then, this harness measures pi itself, not the extensions.

## Baseline results — 2026-09-09

Curated 12-task subset, pi (npm latest) + `openrouter/~z-ai/glm-flash-latest`,
1 trial, `-n 3`, wall **24.5 min**, total LLM cost **$0.45** (336k in / 44k out /
314k cached — cache is 45% of the bill even at flash pricing).

| Task | Reward | Time notes |
|---|---|---|
| break-filter-js-from-html | 1 | |
| cancel-async-tasks | 1 | |
| fix-git | 1 | |
| git-multibranch | 1 | |
| openssl-selfsigned-cert | 1 | |
| sqlite-db-truncate | 1 | |
| chess-best-move | 0 | agent timeout |
| circuit-fibsqrt | 0 | |
| configure-git-webserver | 0 | |
| count-dataset-tokens | 0 | |
| filter-js-from-html | 0 | priciest run ($0.16; 113k in) |
| regex-log | 0 | |

**Resolve rate 50%** — real discrimination at last (the retired homegrown
suite scored 100% on every configuration). A bonus partial run of the full
89-task set went 7/17 (41%) on non-subset tasks before being stopped.

Notes for next runs:
- 6/12 is small-n; rerun with `--trials 3` before drawing conclusions.
- The one `AgentTimeoutError` (chess-best-move) suggests a per-task timeout
  bump (`--timeout-multiplier`) for reasoning-heavy tasks.
- Comparisons to run next: kimi-k3 coordinator, and suite-extensions-in-container
  (needs baking extensions into the adapter image; tracked as follow-up).
