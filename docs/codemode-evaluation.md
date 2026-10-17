# Codemode evaluation

## Summary and recommendation

Use **`only` for `openai-codex/gpt-6.1-sol`** on these repository tasks. Keep codemode **off for `opencode-go/glm-5.3`**.
For `opencode-go/deepseek-v4.1-flash`, keep **`off` as the default**. `on` is a reasonable option; forcing `only` is not worthwhile.

Every scored arm passed 24/24 cases. Codemode did not improve success rates in this task set.
Compared with `off`, Codex `only` used 40% fewer median tokens, cost 15% less per median run, and took 15% less time.
GLM `only` cost 51% more per median run and took 96% longer. Its `on` arm also cost more and ran slower.

These are small, task-specific results, not proof about long coding sessions. Cost figures are Pi estimates, not subscription charges.
The scored tasks mainly exercised built-in file and shell tools. Structured extension data had a separate live contract check.
No user settings changed during this evaluation.

If you accept the Codex recommendation, add these fields to `~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "only" }
}
```

That setting applies across models. Keep codemode off when you select GLM:

```sh
pi --model opencode-go/glm-5.3 --tools -codemode
```

## Method

The initial measurements used Pi 1.3.0 on 2026-10-16. The brief names 1.2.0; this evaluation used the installed version without a downgrade.
The fixed tool baseline is commit `6ddf3dd4d84d625c606db09b383b2b652d7f91cb`.

The initial comparison has eight tasks, three arms, two models, and three repetitions: 144 cases.
The DeepSeek follow-up adds 72 cases with the same tasks, modes, and repetitions.
Codex means `openai-codex/gpt-6.1-sol`; GLM means `opencode-go/glm-5.3`.

| Arm | Tool selection | Codemode mode |
| --- | --- | --- |
| `off` | Inherited tools minus codemode | Inactive |
| `on` | Inherited tools plus codemode | `on`: direct tools remain declared |
| `only` | Inherited tools plus codemode | `only`: scripts reach callable tools; model-only tools remain direct |

The runner loads the normal installed packages and resource settings.
A private temporary agent directory replaces this repository's normal package path with the pinned worktree.
It copies credential files into that directory. This prevents the other checkout from supplying tools without these fixes.
The runner checks the original settings file's hash before and after each batch. Every batch reported unchanged settings.

Each case starts in a reset temporary git worktree. The runner removes ignored messenger state so reservations cannot survive between sessions.
It restores the dependency symlink after cleanup. The edit checker permits only that link, after it verifies its target.
Only the `only` arm receives temporary project settings with `codemode.mode: "only"`.
No project settings file enters the repository.

All arms use `--mode json --no-session --approve`.
The approval flag lets Pi read temporary project settings without a user dialog.
Runs are sequential. Arm order rotates across repetitions so each arm goes first once.
No repository-wide test runs competed with the measured batches.

Wall time covers the Pi child process, including startup. It excludes resets and independent answer checks.
The parser splits records only on line feed. It counts completed-message usage, not streaming updates or duplicate end-of-run messages.
Nested model usage already belongs to the parent result; the parser counts it once.
Token totals include input, output, cache reads, and cache writes.
Cost means Pi's token-price estimate, not a verified invoice charge. Cache hits affect cost substantially.

Answers use JavaScript Object Notation (JSON) and end with `CODEMODE_RESULT=<JSON>`.
Checks ignore object-key and set order, but reject missing entries and duplicates.
A task timeout counts as a failure. Infrastructure errors stop the batch.

| Task | Automatic check |
| --- | --- |
| `inventory` | Exact extension-to-tool mapping, including conditional tools and sandbox overrides. |
| `counts` | Exact literal `pi.registerTool(` counts; a loop counts once. |
| `imports` | Exact set of extensions that import `lib/errors.ts`. |
| `tests` | Report 33 passed todos tests; tool events must show a Vitest command. |
| `failure` | Report the injected test name and `expected 7, received 6`. |
| `rename` | Replace every tracked TypeScript occurrence of `isNodeError` with `hasNodeErrorCode`; exact patch and independent typecheck. |
| `facts` | Report the default factory function name from each of 14 entrypoints. |
| `ui` | Exact counts of literal `ctx.ui.` occurrences per extension, including comments. |

### Run accounting and corrections

The initial 144-case batch produced 126 valid non-rename results.
Its edit checker wrongly rejected the runner's own untracked dependency symlink. All 18 rename scores from that batch are invalid.

