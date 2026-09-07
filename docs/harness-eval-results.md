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
