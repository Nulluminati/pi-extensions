# Experimental virtual models

Registers two opt-in selections for the `teop` pilot:

- `virtual-models/rules-v1` uses observable request features.
- `virtual-models/jev-v1` asks authenticated `typesafe/jev-latest` to choose from the same physical pool.

Neither selection changes saved main or worker defaults. This extension does not establish that routing improves outcomes.
See [the evaluation](../../docs/virtual-models-evaluation.md) for evidence and limitations.

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

## Routing policy

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

For temporary worker selection, set `PI_WORKER_MODEL=virtual-models/rules-v1` or `virtual-models/jev-v1`.
A temporary `PI_WORKER_EXTENSIONS_CONFIG` file must retain the default worker list and add `virtual-models`.
The worker resolver retains mandatory coordination, approval, and sandbox extensions. It still rejects nested delegation.

The evaluator sets `PI_VIRTUAL_MODEL_TRACE` to a private output prefix.
This enables per-process route, effective-tool, and classifier-call records.
Classifier records observe registry calls, including approval checks, without copying their inputs or credentials.
They do not change classifier results or retry options.
Normal sessions without that variable do not install classifier measurement.

Do not use the trace variable as a general session setting. It is an experiment instrument, not production telemetry.
