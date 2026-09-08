# Harness Eval Results — 2026-09-04

First effectiveness run of the `harness-evals` suite, end to end through the suite's own delegation stack.

## Setup

- Model under test: `opencode-go/glm-5.3-flash` (cheap worker model; per-goal instruction).
- Runner: `npx tsx scripts/eval-run.ts --all --model opencode-go/glm-5.3-flash --timeout-ms 900000` — two sweeps, 5 tasks per sweep, fresh temp workspace per task with a git baseline.
- Every eval session loaded the other four suite extensions (`missions`, `messenger`, `agents`, `autoresearch`) via `-e`, so each run doubles as an integration test of the suite.
- Checks are adversarial by design (see `extensions/harness-evals/src/tasks.ts`): the misleading-diagnosis check rejects fixing the wrong module, and the test-first check reverts the fix to verify the new regression test actually catches the original bug.

## Results — 10/10 passed

| Task | Sweep 1 | Sweep 2 | Sweep 1 time | Sweep 2 time |
|------|---------|---------|--------------|--------------|
| bugfix-regression | PASS | PASS | 27s | 16s |
| multi-file-rename | PASS | PASS | 41s | 29s |
| misleading-diagnosis | PASS | PASS | 49s | 15s |
| implement-to-spec | PASS | PASS | 54s | 32s |
| test-first-bugfix | PASS | PASS | 23s | 30s |

Raw records: `.pi/evals/results.jsonl` of the run directory (10 entries).

## Supporting live tests (same day, same model)

- **Integration smoke**: a live `pi --mode json` session with all five extensions created a mission, added a verification-carrying task, delegated the work to a worker (`delegate`, wait=true), verified it, and completed the mission. Mission JSON, worker registry entry (`status: completed` with report text), and messenger presence all persisted correctly.
- **Autoresearch loop**: a bounded live loop (`maxIterations 2`) measured a baseline of 10, discarded a no-op run, kept a halving edit at 5 — commit `autoresearch: ... (val=5)`, cap honored, `.auto/log.jsonl` durable across the loop.

## Interpretation

- The cheap glm worker completes all five designed task surfaces noninteractively with the suite loaded — delegation (`delegate` + worktrees + trusted wakes) and the extensions do not interfere with ordinary task work.
- Two agreeing sweeps beat one, but 2 repeats per task is still a small sample; use `--repeats 3+` before drawing conclusions from harness comparisons.
- Next comparisons worth running on this suite: glm flash vs the session default model (quality/cost), and `--no-extensions` vs default to quantify suite overhead.

## Known Limits

- Five tasks measure designed surfaces, not general competence. Grow the suite from real failures — each new failure mode becomes a task.
- All tasks are short-horizon (<1 minute of agent work). Long-horizon behavior (compaction, worker stalls, budget exhaustion) needs longer eval tasks.

---

# Advanced suite + ablation: suite ON vs OFF — 2026-09-04 (later)

Suite grew to **10 tasks** (added: `refactor-split`, `lru-cache-tdd`, `async-race`, `bug-chain`, `parallel-modules` — see `extensions/harness-evals/src/tasks.ts`). Ablation: two sweeps per configuration, model `opencode-go/glm-5.3-flash`, suite extensions (`missions`, `messenger`, `agents`, `autoresearch`) loaded (ON) vs `--no-extensions` (OFF). Raw data: `/tmp/eval-with` and `/tmp/eval-without` (20 runs each). Compare any two result sets with `scripts/eval-compare.py`.

## Result: completion identical, cost very different

- **Correctness: no difference.** 20/20 passed in both configurations. On this suite, glm flash is saturated — the extensions neither rescued a failing run nor broke a passing one.
- **Fixed context cost: ~2.4x input tokens.** 14.3k vs 6.0k average input tokens per run. Four extension tool definitions ride in every request, used or not.
- **Latency: extensions always cost, sometimes a lot:**

| Task (avg of 2) | ON | OFF | Delta |
|---|---|---|---|
| parallel-modules | 301s | 57s | **+244s** |
| bug-chain | 338s | 178s | **+160s** |
| test-first-bugfix | 72s | 29s | +43s |
| lru-cache-tdd | 142s | 128s | +14s |
| multi-file-rename | 44s | 36s | +8s |
| misleading-diagnosis | 31s | 27s | +4s |
| async-race | 33s | 28s | +4s |
| bugfix-regression | 30s | 27s | +3s |
| refactor-split | 38s | 35s | +3s |
| implement-to-spec | 62s | 61s | +1s |

## Where the cost came from (session evidence)

- **parallel-modules (5x slower ON):** with the `delegate` tool available, the model chose to spawn three workers, as the prompt invited. Worker startup + orchestration dominated: the three modules take ~15-20s each to write, but delegation turned a 1-minute task into a 5-minute one. Both ON runs still passed all checks — delegation was correct, just premature at this task size.
- **bug-chain (1.9x slower ON):** no delegation involved — with missions/autoresearch tools present, the model did more turns of structured status-keeping and verification narration (output tokens 8.5k/14.9k ON vs 3.5k/9k OFF).
- **test-first-bugfix (+43s ON):** the ON model wrote more elaborate tests and verification narration; same outcome, richer behavior, more tokens.
- Several simple tasks show **lower** output tokens ON (-136 to -466): structured tool outputs partially replace prose.

## Conclusions: where the extensions pay (and don't)

1. **Safety: clean.** No completion regressions anywhere; the delegation path produced correct, check-passing work in every run.
2. **Not free: budget ~8k extra input tokens per run and 1.2-2x latency on tasks the base model already handles**, before any orchestration choice.
3. **Delegation economics confirmed at small scale:** when subtask work (~20s) is smaller than spawn-plus-orchestration cost (~60-90s+), delegating is strictly worse. The payoff needs subtasks measured in minutes, not seconds — consistent with the coordination-cost literature (Co-Coder; the Nature MI capability-saturation threshold).
4. **The suite is saturated for glm flash.** Completion-rate benefits of missions/verification/delegation cannot show up on tasks the base model aces. Measuring those benefits needs tasks that fail OFF: longer horizons, drift, multi-session work, or a weaker model under test.
5. **Method win:** the ON/OFF ablation is now a one-command check (`scripts/eval-compare.py on.jsonl off.jsonl`), and `--no-extensions` exists precisely to isolate this cost.

## Recommended defaults going forward

- Keep the suite extensions loaded for interactive work that uses their capabilities: missions on multi-session efforts, delegation on minute-scale subtasks, autoresearch on optimization problems.
- Run cost-sensitive batch work (`pi -p`, evals, CI agents) with the suite off unless a task needs it.
- In prompts, invite delegation only when subtasks are genuinely minute-scale; the invitation alone was enough to trigger 5x overhead here.
