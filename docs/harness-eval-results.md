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

---

# Quality matrix: model x ways-of-working, blind-judged — 2026-09-04 (latest)

Four configurations x 10 tasks, one sweep each (n=1 per cell — indicative, not conclusive), every run blind-judged by a fixed third-family model (`opencode-go/deepseek-v4-pro`; judges never see which config produced the code). New harness capability: `--judge <model>` / `judge=true` / `PI_EVAL_JUDGE_MODEL`.

| Config | Coordinator | Suite | Workers |
|---|---|---|---|
| A | glm-5.3-flash | off | — |
| B | glm-5.3-flash | on | — |
| C | kimi-k3 | off | — |
| D | kimi-k3 | on | glm-5.3-flash (delegate) |

## Headline numbers (avg of 10 runs)

| Config | Pass | Judge overall | Avg time | Avg in tok | Avg out tok |
|---|---|---|---|---|---|
| A glm/off | 10/10 | 8.9 (9 judged) | 87s | 6.9k | 2.1k |
| B glm/on | 10/10 | 9.0 | 147s | 10.0k | 3.1k |
| C kimi/off | 10/10 | 8.9 (9 judged) | 57s | 7.5k | 1.4k |
| D kimi/on | 10/10 | 8.7 | 54s | 9.2k | 1.3k |

Per-axis averages: specAdherence 9.4-9.8 everywhere; codeQuality 8.7-8.9; robustness 8.0-8.5 (lowest axis everywhere).

## Findings

1. **The blind judge caught what the binary checks cannot.** D `bug-chain`: worker code passed every check but scored 5/10 — the judge cited concrete evidence that `roundMoney` used an unexplained `Number.EPSILON` hack passing the visible test while 10.075 -> 10.07 and negative ties round toward zero: overfit to the visible test. B solved the same task with a documented nudge and scored 8 with a calibrated robustness critique. This is exactly the "passes checks, low quality" cell the pass/fail suite was blind to.
2. **Correctness stayed saturated: 40/40 across all configs.** Binary pass/fail does not discriminate models or ways of working on this suite; the judge axis does.
3. **Speed: kimi is 1.5-1.7x faster than glm** on identical configs (57s vs 87s off; 54s vs 147s on).
4. **Suite-on cost is model-dependent:** it slowed glm +69% (147s vs 87s; bug-chain took 493s and 13.8k output tokens) but left kimi's average unchanged (54s vs 57s) — the stronger coordinator absorbs the extra tool surface without thrashing.
5. **Delegated work needs verification teeth.** The one low-quality run (5/10) came through the delegation path: a worker cut a corner, checks passed, only the judge flagged it. Practical rule: worker-produced changes should get judge-level (or human) review, not just check-level review.
6. **Judge coverage: 38/40 (95%).** Two runs produced no parseable verdict; a single retry on parse failure would close most of that gap.

## Where the ways of working pay

- **kimi solo (C)**: fastest path to passing, judge-quality equal to everything else. Best default for one-shot tasks.
- **glm + suite (B)**: small quality edge (9.0 avg, the only 10/10 single score on multi-file-rename) at 1.7x glm-off's time. Worth it when robustness matters more than latency.
- **kimi + suite + workers (D)**: fastest overall and correct, but produced the suite's first low-quality pass — use delegation for minute-scale subtasks and add judge/review on top of checks for worker output.
- **glm solo (A)**: no reason to prefer it: slower than kimi, no quality edge.

## Caveats

- n=1 per cell: treat deltas under ~0.5 quality points as noise. D's 5.0 is a real signal because the judge cited specific counterexamples, not a hunch.
- The judge is an LLM (deepseek-v4-pro); it may have family or style biases, mitigated partly by judging against files only, never against other solutions.
- Two missing verdicts (A `test-first-bugfix`, C `implement-to-spec`) reduce coverage; retry-on-parse-failure is the fix.