The first rename rerun stopped after 12 cases. An earlier session's ignored reservations blocked an edit.
We discarded that entire partial batch, including its passes. The runner now clears messenger state before every case.
Regression tests cover both reset defects, unrelated untracked files, and a mismatched dependency-link target.

The final isolated rename batch passed 18/18 cases. The scored matrix combines those 18 cases with the original 126 non-rename cases.
Those retained cases made no messenger, mission, worker, or autoresearch calls.
No individual result was selected for a favorable score. Rename measurements came from a later batch, so cache and service conditions can differ.

The initial evaluation recorded 174 matrix attempts, of which 144 enter its comparison. Their estimated cost totaled $5.01622; the scored cases totaled $3.88078.
Three smoke cases and one live tool-contract check are separate from those totals.
The smoke checker initially omitted `web-search`; its corrected reference table scores all three answers as passes.
Original events and scores remain unchanged beside the smoke rescore.

Raw data stays under the gitignored `.pi/codemode-eval/` directory:

| Data | Directory |
| --- | --- |
| Initial matrix | `2026-10-16T21-33-42-813Z` |
| Discarded partial rename batch | `2026-10-16T22-21-11-554Z` |
| Final rename replacement | `2026-10-16T22-27-48-671Z` |
| Combined scored results and tables | `combined` |

### Reproduce

1. Run the smoke test:

   ```sh
   node --import tsx scripts/evaluate-codemode.ts --tasks inventory --models openai-codex/gpt-6.1-sol --runs 1
   ```

2. Run the full matrix:

   ```sh
   node --import tsx scripts/evaluate-codemode.ts
   ```

Use `--tasks`, `--arms`, `--models`, and `--runs` for partial runs.
Use `--commit` to select another baseline explicitly. The default remains the fixed tool baseline above.

## Results

Each row contains 24 scored cases. All numeric columns after Pass are medians.
A fractional call count is the midpoint of two central observations.
Nested-call counts come from Pi's bounded records; one Codex `on` trace reached the 256-call limit.

| Model | Arm | Pass | Tokens | Estimated cost | Seconds | Top-level calls | Nested calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | off | 24/24 | 30,236.5 | $0.02485 | 11.97 | 2.5 | 0 |
| Codex | on | 24/24 | 26,709 | $0.02537 | 11.13 | 1.5 | 0 |
| Codex | only | 24/24 | 18,185 | $0.02117 | 10.21 | 1 | 1 |
| GLM | off | 24/24 | 23,998 | $0.01283 | 11.66 | 1 | 0 |
| GLM | on | 24/24 | 38,790 | $0.02163 | 16.63 | 2 | 0 |
| GLM | only | 24/24 | 31,430 | $0.01943 | 22.85 | 2 | 2.5 |

Across all 24 cases, Codex `only` reduced total estimated cost by 14% and total wall time by 19%.
Codex `on` increased total cost by 2% and total wall time by 17%, despite its lower median time.
GLM `only` increased total cost by 7% and total wall time by 33%. Its median penalties were larger because task costs vary.

### Per task

Each cell shows median seconds / estimated cost across three successful cases.
All task/model/arm groups passed 3/3.

| Model | Task | off | on | only |
| --- | --- | --- | --- | --- |
| Codex | inventory | 15.42 / $0.04010 | 16.55 / $0.04127 | 12.24 / $0.03620 |
| Codex | counts | 11.72 / $0.02246 | 9.94 / $0.02446 | 9.61 / $0.02116 |
| Codex | imports | 9.44 / $0.02139 | 8.54 / $0.02333 | 8.35 / $0.02059 |
| Codex | tests | 11.12 / $0.02295 | 11.02 / $0.02515 | 9.30 / $0.01944 |
| Codex | failure | 12.32 / $0.02544 | 12.92 / $0.02749 | 8.81 / $0.02020 |
| Codex | rename | 20.13 / $0.03466 | 41.51 / $0.03975 | 15.09 / $0.02655 |
| Codex | facts | 14.10 / $0.03118 | 10.60 / $0.02561 | 10.77 / $0.02299 |
| Codex | ui | 10.35 / $0.02340 | 10.59 / $0.02536 | 10.44 / $0.02205 |
| GLM | inventory | 48.72 / $0.07615 | 35.02 / $0.06101 | 30.51 / $0.07242 |
| GLM | counts | 10.88 / $0.01240 | 13.70 / $0.01429 | 19.93 / $0.01980 |
| GLM | imports | 8.87 / $0.00720 | 7.67 / $0.01144 | 8.53 / $0.01057 |
| GLM | tests | 7.41 / $0.00633 | 8.14 / $0.02066 | 27.20 / $0.00599 |
| GLM | failure | 24.96 / $0.03258 | 15.48 / $0.02160 | 23.65 / $0.00648 |
| GLM | rename | 15.93 / $0.02923 | 15.44 / $0.02904 | 22.05 / $0.03140 |
| GLM | facts | 7.95 / $0.00937 | 30.79 / $0.01768 | 31.64 / $0.02318 |
| GLM | ui | 13.06 / $0.01641 | 26.18 / $0.03640 | 15.12 / $0.02283 |

