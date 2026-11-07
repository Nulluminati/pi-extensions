# Virtual-model evaluation

## Status

The pilot is complete: 48 unique cases, 46 passes, and two retained contract failures.
Saved defaults remain unchanged. The [committed evidence](virtual-models-pilot.json) contains every case, token category, routing choice, and paired difference.

Keep fixed Sol for main sessions. Rules used 6.79% more tokens; Jev used 13.56% more. All three passed six tasks.

Keep the saved GLM worker default pending review. Rules passed six tasks instead of five, but used 10.03% more worker tokens.
The extra pass concerns an exact text-rename requirement. This result alone does not establish broader code quality.
Rule routing remains an opt-in candidate if that trade-off is acceptable. No numerical acceptance threshold was agreed.

Do not adopt Jev routing from this pilot. It chose the same models as rules for all 12 task-role pairs.
Its main total was higher. Its worker token lower bound also exceeds the rule total.

This report follows herdboard card `teop` and its agreed eight-step plan.
The initial repository commit is `9d014872a60068c50cb2e39c8d761561ac3af1f4`.
The installed Pi version is `1.3.0`.

## What virtual models do

A virtual model is a selectable router. It returns a physical model and thinking level before each request.
Pi retains the virtual selection in model-change entries. Each assistant message identifies the physical model that answered.
Pi's built-in footer exposes physical dispatch. The custom status-bar footer does not; `/model` still exposes it.
Providers receive only physical models.

A router can choose by task evidence or explicit role. It can also preserve one physical model throughout a task.
This supports separate policies for main sessions and bounded workers without changing their saved defaults.
Routing alone does not establish lower token usage or higher task success.

Pi calls the router at four request boundaries:

| Reason | Meaning | Pilot requirement |
| --- | --- | --- |
| `user` | A user prompt, steering message, or follow-up starts a request | Choose from bounded task evidence |
| `continuation` | A tool result or extension message continues the task | Retain the physical model |
| `retry` | Pi retries a failed request | Retain the failed physical model; pause exhausted subscriptions |
| `direct` | A request outside the agent loop, including a compaction summary | Make a recorded choice without session-state assumptions |

Pi clamps the returned thinking level to the physical model's supported levels.
Switches can lose prompt caches. They can also change context limits and trigger compaction before dispatch.
Pi retains the chosen route if compaction becomes necessary.

Pi stores router state through its virtual-model Application Programming Interface (API).
That state follows the session branch and survives compaction. Direct requests have no router state, and Pi ignores state returned for them.
Workers use `--no-session`; their traces cannot prove persistent session restoration or branch behavior.

The upstream `jev-router.ts` example switches permanently after the first successful file edit.
That policy differs from this pilot's task-boundary selection. This pilot does not copy that switch.

## Verified model baseline

The installed authenticated catalog lists these exact IDs:

| Role | Model | API | Context limit | Maximum output |
| --- | --- | --- | --- | --- |
| Physical pool | `openai-codex/gpt-6.1-sol` | `openai-codex-responses` | 500,000 | 128,000 |
| Physical pool | `opencode-go/deepseek-v4.1-flash` | `openai-completions` | 1,000,000 | 384,000 |
| Physical pool | `zai/glm-5.3-flash` | `openai-completions` | 1,000,000 | 131,072 |
| Classifier | `typesafe/jev-latest` | `typesafe-system-one` | 64,000 | Not listed |

Catalog authentication does not prove remaining subscription capacity or successful inference.
No classifier request was necessary to inspect availability.

Zero Cool confirmed `zai/glm-5.3-flash` for both the router pool and fixed GLM comparisons.
The earlier codemode evaluation used `opencode-go/glm-5.3`. That is not the confirmed Flash baseline.

Saved main configuration selects Sol with thinking level `medium`.
Saved worker configuration selects `zai/glm-5.3-flash` with thinking level `high`.
The pilot retained these requested levels. Paid traces show main DeepSeek and GLM requests clamped to `high`; Sol retained `medium`.
All worker dispatches used `high`.

