# Virtual-model evaluation

## Status

The pilot is in progress. DeepSeek service failures and a runner repair pause affected comparisons.
Keep fixed models and saved defaults. The incomplete comparison does not support global adoption.

This report follows herdboard card `teop` and its agreed eight-step plan.
The initial repository commit is `9d014872a60068c50cb2e39c8d761561ac3af1f4`.
The installed Pi version is `1.3.0`.

## What virtual models do

A virtual model is a selectable router. It returns a physical model and thinking level before each request.
Pi retains the virtual selection in model-change entries. Each assistant message identifies the physical model that answered.
The interactive footer shows both identities. Providers receive only physical models.

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

Router state follows the session branch through Pi's virtual-model state API.
It survives compaction. Direct requests have no router state, and Pi ignores state returned for them.
Workers use `--no-session`; their traces cannot prove persistent session restoration or branch behavior.

The upstream `jev-router.ts` example switches permanently after the first successful file edit.
That policy differs from this pilot's task-boundary selection. This pilot will not copy that switch.

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
The pilot retains these role-level requests and must record the effective physical levels.

Sol maps `minimal` to `low` and supports `low`, `medium`, `high`, `xhigh`, and `max`.
DeepSeek and GLM support `low`, `high`, and `max`; their catalog maps mark the other levels unsupported.
Runtime tests must verify clamping rather than infer it from model names.

The saved settings contain no explicit `defaultTools` or `codemode` override.
All comparison arms must use identical effective tool exposure and codemode configuration.
The earlier codemode recommendations remain outside this investigation.

## Worker loading

Workers start with `--no-extensions` and explicit `-e` entrypoints.
`PI_WORKER_MODEL` overrides the saved worker selection. `PI_WORKER_MODEL_THINKING` sets its requested thinking level.
`PI_WORKER_EXTENSIONS_CONFIG` can select a temporary extension-list file.
An explicit tool parameter or `PI_WORKER_EXTENSIONS` takes precedence over that file.

The temporary list must retain the usual provider extensions and add the experimental router.
The resolver always includes messenger, worker-blocker, approval-mode, and worker-sandbox.
It loads worker-sandbox last. It rejects workers, missions, autoresearch, and goal.
Do not change the saved allowlist or weaken these boundaries for the pilot.

An initial read-only audit worker could not read repository files.
It reported a missing `cross-spawn` package. That diagnosis was wrong: both checkouts contain the package.
Real sandbox-tool tests showed that the broker permits the Pi package but hides its separately installed dependencies.
The same error occurs in the assigned worktree despite a complete locked installation.

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
The live runner must capture that inventory before comparisons.

Five focused tests cover metadata filtering, exact model IDs, environment overrides, configuration changes, and malformed configuration.
The first test run failed because the recorder module did not exist. The implemented recorder passes those tests and both typechecks.
The repository check passed before implementation: 2,105 unit tests and 48 runtime tests.

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

Main and worker chat usage and classifier usage remain separate. The report must show their categories beside aggregate tokens.
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
  --output-dir .pi/virtual-models-eval/combined-v2
```

When a report includes both runner versions, supply `--compatibility PATH`.
The record must list the approved fingerprints. The report rejects unapproved invalidations and duplicate completed scores.

## Evidence still required

1. Freeze six main tasks, bounded worker assignments, and independent checks.
2. Test the rule router and Jev router before implementation.
3. Verify real worker loading and persistent main-session branch behavior.
4. Test the resumable runner and token ledger.
5. Run unscored smoke checks before scored comparisons.
6. Run the main and worker comparisons separately, with one repetition.
7. Report all completed, failed, and interrupted attempts.

No adoption recommendation follows from the current baseline.