## Observations

Codex used scripts in 9/24 `on` cases and all 24 `only` cases.
Its `only` arm had no script failures. Most tasks needed one top-level call.
One `on` rename script read at least 238 files and edited 17; its nested record filled Pi's 256-call limit.
That run illustrates why fewer model round trips do not guarantee less work or shorter wall time.

GLM used scripts in only 3/24 `on` cases. Its extra declarations therefore often added context without changing its tool strategy.
The `only` arm used 73 scripts, compared with Codex's 31.
One GLM source-count case had two script failures: `ReferenceError: d is not defined` and an invalid template expression.
GLM recovered and passed that case. It could use scripts, but they did not provide a consistent cost or latency benefit.
Its inventory task improved with codemode; several simpler tasks became slower.

A separate live script received a structured `web_search` result with an array, result count, and first URL.
Access to `tools.spawn_worker` then failed with `TypeError: tools.spawn_worker does not exist`. No worker started.
This expected failure confirmed the live boundary as well as the real-loader tests.

The local declarations already contained `ToolDefinition.outputSchema` and `AgentToolResult.structuredContent`.
No declaration change was necessary. The type comparison script checks extension context interfaces, not tool definitions or results.
The audit also includes `jev`, which already returned schema-backed results but was absent from the brief's list.

## DeepSeek V4.1 Flash follow-up

The follow-up used `opencode-go/deepseek-v4.1-flash` on 2026-10-17, through OpenCode Go.
Pi remained 1.3.0. The tool baseline and user settings snapshot matched the initial evaluation.
No harness changes were necessary. Each case used the corrected reset and checker logic.

Eight tasks × three modes × three repetitions produced 72 cases, with 24 per mode.
All 72 passed. Every rename case passed the exact-patch check and independent typecheck.
No replacement runs were necessary, and user settings remained unchanged.

The report now covers 216 valid cases from 246 matrix attempts.
The follow-up's estimated cost totaled $0.141779. Its raw data is in `.pi/codemode-eval/2026-10-17T07-27-22-896Z/`.
The earlier Codex and GLM numbers remain unchanged. Compare models cautiously because their measurements came from different batches.

### Recommendation

Keep `off` as the default for DeepSeek. Use `on` if you want scripts available, but do not force `only`.

`on` lowered median estimated cost by 8%, but median time increased by 9% and median tokens increased by 6%.
Across the whole batch, it lowered total cost by 18% and total time by 13%.
Most of that time reduction came from the inventory task, where the `on` arm made no script calls.
This does not show a consistent benefit from script execution in ordinary tasks.

`only` reduced median tokens by 5%, but median cost rose 21% and median time rose 15%.
Its total cost fell 22%, while total time stayed almost unchanged.
The lower total cost does not mean each task became cheaper; expensive inventory cases strongly affect the total.

With three repetitions per task, the evidence does not justify replacing direct tools by default.
If your work resembles these inventory-heavy batches, `on` is a reasonable alternative to `off`.
For normal sessions, this command enables `on` when no settings override selects `only`:

```sh
pi --model opencode-go/deepseek-v4.1-flash --tools +codemode
```

The earlier Codex settings example selects `only` globally. This command does not override that mode setting.
There is no built-in per-model codemode setting in Pi 1.3.0.

### Results

All numeric columns after Pass are medians. Costs use six decimal places because this model's estimates are small.

| Arm | Pass | Tokens | Estimated cost | Seconds | Top-level calls | Nested calls |
| --- | --- | --- | --- | --- | --- | --- |
| off | 24/24 | 50,530.5 | $0.000949 | 10.01 | 3 | 0 |
| on | 24/24 | 53,622.5 | $0.000876 | 10.95 | 3 | 0 |
| only | 24/24 | 48,173.5 | $0.001145 | 11.49 | 3 | 4.5 |

Each task cell shows median seconds / estimated cost. Every task/mode group passed 3/3.

