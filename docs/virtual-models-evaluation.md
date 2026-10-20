# Virtual-model evaluation

## Status

The pilot has not started. No scored model calls or routing comparisons exist yet.
Keep fixed models and saved defaults until the pilot provides evidence.

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
Its installed extension checkout lacked `cross-spawn`, which the sandbox's process helper requires.
That checkout is outside the assigned worktree and remains unchanged.
The assigned worktree's locked dependency installation contains `cross-spawn`.
The pilot must test worker loading from an isolated agent configuration that points at this worktree.
The audit attempt is investigation overhead, not a scored pilot case.

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

## Evidence still required

1. Freeze six main tasks, bounded worker assignments, and independent checks.
2. Test the rule router and Jev router before implementation.
3. Verify real worker loading and persistent main-session branch behavior.
4. Test the resumable runner and token ledger.
5. Run unscored smoke checks before scored comparisons.
6. Run the main and worker comparisons separately, with one repetition.
7. Report all completed, failed, and interrupted attempts.

No adoption recommendation follows from the current baseline.