Sol maps `minimal` to `low` and supports `low`, `medium`, `high`, `xhigh`, and `max`.
DeepSeek and GLM support `low`, `high`, and `max`; their catalog maps mark the other levels unsupported.
Runtime tests and paid traces verify clamping. These comparisons do not hold physical reasoning effort equal across models.

The saved settings contain no explicit `defaultTools` or `codemode` override.
All comparison arms used identical effective tool exposure and codemode configuration.
The earlier codemode recommendations remain outside this investigation.

## Worker loading

Workers start with `--no-extensions` and explicit `-e` entrypoints.
`PI_WORKER_MODEL` overrides the saved worker selection. `PI_WORKER_MODEL_THINKING` sets its requested thinking level.
`PI_WORKER_EXTENSIONS_CONFIG` can select a temporary extension-list file.
An explicit tool parameter or `PI_WORKER_EXTENSIONS` takes precedence over that file.

The temporary list must retain the usual provider extensions and add the experimental router.
The resolver always includes messenger, worker-blocker, approval-mode, and worker-sandbox.
It loads worker-sandbox last. It rejects workers, missions, and autoresearch.
Do not change the saved allowlist or weaken these boundaries for the pilot.

An initial read-only audit worker could not read repository files.
It reported a missing `cross-spawn` package. That diagnosis was wrong: both checkouts contain the package.
Real sandbox-tool tests showed that the broker permits the Pi package but hides its separately installed dependencies.
The error also occurred in the assigned worktree before the authorized dependency-root fix.

Zero Cool authorized a narrow prerequisite fix to the agreed plan.
The broker now resolves installed runtime package dependencies and grants their exact directories read-only access.
It does not grant the enclosing `node_modules` directory. Project restrictions, credential restrictions, approvals, and nested-delegation restrictions remain in force.
Tests require a permitted workspace read to succeed and a private file outside the workspace to remain blocked.
The other checkout and saved settings remain unchanged.

The audit attempt is investigation overhead, not a scored pilot case.
One early offline integration test inherited TypeSafe credentials and made an unintended, unscored classifier request.
Test cleanup removed its usage trace. Its consumed tokens are unknown, not zero, and cannot enter completed-case comparisons.
The offline tests now clear that credential variable explicitly.

## Reproduce the baseline

Run this command from the repository root:

```sh
node --import tsx scripts/virtual-models-eval/baseline.ts
```

The command checks authenticated catalog availability without inference requests.
It writes a private, gitignored `baseline.json` under `.pi/virtual-models-eval/<timestamp>/`.
It records configuration hashes before and after catalog inspection. It does not copy credentials or endpoint configuration.
A missing pilot model or changed configuration produces a nonzero exit status.

The initial capture is `.pi/virtual-models-eval/2026-10-20T05-53-16-296Z/baseline.json`.
It reports all four pilot models available and unchanged configuration. Node.js is `v26.9.0`.
The capture records saved tool overrides, not a session's effective tool inventory.
The live runner captured actual tool names and exposure before comparisons.

Source references are the installed Pi `docs/virtual-models.md`, `docs/extensions.md`, and `examples/extensions/jev-router.ts`.
The worker-loading findings come from this repository's `lib/worker-model.ts` and `extensions/workers/src/worker-extensions.ts`.

## Frozen pilot design

Fixture version is `teop-fixtures-v1`. Policy version is `teop-policy-v1`.
Disposable task worktrees start from commit `cc936d4`, before controller checking rules entered the repository.
Runner v2 commits setup data only in disposable worker trees when isolation requires a clean source snapshot.
The router receives request text and role, not fixture IDs, difficulty labels, or expected answers.