| Task | off: seconds / cost | on: seconds / cost | only: seconds / cost |
| --- | --- | --- | --- |
| inventory | 67.48 / $0.010126 | 57.21 / $0.007108 | 56.45 / $0.006177 |
| counts | 16.89 / $0.002005 | 13.21 / $0.000836 | 12.28 / $0.001289 |
| imports | 9.60 / $0.000691 | 9.54 / $0.000743 | 10.88 / $0.001677 |
| tests | 6.84 / $0.000237 | 6.11 / $0.000212 | 6.33 / $0.000217 |
| failure | 6.18 / $0.000271 | 5.90 / $0.000284 | 7.42 / $0.000421 |
| rename | 16.57 / $0.001638 | 17.70 / $0.001617 | 24.83 / $0.001975 |
| facts | 6.35 / $0.000493 | 6.48 / $0.000479 | 8.24 / $0.000522 |
| ui | 10.29 / $0.000954 | 10.84 / $0.000962 | 24.26 / $0.003180 |

### Script behavior

DeepSeek chose scripts in only 3/24 `on` cases, with six script calls in total. None failed.
The `only` arm used 86 script calls across 24 cases.
One inventory script failed with `SyntaxError: unexpected end of string`. DeepSeek recovered and passed the case.
All nested-call records were complete. No case timed out, and captured process stderr was empty.

To reproduce this follow-up without changing the original two-model default:

```sh
node --import tsx scripts/evaluate-codemode.ts --models opencode-go/deepseek-v4.1-flash
```

## Tool audit

`direct` is the default when a definition omits `exposure`.
Current exposure records the start of the audit. Chosen exposure and output schema describe the fixed baseline.
Data tools retain their model-facing text. Data-bearing failures set `isError: true` and retain structured results.

| Tool | Current exposure | Chosen exposure | outputSchema | Reason |
| --- | --- | --- | --- | --- |
| `context7_resolve_library_id` | direct | direct | yes | Scripts can filter library candidates. |
| `context7_get_library_docs` | direct | direct | yes | Ambiguous library lookups return candidate lists. |
| `context7_get_cached_doc_raw` | direct | direct | yes | Cache lookups return candidates; raw windows need pagination metadata. |
| `web_search` | direct | direct | yes | Scripts can filter search results. |
| `web_fetch` | direct | direct | no | Returns page text without user interaction or agent orchestration. |
| `ask_user` | model-only | model-only | no | Requires a user decision. Keep its existing restriction. |
| `background` | direct | direct | no | Starts a shell command, not an agent. |
| `monitor` | direct | direct | no | Starts a condition check, not an agent. Existing wake handling stays unchanged. |
| `jobs` | direct | direct | yes | Returns job data; cancellation affects commands, not agents. |
| `todo` | direct | direct | yes | Supports bounded list updates without control of agent execution. |
| `code_search` | direct | direct | yes | Scripts can filter file matches. |
| `autoresearch` | direct | model-only | no | Owns the experiment loop, commits, resets, and automatic continuation. |
| `messenger` | direct | model-only | no | Owns agent identity, communication, and file reservations. |
| `mission` | direct | model-only | no | Owns the session's objective, task graph, and verification workflow. |
| `report_blocker` (worker-blocker) | direct | model-only | no | The worker model owns the decision to report a blocker to its parent. |
| `read` (worker-sandbox) | inherited direct | unchanged | inherited yes | Preserve the built-in definition and sandbox boundary. |
| `bash` (worker-sandbox) | inherited direct | unchanged | inherited yes | Preserve the built-in definition and sandbox boundary. |
| `write` (worker-sandbox) | inherited direct | unchanged | inherited no | Preserve the built-in definition and sandbox boundary. |
| `edit` (worker-sandbox) | inherited direct | unchanged | inherited no | Preserve the built-in definition and sandbox boundary. |
| `grep` (worker-sandbox) | inherited direct | unchanged | inherited no | Preserve the built-in definition and sandbox boundary. |
| `find` (worker-sandbox) | inherited direct | unchanged | inherited no | Preserve the built-in definition and sandbox boundary. |
| `ls` (worker-sandbox) | inherited direct | unchanged | inherited no | Preserve the built-in definition and sandbox boundary. |
| `spawn_worker` | direct | model-only | no | Starts an agent and owns its lifecycle. |
| `workers` | direct | model-only | no | Cancels agents, collects patches, and removes worker worktrees. |
| `generate_image` | direct | direct | no | Generates and saves an image without a dialog or agent orchestration. |
| `jev` | direct | direct | yes (existing) | Typed judgments already have a schema and structured results. |
