# Virtual models

Registers three opt-in selections. None changes saved main or worker defaults.

- `virtual-models/glm-flash-fallback-v1` keeps GLM Flash selected and changes providers when necessary. It supports main sessions and workers.
- `virtual-models/deepseek-flash-fallback-v1` keeps DeepSeek Flash selected and changes providers when necessary. It supports main sessions and workers.
- `virtual-models/worker-auto-v1` uses Jev to select worker model families and recover recognized availability failures. Rules are a classifier fallback only.

`rules-v1`, `jev-v1`, and their dedicated router implementations and tests are removed. Historical pilot evidence retains their results.
The internal rule fallback in `worker-auto-v1` remains available when Jev classification fails.

See [the evaluation](../../docs/virtual-models-evaluation.md) for pilot evidence and limitations.

## Provider order

The fixed-family profiles use the same provider order as `worker-auto-v1`:

| Model family | Ordered physical endpoints |
|---|---|
| DeepSeek V4.1 Flash | `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` → `opencode-go/deepseek-v4.1-flash` |
| GLM 5.3 Flash | `zai/glm-5.3-flash` → `synthetic/hf:zai-org/GLM-5.3-Flash` → `opencode-go/glm-5.3-flash` |
| GPT-6.1 Sol | `openai-codex/gpt-6.1-sol` only |

Provider order is an explicit preference, not a rule-based model choice. Code enforces credentials, quota exclusions, and retry limits.
Only `worker-auto-v1` classifies families. Jev sees one eligible endpoint per family and cannot override provider order.
The routers do not switch from planning to implementation models.

The Synthetic `1017` snapshot uses the already-probed catalog definition from main commit `b9ce257`.
The OpenCode Go DeepSeek identifier does not promise the same dated snapshot.

## Fixed-family selection and recovery

Both fixed-family profiles require Pi 1.3.0. They support main sessions and workers without a routing classifier or rule-based family choice.
Other extensions can still call classifiers for security checks.
They select the first eligible provider, retain healthy alternatives across user requests, and stop after their family exhausts its providers.
They never substitute Sol or the other Flash family. Direct requests also stay within the selected family.

Both profiles use the quota and temporary-error recovery rules below.
DeepSeek permits at most four failed agent requests in an uninterrupted failure sequence; GLM permits at most six.
A quota-only sequence stops after at most two DeepSeek requests or three GLM requests.
Internal transport retries and response times remain separate from these limits.

## Automatic worker selection and recovery

`worker-auto-v1` requires Pi 1.3.0 and a worker session. It rejects main-session dispatch.
Authenticated `typesafe/jev-latest` chooses a model family.
Jev receives the worker assignment, capped at 12,000 characters, eligible model metadata, and a sanitized failure category when relevant.
It does not receive tool results or raw provider error text. One ten-second deadline covers classifier availability and inference.
Classifier requests use no retries. The router validates the returned choice, probability distribution, and confidence range.
It does not treat low distribution concentration as proof that a preference is wrong.

Rules choose only when Jev is unavailable, fails, times out, or returns an invalid choice.
Cancellation stops routing instead of triggering rule fallback. A single eligible family needs no semantic choice or rule ranking.
Healthy continuations, the first same-model temporary retry, and same-family provider changes do not call Jev again.

| Assignment | Rule fallback order |
|---|---|
| Bounded lookup | GLM → DeepSeek → Sol |
| Diagnosis, implementation, tested fixes, renames | DeepSeek → GLM → Sol |
| Safety review, architecture, demanding reasoning | Sol → DeepSeek → GLM |

The fallback keyword rules come from `src/policy.ts`. They do not override a valid Jev choice.
Routing is a heuristic, not a quality guarantee.
The router skips endpoints without available credentials and never chooses outside the six approved endpoints above.
Registry availability is a cached authentication snapshot, not a quota or service-health probe.
The router does not read remaining subscription allowances or usage percentages.
It does not convert recorded token counts or catalog prices into subscription usage.
Healthy continuations retain their physical endpoint, even if a preferred provider becomes available again.
Thinking follows the requested setting, clamped to physical support.

Recognized subscription exhaustion excludes that provider from subsequent requests in the session branch.
A first temporary failure permits one retry on the same endpoint. A second consecutive temporary failure excludes that endpoint.
The router tries remaining providers in the current family before another family choice.
In `worker-auto-v1`, Jev chooses another eligible family after DeepSeek or GLM exhausts its provider chain. Rules remain a classifier fallback only.
The fixed-family profiles stop instead of choosing another family.
Sol has no replacement: Codex quota exhaustion or its second consecutive temporary failure stops the worker, even when other families remain available.
Pi controls its configured automatic retry delays.
The recovery boundary also works when Pi's automatic retries are disabled or exhausted; it adds no delay itself.
This policy does not change saved retry settings.