| Task | Main-session work | Bounded worker work | Independent check |
| --- | --- | --- | --- |
| `boundaries` | Delegate once to fixed GLM, then verify repository resolution and launch facts | Inspect model and extension resolution through launch | Exact mandatory names, forbidden names, precedence, and sandbox order |
| `diagnosis` | Execute and diagnose an injected test failure | Same bounded diagnosis | Exact test name and string mismatch, plus execution evidence |
| `fix` | Repair an injected arrow-matcher bug and add a regression test | Same tested fix in an isolated worker worktree | Golden implementation, permitted changes, and independently executed focused tests |
| `rename` | Rename one identifier across tracked TypeScript files | Same rename in an isolated worker worktree | Exact byte-preserving replacement and independent typecheck |
| `review` | Review a proposed worker-safety patch without edits | Same bounded review | Exact safety-violation set and unchanged tracked sources |
| `schedule` | Find an optimal dependency and memory-constrained schedule | Same bounded scheduling problem | Feasibility checks and an independent exhaustive optimum solver |

The scored plan has 30 main cases and 18 worker cases, with one repetition.
Main arms are fixed Sol, fixed DeepSeek, fixed GLM, rules, and Jev. Delegated workers stay fixed at GLM.
Worker arms are fixed GLM, rules, and Jev. Their parent stays fixed at Sol and receives the same assignment text.
Worker scores use the worker's own answer, not a parent repair. Parent task-tool use invalidates that worker comparison.
The runner preserves worker isolation for edits and collects their patches through the normal worker tools.

All arms use direct tools with codemode inactive. This holds one configuration constant; it does not apply the earlier codemode recommendations.
The temporary worker list retains normal provider and research extensions plus mandatory safety extensions.
The runner records actual tool names and exposure, selected identities, and physical dispatches.
Final inspection found one identical tool-inventory signature per task and role across all arms: 12 groups, with no drift.

## Accounting and resume design

The runner writes a manifest before inference. Every attempt receives a separate checkpoint before process launch.
It retains raw main events, worker events, routing decisions, checking evidence, process identity, and configuration hashes.
Completed cases do not run again, including completed task failures.
Quota exhaustion or interruption preserves the attempt. Resume creates a separate attempt with explicit provenance.
The runner refuses changed experiment code or original configuration.

Token aggregate means `input + output + cacheRead + cacheWrite`.
Totals supplied by Pi remain separate. Literal provider usage fields, including `total_tokens` when available, remain in `provider_usage` trace records.
Pi can calculate its normalized total when a provider omits one. Missing literal provider totals remain unknown.
Missing usage stays unknown and makes the affected aggregate unknown.
Input already excludes cache reads in Pi's normalized usage. Raw OpenAI prompt totals require cache-read subtraction; raw Anthropic fields do not.
The ledger counts finalized messages, not partial streams or end-of-run copies.
It excludes parent worker rollups because it reads each worker's own events.

With experiment tracing enabled, the extension observes registry classifier calls, including approval checks outside the router.
The ledger counts those call records once instead of adding duplicate router usage or the Jev tool's usage again.
Router-only classifier usage remains available as a separate overhead measure.
The installed runtime's `classify()` returns usage but does not automatically append it to session totals.
Codemode stays inactive, so its separate nested-call accounting does not overlap this instrument.

Main and worker chat usage and classifier usage remain separate. The result tables show their categories beside aggregate tokens.
Tokens from different models do not imply equal money or subscription consumption.

Run unscored smoke checks with:

```sh
node --import tsx scripts/evaluate-virtual-models.ts --phase smoke
```

Run the one-repetition scored plan only after smoke checks pass:

```sh
node --import tsx scripts/evaluate-virtual-models.ts --phase scored --repetitions 1
```

Resume an existing manifest with:

```sh
node --import tsx scripts/evaluate-virtual-models.ts --resume .pi/virtual-models-eval/<run-directory>
```

Use `--tasks`, `--arms`, `--roles`, and `--repetitions` to select pending cases.
The default command runs four unscored smoke cases, not the scored matrix.

