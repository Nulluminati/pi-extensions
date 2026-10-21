# Virtual models

Registers three opt-in selections. None changes saved main or worker defaults.

- `virtual-models/worker-auto-v1` uses Jev to select worker models and recover recognized availability failures. Rules are a classifier fallback only.
- `virtual-models/rules-v1` uses observable request features for the frozen `teop` pilot.
- `virtual-models/jev-v1` asks authenticated `typesafe/jev-latest` to choose from the same physical pool for that pilot.

See [the evaluation](../../docs/virtual-models-evaluation.md) for pilot evidence and limitations.

## Worker selection and recovery

`worker-auto-v1` requires Pi 1.3.0 and a worker session. It rejects main-session dispatch.
Authenticated `typesafe/jev-latest` chooses the initial physical model and any replacement after an availability failure.
It chooses only among currently eligible members of the approved pool. Code enforces credentials, quota exclusions, and retry limits before classification.
It does not switch from planning to implementation models.

Jev receives the worker assignment, capped at 12,000 characters, eligible model metadata, and a sanitized failure category when relevant.
It does not receive tool results or raw provider error text. One ten-second deadline covers classifier availability and inference.
Classifier requests use no retries. The router validates the returned choice, probability distribution, and confidence range.
It does not treat low distribution concentration as proof that a preference is wrong.

Rules choose only when Jev is unavailable, fails, times out, or returns an invalid choice.
Cancellation stops routing instead of triggering rule fallback. A single eligible destination needs no semantic choice or rule ranking.
Healthy continuations and the first same-model temporary retry do not call Jev again.

| Assignment | Rule fallback order |
|---|---|
| Bounded lookup | GLM → DeepSeek → Sol |
| Diagnosis, implementation, tested fixes, renames | DeepSeek → GLM → Sol |
| Safety review, architecture, demanding reasoning | Sol → DeepSeek → GLM |

The fallback keyword rules come from `src/policy.ts`. They do not override a valid Jev choice.
Routing is a heuristic, not a quality guarantee.
The router skips models without available credentials and never chooses outside the physical pool below.
Healthy continuations retain their physical model. Worker thinking follows the requested setting, clamped to physical support.

Recognized subscription exhaustion excludes that provider from subsequent requests in the worker branch.
A first temporary failure permits one retry on the same model. A second consecutive temporary failure excludes that model.
Jev then chooses among the remaining eligible models, with rules only as a classifier fallback.
Pi controls its configured automatic retry delays.
The recovery boundary also works when Pi's automatic retries are disabled or exhausted; it adds no delay itself.
This explicit policy does not change saved retry settings.

For an uninterrupted failure sequence, each physical model receives at most two failed agent requests.
Three exhausted providers produce at most three failed requests. The worker stops when no eligible destination remains.
The existing worker timeout still applies. The policy does not bound provider response time independently.

Availability knowledge comes from raw assistant entries on the current worker branch, including failures omitted from provider context.
A successful provider response clears that provider's quota exclusion and that model's temporary-failure count and exclusion.
The policy does not infer subscription resets or share availability knowledge between workers.

Recovery continues the same worker process, conversation, and worktree. It does not create a replacement worker or another user prompt.
A context edit omits only the failed assistant response from provider context. Raw history retains the failure.
Completed tool results remain in context; recovery does not execute their calls again.
Mandatory coordination, sandbox controls, parent approvals, and the nested-delegation ban remain active.

Cancellation, authentication failures, permission failures, unknown errors, context overflow, and tool errors do not trigger this fallback.
A failed task check does not trigger a model change.

### Limits and audit records

Recovery covers provider errors in the agent request loop. Direct requests, including compaction and summaries, do not use this recovery boundary.
They can still fail on quota exhaustion. The offline integration test verifies this limitation.
A model change can lose prompt-cache reuse. The pilot did not measure this recovery policy or its long-session cache costs.