For an uninterrupted failure sequence, each physical endpoint receives at most two failed agent requests.
The six `worker-auto-v1` endpoints permit at most twelve such requests; selecting Codex can stop the sequence earlier.
Its quota-only sequence stops after at most four failed requests, one per provider.
Each profile stops when no eligible destination remains. The existing worker timeout still applies to workers.
The policy does not bound provider response time or internal transport retries independently.

Availability knowledge comes from raw assistant entries on the current session branch, including failures omitted from provider context.
A successful response from an approved endpoint clears its provider's quota exclusion and its model's temporary-failure count and exclusion.
The policies do not infer subscription resets or share availability knowledge between sessions.

Recovery continues the same session without another user prompt. Worker recovery also retains its process and worktree.
A context edit omits only the failed assistant response from provider context. Raw history retains the failure.
Completed tool results remain in context; recovery does not execute their calls again.
Mandatory coordination, sandbox controls, parent approvals, and the nested-delegation ban remain active.

Cancellation, authentication failures, permission failures, unknown errors, context overflow, and tool errors do not trigger this fallback.
A failed task check does not trigger a model change.

### Limits

Recovery covers provider errors in the agent request loop. Direct requests, including compaction and summaries, do not use this recovery boundary.
They can still fail on quota exhaustion. The offline integration test verifies this limitation.

### Prompt-cache reuse

The router keeps a healthy endpoint selected. It does not return to a preferred provider automatically.
Provider changes do not transfer prompt caches. Expect a cold replay at the replacement provider, even within the same model family.
Subsequent requests may reuse that provider's cache, subject to its cache rules and retention period.
Different context limits, thinking formats, or compaction can also change cache reuse.
Jev classification does not populate the worker chat cache. Route audit entries add no model-facing prompt text.
The pilot did not measure this recovery policy or its long-session cache costs.
Catalog token prices do not establish subscription allowance or invoice charges.

### Worker display

Each worker keeps its configured router label. Its widget also shows the latest physical model and provider on a separate row.
The separate row keeps the physical target visible in narrow panes. Model or effective-thinking changes trigger a live refresh.
Worker status includes the full physical identifier and effective thinking level when reported.
Routing records or native assistant metadata supply these fields. Finalization restores them from the stream after parent loss.
The main-session model label remains unchanged.

### Audit records

Normal event streams include `virtual-models-route` custom entries.
`worker-auto-v1` adds `virtual-models-worker-recovery` entries. The fixed-family profiles add `virtual-models-provider-recovery` entries.
They record selections, classifier outcomes when used, reported usage, retry decisions, and pool exhaustion without copying raw error text.
A recovery entry with `decision: "select"` lists eligible candidates; the following route entry records the actual destination.
`decision: "provider-fallback"` records a same-family provider change. `decision: "stopped"` with `reason: "codex-no-fallback"` records terminal Codex recovery.
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

## Main-session selection

Choose GLM Flash:

```sh
pi -e extensions/virtual-models/virtual-models.ts --model virtual-models/glm-flash-fallback-v1
```

Choose DeepSeek Flash:

```sh
pi -e extensions/virtual-models/virtual-models.ts --model virtual-models/deepseek-flash-fallback-v1
```

Both commands require credentials for at least one provider in the selected family.

## Configuration

The extension has no saved configuration file.
Workers receive their role from `PI_WORKER=1`.

For fixed-family workers, replace the temporary command's `PI_WORKER_MODEL` value with `virtual-models/glm-flash-fallback-v1` or `virtual-models/deepseek-flash-fallback-v1`.
A temporary `PI_WORKER_EXTENSIONS_CONFIG` file must retain the default worker list and add `virtual-models`.
The worker resolver retains mandatory coordination, approval, and sandbox extensions. It still rejects nested delegation.

The frozen pilot predates `worker-auto-v1`. Its evidence remains unchanged; use its recorded source versions for reproduction.
Current source fingerprints do not authorize resuming historical pilot manifests.
The current evaluator rejects `--arms rules` and `--arms jev`. It launches fixed physical models only.
Its default smoke run contains two GLM cases; its scored plan contains 24 cases.
These launch options do not change the recorded 48-case pilot. The offline pilot report retains its historical 48-case plan.

The evaluator sets `PI_VIRTUAL_MODEL_TRACE` to a private output prefix.
This enables per-process route, effective-tool, and classifier-call records.
Classifier records observe registry calls, including approval checks, without copying their inputs or credentials.
They do not change classifier results or retry options.
Normal sessions without that variable do not install classifier measurement.

Do not use the trace variable as a general session setting. It is an experiment instrument, not production telemetry.