## Runner repair and retained evidence

Zero Cool approved runner `teop-runner-v2` after two worker setup errors became visible.
The isolated-worker guard correctly rejected an injected, uncommitted bug and an untracked dependency link.
Runner v2 commits the fixture and a local dependency-ignore rule before delegation. It does not change the worker safety guard.

Diagnostic workers need writable, isolated worktrees for test dependencies and cache files.
The assignment still forbids source edits. The independent check still requires unchanged tracked sources.
The edit smoke then exposed a worker defect: patch capture checked the main checkout instead of the linked source worktree.
Zero Cool approved a narrow fix. Worktree creation records the actual source worktree, and capture validates the patch there.
Existing conflict checks remain active. No runner-v2 scored cases started before this prerequisite repair.
Runner v2 also requires the expected assertion failure, not just a command containing the test path.

The first GLM worker diagnosis result is invalid infrastructure evidence: Vitest never loaded the test.
The old checker accepted its correct answer despite that startup failure.
Its original result and 166,314 reported tokens remain in the raw data.
The explicit invalidation is `.pi/virtual-models-eval/pilot-e348087/invalidations.json`.

Offline replay verified actual test failures in all three completed main diagnosis cases.
Their original scores remain unchanged, including GLM's missing-result-line failure.
Routing policy, model pool, assignment text, and expected answers remain unchanged.
The repair records links between run versions. It does not bypass the original resume fingerprint checks.

The Software Development Kit (SDK) can fill failed responses with zero-token placeholders.
These fields do not prove provider usage. Runner v2 marks them unknown and retains the original events.
The offline report keeps known token lower bounds separate from unknown totals.

Rebuild the available results without model requests:

```sh
node --import tsx scripts/report-virtual-models.mjs \
  .pi/virtual-models-eval/pilot-e348087 \
  .pi/virtual-models-eval/pilot-runner-v2 \
  --compatibility docs/virtual-models-compatibility.json \
  --output-dir .pi/virtual-models-eval/combined-v2
```

When a report includes both runner versions, supply `--compatibility PATH`.
The record must list the approved fingerprints. The report rejects unapproved invalidations and duplicate completed scores.

## Results

Main tokens include the main chat, any delegated worker, and all measured classifier calls.
Worker tokens include the worker chat and its classifier calls. Fixed-parent costs appear separately below.
A cell gives `result; tokens; process seconds`. Process time includes startup, tools, and worker provisioning, but excludes controller setup and independent checks.
The JavaScript Object Notation (JSON) evidence also records each worker's own elapsed interval.

### Main sessions

| Task | Sol | DeepSeek | GLM | Rules | Jev |
| --- | --- | --- | --- | --- | --- |
| boundaries | pass; 165,947; 93.41 | pass; 177,113; 86.84 | pass; 206,691; 134.93 | pass; 222,855; 140.61 | pass; 190,704; 132.08 |
| diagnosis | pass; 52,586; 18.10 | pass; 70,662; 34.07 | fail; 65,420; 39.04 | pass; 88,472; 21.72 | pass; 42,862; 14.27 |
| fix | pass; 151,501; 33.89 | pass; 117,669; 35.33 | pass; 126,643; 59.20 | pass; 86,151; 19.08 | pass; 120,726; 24.26 |
| rename | pass; 102,721; 30.01 | pass; 177,636; 35.71 | pass; 172,679; 157.41 | pass; 140,533; 28.11 | pass; 220,702; 49.04 |
| review | pass; 86,661; 20.67 | pass; 274,765; 33.44 | pass; 419,555; 235.32 | pass; 61,581; 19.58 | pass; 64,005; 26.44 |
| schedule | pass; 32,809; 25.56 | pass; 927,079; 307.81 | pass; 61,344; 231.77 | pass; 32,837; 28.11 | pass; 33,534; 34.02 |