Normal worker event streams include `virtual-models-route` and `virtual-models-worker-recovery` custom entries.
They record selections, classifier outcomes and usage when reported, retry decisions, and pool exhaustion without copying raw error text.
A recovery entry with `decision: "select"` lists eligible candidates; the following route entry records the actual destination.
`reason: "classifier-choice"` identifies a Jev decision. `reason: "classifier-fallback"` identifies degraded rule selection.
Assistant messages retain physical model identities and provider error details. No experiment trace flag is required for these records.

### Temporary opt-in

1. Install the same extension version for parent and worker processes. Keep their extension roots aligned.
2. Run this command from that checkout. It retains the current worker extension list and adds `virtual-models` for this process only.

```sh
(
  set -e
  worker_extensions="$(node --import tsx --input-type=module <<'JS'
import { resolveWorkerExtensions } from "./extensions/workers/src/worker-extensions.ts";
const names = resolveWorkerExtensions(undefined).map((entry) => entry.name);
console.log([...new Set([...names, "virtual-models"])].join(","));
JS
  )"
  PI_WORKER_EXTENSIONS="$worker_extensions" \
  PI_WORKER_MODEL=virtual-models/worker-auto-v1 \
  pi -e extensions/virtual-models/virtual-models.ts
)
```

The main model remains unchanged. Spawn workers normally in this session.
Exiting this shell command removes the temporary overrides. No saved worker model or extension list changes.
Do not select `worker-auto-v1` as the main model.

## Pilot result

Fixed Sol used fewer tokens and less time than main-session routing in the 48-case pilot. Worker rules gained one exact-contract pass with 10.03% more worker tokens.
Rules and Jev chose identical models for all six tasks in each role. Jev showed no selection benefit over rules.
Keep saved defaults unchanged pending review. One worker Jev retry has unknown usage; the evaluation preserves its token lower bound.
Pi's built-in footer and `/model` expose physical dispatch. The custom status-bar footer does not.

## Try one session

```sh
pi -e extensions/virtual-models/virtual-models.ts --model virtual-models/rules-v1
```

Choose the Jev selection with `--model virtual-models/jev-v1`.
Both selections require authenticated physical models:

```text
openai-codex/gpt-6.1-sol
opencode-go/deepseek-v4.1-flash
zai/glm-5.3-flash
```

## Pilot routing policy

Policy `teop-policy-v1` chooses at user-task boundaries.
The rule policy sends safety reviews and optimality or architecture requests to Sol.
It sends ordinary diagnosis, tested fixes, implementation, and renames to DeepSeek.
Other bounded requests go to GLM. The source defines the exact observable matches.

Jev receives the role and at most 12,000 characters from the latest user message.
It does not receive fixture labels or checking rules. It does not classify tool continuations.
Its ten-second deadline covers availability checks and inference. A recorded classifier failure falls back to Sol.
Cancellation does not trigger fallback.

Tool continuations and ordinary retries retain their physical model and thinking level.
Branch-local state preserves a choice when no previous response exists.
Direct requests use Sol without session-state assumptions. Pi clamps thinking levels to physical support.

A chat subscription exhaustion error pauses the experiment instead of selecting a substitute.
Classifier failure and chat subscription exhaustion are different conditions.

## Configuration

The extension has no saved configuration file.
Workers receive their role from `PI_WORKER=1`.

For temporary pilot worker selection, set `PI_WORKER_MODEL=virtual-models/rules-v1` or `virtual-models/jev-v1`.
A temporary `PI_WORKER_EXTENSIONS_CONFIG` file must retain the default worker list and add `virtual-models`.
The worker resolver retains mandatory coordination, approval, and sandbox extensions. It still rejects nested delegation.

The frozen pilot predates `worker-auto-v1`. Its evidence remains unchanged; use its recorded source versions for reproduction.
Current source fingerprints do not authorize resuming historical pilot manifests.

The evaluator sets `PI_VIRTUAL_MODEL_TRACE` to a private output prefix.
This enables per-process route, effective-tool, and classifier-call records.
Classifier records observe registry calls, including approval checks, without copying their inputs or credentials.
They do not change classifier results or retry options.
Normal sessions without that variable do not install classifier measurement.

Do not use the trace variable as a general session setting. It is an experiment instrument, not production telemetry.
