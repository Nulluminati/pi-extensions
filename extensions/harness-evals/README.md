# Harness Evals Extension

Measures whether Pi (and this extension suite) actually completes coding tasks: a suite of reproducible tasks, each executed by a noninteractive Pi session in a fresh workspace and graded by deterministic shell checks. Results persist so harness or model changes can be compared over time — the evaluation loop that keeps harness work honest.

## The Built-In Task Suite

| Task | Probes |
|------|--------|
| `bugfix-regression` | Root-cause debugging; respect for existing tests (fix must not touch the test) |
| `multi-file-rename` | Cross-file consistency; finding every call site (partial renames fail) |
| `misleading-diagnosis` | Diagnosis depth; the failure message points at the wrong module (fixing the wrong one fails) |
| `implement-to-spec` | From-spec implementation with edge cases |
| `test-first-bugfix` | Test-writing discipline: the grader reverts the fix and verifies the new test actually catches the original bug |
| `refactor-split` | Structure change under test protection; import-graph consistency |
| `lru-cache-tdd` | From-spec implementation plus tests that must catch a known-broken eviction |
| `async-race` | Async control flow; deterministic correctness across repeated runs |
| `bug-chain` | Layered diagnosis; numeric correctness at rounding boundaries |
| `parallel-modules` | Decomposition and integration; delegation benefit when a delegate tool is available |

Checks are shell commands graded in the task workspace; several are adversarial (the "obvious" shortcut fails them by design).

## Usage

```text
evals (action=list)
evals (action=run, taskId="bugfix-regression", model="opencode-go/glm-5.3-flash")
evals (action=run, all=true, repeats=3)
evals (action=report)
```

| Command | Description |
|---------|-------------|
| `/evals` | List the built-in tasks |
| `/evals:run [taskId]` | Kick off a suite run in the session |
| `/evals:report` | Summarize stored results |

Noninteractive CLI (used for repo development and model comparisons):

```bash
npx tsx scripts/eval-run.ts --all --model opencode-go/glm-5.3-flash --repeats 3
npx tsx scripts/eval-run.ts --task misleading-diagnosis --model opencode-go/glm-5.3-flash
```

## How It Works

1. **Workspace**: each run materializes fixtures into a fresh temp directory with a git baseline.
2. **Session**: `pi --mode json --no-session --no-extensions -nc -p <prompt>` runs under the model under test. By default the other four suite extensions (missions, messenger, agents, autoresearch) are loaded so every run is also an integration test of the suite.
3. **Grading**: the task's check command runs against the workspace; pass requires the check to succeed. Token usage and duration are recorded from the session's JSON events.
4. **Storage**: results append to `<cwd>/.pi/evals/results.jsonl`; `action=report` aggregates pass rate, average duration, and average output tokens per task.

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_EVAL_MODEL` | Default model under test for the tool and `/evals:run` |
| `PI_EVAL_EXTENSIONS` | Set to `0` to run eval sessions without the suite extensions |

CLI-only: `--repeats`, `--timeout-ms`, `--no-extensions`, `--keep` (keep task workspaces for debugging).

Use repeats for anything you want to conclude from — single runs on stochastic agents are noise. Keep the check commands deterministic; a task whose grader can be gamed measures nothing.