| Arm | Pass | Total tokens | Tokens per success | Process seconds |
| --- | --- | --- | --- | --- |
| Sol | 6/6 | 592,225 | 98,704.17 | 221.63 |
| DeepSeek | 6/6 | 1,744,924 | 290,820.67 | 533.20 |
| GLM | 5/6 | 1,052,332 | 210,466.40 | 857.67 |
| Rules | 6/6 | 632,429 | 105,404.83 | 257.20 |
| Jev | 6/6 | 672,533 | 112,088.83 | 280.12 |

Fixed Sol had the lowest observed aggregate tokens and time among the six-success arms.
Both routers beat fixed DeepSeek and GLM on tokens, but neither beat the current Sol default.
Rules reduced tokens for the tested fix, but its investigation and rename costs offset that saving.
Do not tune this policy on those scored results and retain these scores as a comparable control.

### Workers

| Task | GLM | Rules | Jev |
| --- | --- | --- | --- |
| boundaries | pass; 76,815; 75.54 | pass; 74,777; 69.38 | pass; 54,309; 92.47 |
| diagnosis | pass; 44,620; 88.87 | pass; 38,213; 74.52 | pass; unknown, at least 41,160; 84.38 |
| fix | pass; 57,671; 102.04 | pass; 48,054; 64.01 | pass; 59,356; 73.76 |
| rename | fail; 105,583; 184.92 | pass; 140,628; 78.98 | pass; 185,304; 98.78 |
| review | pass; 55,754; 111.75 | pass; 95,509; 68.41 | pass; 102,673; 70.78 |
| schedule | pass; 40,472; 267.32 | pass; 21,938; 68.36 | pass; 21,766; 58.97 |

| Arm | Pass | Worker tokens | Tokens per success | Fixed-parent chat tokens | All-process tokens | Process seconds |
| --- | --- | --- | --- | --- | --- | --- |
| GLM | 5/6 | 380,915 | 76,183.00 | 227,414 | 608,329 | 830.44 |
| Rules | 6/6 | 419,119 | 69,853.17 | 223,256 | 642,375 | 423.67 |
| Jev | 6/6 | unknown, at least 464,568 | unknown, at least 77,428 | 236,041 | unknown, at least 700,609 | 479.14 |

Rules used 38,204 more worker tokens than GLM and completed the extra exact-contract case.
Its observed process time was 49% lower. Its tokens per success were 8.31% lower, because that denominator includes the extra pass.
These are alternative views of the same six cases, not independent evidence.
The strict rename result and one repetition make a global worker-default change premature.

The Jev diagnosis worker recovered from one `429` error using the same DeepSeek model.
That failed request has no reliable usage report. Its total stays unknown; the successful calls and classifier reports establish the lower bound.
No completed case was rerun to remove this gap.
Lower bounds sum individually reported completed calls and known classifier usage; they omit unreported calls.
For example, reproduce the diagnosis worker's minimum without an inference request:

```sh
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const path = ".pi/virtual-models-eval/pilot-runner-v2/worker-diagnosis-jev-r1/attempts/worker-diagnosis-jev-r1-a1.json";
const attempt = JSON.parse(readFileSync(path, "utf8"));
const chat = attempt.workers.flatMap(worker => worker.dispatches)
  .filter(call => call.usage.aggregate !== null)
  .reduce((sum, call) => sum + call.usage.aggregate, 0);
console.log(chat + attempt.classifierWorkerUsage.aggregate); // 41160
JS
```

Even Jev's worker lower bound exceeds the rule total by 45,449 tokens, or 10.84%, with equal observed success.

### Paired differences

Every row compares the same six tasks. Positive token or time differences mean the router used more.
Success difference means router successes minus baseline successes. The JSON contains all 48 task-level paired differences.

| Role | Router | Baseline | Success difference | Token difference | Token difference % | Process seconds difference |
| --- | --- | --- | --- | --- | --- | --- |
| main | Rules | Sol | 0 | +40,204 | +6.79% | +35.57 |
| main | Rules | DeepSeek | 0 | -1,112,495 | -63.76% | -276.00 |
| main | Rules | GLM | +1 | -419,903 | -39.90% | -600.47 |
| main | Jev | Sol | 0 | +80,308 | +13.56% | +58.48 |
| main | Jev | DeepSeek | 0 | -1,072,391 | -61.46% | -253.08 |
| main | Jev | GLM | +1 | -379,799 | -36.09% | -577.56 |
| worker | Rules | GLM | +1 | +38,204 | +10.03% | -406.77 |
| worker | Jev | GLM | +1 | unknown, at least +83,653 | unknown, at least +21.96% | -351.30 |

### Token categories

These categories use the comparison scope defined above. Failed valid cases remain in their arm totals.
Jev worker values below are lower bounds, not substituted totals.

| Role | Arm | Input | Output | Cache read | Cache write | Aggregate |
| --- | --- | --- | --- | --- | --- | --- |
| main | Sol | 134,962 | 7,023 | 450,240 | 0 | 592,225 |
| main | DeepSeek | 219,492 | 46,264 | 1,479,168 | 0 | 1,744,924 |
| main | GLM | 172,286 | 35,054 | 844,992 | 0 | 1,052,332 |
| main | Rules | 134,642 | 12,731 | 485,056 | 0 | 632,429 |
| main | Jev | 177,988 | 15,569 | 478,976 | 0 | 672,533 |
| worker | GLM | 124,734 | 20,597 | 235,584 | 0 | 380,915 |
| worker | Rules | 118,500 | 9,227 | 291,392 | 0 | 419,119 |
| worker | Jev minimum | 125,448 | 13,168 | 325,952 | 0 | 464,568 |

Large cache-read volumes still count toward the chosen token aggregate. They do not imply equal monetary cost.
No within-task model switches occurred, so this pilot did not measure cache loss from switching.
Provider cache warmth and deferred batch order can affect latency and input distribution.

### Routing and classifier overhead

Both routers selected the following physical model in both roles:

| Task | Physical model | Main effective thinking | Worker effective thinking |
| --- | --- | --- | --- |
| boundaries | GLM | high | high |
| diagnosis | DeepSeek | high | high |
| fix | DeepSeek | high | high |
| rename | DeepSeek | high | high |
| review | Sol | medium | high |
| schedule | Sol | medium | high |

| Role | Router | Router classifier tokens | All classifier tokens | Total route latency, milliseconds |
| --- | --- | --- | --- | --- |
| main | Rules | 0 | 19,794 | 20.56 |
| main | Jev | 3,724 | 28,492 | 1,026.32 |
| worker | Rules | 0 | 16,390 | 14.43 |
| worker | Jev | 3,927 | 24,728 | 921.87 |

All-classifier totals include safety checks, not only routing. Fixed arms also incur those checks.
The main Sol, DeepSeek, and GLM classifier totals were 14,524, 57,737, and 29,270 tokens.
Fixed worker GLM incurred 18,704 classifier tokens.
All 12 routing classifications completed normally. The classifier chose no different models from the rule control.
This pilot found no selection benefit from Jev.
Differences beyond direct classifier overhead can reflect different model/tool behavior; they are not all caused by classification.
There was one same-model retry, no model switches, and no observed compaction in the scored cases.
Offline persistent-session tests cover branch restoration and compaction state; these paid worker runs cannot prove persistence.

## Failures, interruptions, and other expense

The two retained task failures are precise contract failures:

1. Main GLM diagnosed the failure correctly but omitted the required `VIRTUAL_RESULT=` line.
2. Worker GLM deliberately excluded two fixture-string occurrences from the rename. The compiler passed; the frozen exact-text oracle failed.

The rename wording and text oracle limit conclusions about semantic refactoring quality. Neither failure establishes a general coding defect.
Neither failure was rerun or used to tune policy.

There are 52 scored attempt records: 48 valid outcomes, three interrupted attempts, and one invalid earlier diagnostic pass.
The two interrupted DeepSeek diagnosis attempts have unknown totals and known minimums of 27,177 and 14,103 tokens.
The dirty-worker launch interruption consumed 19,928 reported parent tokens. The invalid diagnostic pass consumed 166,314 reported tokens.
These expenses remain outside the completed-case comparisons, not outside the ledger.

Nine unscored attempts contain seven completed checks, one quota interruption, and one invalid patch-capture check.
They establish at least 1,108,443 reported tokens; the quota interruption prevents an exact total.
The committed JSON records each attempt, its original usage, corrected usage, duration, and known minimum.
All fixture attempts together establish at least 7,981,721 tokens, including parent and classifier calls.
The exact total is unknown. Development-assistant costs and the untraced accidental classifier request remain outside that minimum.

Literal usage reconciles for all 47 fully reported valid cases. The remaining completed case retains its unknown error-call usage.
Every completed batch retained unchanged original configuration hashes. No provider or model substituted for exhaustion.

## Provenance, validation, and limits

The retained data contains 20 unaffected valid cases from `e348087` and 28 cases from `23ffec2`.
Runner repair commit `f3a2e30` has unscored evidence only.
The [compatibility record](virtual-models-compatibility.json) documents the approved infrastructure changes and unchanged router/fixture byte hashes.
Original attempt checkpoints remain unchanged. Explicit invalidations and execution-order links explain subsequent attempts.

Raw events and checks remain private under `.pi/virtual-models-eval/`:

| Location | Content |
| --- | --- |
| `pilot-e348087/` | Original scored data, interruptions, and diagnostic invalidation |
| `pilot-runner-v2/` | Repaired, one-case scored manifests and execution-order links |
| `smoke-e348087/` | Initial role/router smoke checks and quota retry |
| `smoke-runner-v2-f3a2e30/` | Diagnostic execution proof and invalid linked-source capture |
| `smoke-runner-v2-23ffec2/` | Passing real worker fix and rename collection |
| `combined-v2/` | Offline analysis and complete tables |
| `tui-e348087-retry1/` | Offline pseudo-terminal `/model` and footer checks |

The sanitized JSON is sufficient to inspect every reported comparison without model calls.
Use the offline report command above to rebuild tables from the retained raw directories.
Resume only a matching runner-v2 manifest, for example:

```sh
node --import tsx scripts/evaluate-virtual-models.ts \
  --resume .pi/virtual-models-eval/pilot-runner-v2/main-diagnosis-rules-r1
```

All cases in this pilot are complete; that command does not rerun them.
The runner rejects incompatible code or configuration. Do not edit a manifest to bypass that check.
An independent replication needs a different output directory and approval for additional model calls.
A changed routing policy needs its own version and affected comparisons, not selected reruns from this dataset.

The final check passed format, lint, both typechecks, 31 extension validators, 2,188 unit tests, and 51 runtime tests.
Final snapshot tests verify all 48 unique cases, retained failures, nullable usage, lower bounds, and router-choice agreement.
Normal commit hooks remain enabled. Existing parallel-test timeout behavior required `VITEST_MAX_WORKERS=2`; no tests were skipped.
Separate follow-up cards `t2o8` and `tj7o` cover existing validation messages and the load-sensitive test.

This is one repetition of six artificial tasks per role, not statistical evidence of equivalence or broad quality improvement.
Runs span service interruptions and approved infrastructure repairs. Cache warmth, host/provider load, and provisioning affect timing.
Model IDs do not pin hidden provider weight revisions. Requested thinking does not equal identical physical reasoning effort.
The custom status-bar footer hides physical dispatch; the built-in footer and `/model` expose it.
Keep the experimental routers opt-in. Global adoption requires a separate evidence review.
