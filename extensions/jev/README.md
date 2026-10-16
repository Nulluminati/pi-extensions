# Jev

The `jev` tool asks TypeSafe's Jev model for typed judgments about supplied evidence. It supports semantic classification, evidence checks, relevance ranking, and bounded choices.

Jev does not write explanations or code. It returns choices, scores, and probabilities. The main agent interprets those answers.

## Built-in alternative

Pi already supports Jev through `codemode` with `models.classify(...)`. This extension is optional. It adds direct access and consistent input limits and response checks, not another model capability.

Use built-in `codemode` when a script combines retrieval, judgments, and filtering. Use `jev` when direct calls and its fixed checks suit the task.

The [one-task comparison](COMPARISON.md) found identical labels and Jev token counts through both routes. It did not establish an accuracy advantage, a typical speed difference, or better agent tool selection.

The [agent-level comparison](AGENT-COMPARISON.md) found a concrete benefit for short checks in fresh sessions. Both interfaces passed six tasks without errors. The dedicated tool used twelve main-model requests; built-in `codemode` used twenty-two. This supports reduced agent work, not higher reliability or better Jev judgments.

## Load

```bash
pi -e extensions/jev/jev.ts
```

The extension requires Pi's native classifier registry (`findOfType` and `classify`). It adds no package dependency, background process, command, or automatic hook.

## Configuration

The default model is `typesafe/jev-latest`. Set `TYPESAFE_API_KEY` in the environment that starts Pi, or configure TypeSafe credentials through Pi.

The optional `model` parameter selects a Pi classifier by `provider/model-id`:

| Model parameter | Provider credential |
| --- | --- |
| `typesafe/jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter/typesafe/jev-1.13` | `OPENROUTER_API_KEY` or Pi login |
| `opencode/jev-1.13` | `OPENCODE_API_KEY` |
| `vercel-ai-gateway/typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai/typesafe/jev` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |

Pi must include the selected classifier in its catalog. Model availability depends on the provider. An explicit selection can use another Pi classifier. The tool never changes the chat model or silently selects a fallback.

Credentials stay with Pi. Do not pass keys in tool arguments.

## Inputs

| Parameter | Meaning |
| --- | --- |
| `state` | A JSON object containing the evidence. Wrap plain text as `{ "text": "..." }`. |
| `questions` | A map of 1–64 independent questions. Answers use the same IDs. |
| `model` | Optional Pi classifier identifier. Default: `typesafe/jev-latest`. |

Each question contains `type`, `instructions`, and `criteria`:

| Type | Criteria | Answer |
| --- | --- | --- |
| `bool` | Descriptions under `true` and `false` | `probability`: probability of yes, from 0 to 1 |
| `choice` | 2–255 named options with descriptions | `choice`, per-option `probabilities`, and `confidence` |
| `score` | 2–10 ordered level descriptions | `score` and `confidence` |

Pi calls the yes/no primitive `bool`. TypeSafe calls it Noul and uses `noul` on its HTTP interface. Pi handles that translation.

A score is the probability-weighted level index. Three levels give a range of 0–2, including fractional values. Pi's score answer does not expose the full level distribution or legend.

Instructions and criteria must contain nonblank text. Question IDs and choice IDs must be nonblank. State must contain finite JSON values within 64 nesting levels. The serialized state and questions must fit within 65,536 UTF-8 bytes. Oversized requests fail before inference; the tool never truncates evidence. Provider context limits also apply.

## Example: check evidence and select a workflow

```json
{
  "state": {
    "request": "Fix empty input without changing invalid JSON handling.",
    "test_log": "Empty input: passed. Invalid JSON: failed."
  },
  "questions": {
    "all_tests_pass": {
      "type": "bool",
      "instructions": "Does `test_log` show that every test passed?",
      "criteria": {
        "true": "The log reports success for every test.",
        "false": "The log reports a failure or lacks complete results."
      }
    },
    "next_step": {
      "type": "choice",
      "instructions": "Which next step does `test_log` support?",
      "criteria": {
        "finish": "All requested behavior passes its tests.",
        "investigate": "At least one required test failed.",
        "gather_evidence": "The log does not establish the result."
      }
    },
    "test_coverage": {
      "type": "score",
      "instructions": "How completely does `test_log` cover the behavior in `request`? Judge coverage, not whether tests pass.",
      "criteria": [
        "The log covers none of the requested behavior.",
        "The log covers only part of the requested behavior.",
        "The log covers both empty input and invalid JSON handling."
      ]
    }
  }
}
```

All three questions run in one classifier request. They cannot read one another's answers. A dependent question needs another request with the earlier answer in its state.

## Other uses

1. Classify issues with one Choice question per issue and a shared label catalog in state.
2. Rank search results with one Bool relevance question per candidate. Sort their probabilities in code.
3. Select a worker or workflow with a Choice question. Include a no-match or ask-person option when necessary.
4. Compare claims with supplied source excerpts. Include supported, contradicted, and insufficient-evidence options.

Use code for exact string checks, arithmetic, and test execution. Use Jev when a decision needs semantic interpretation.

## Results and failures

Successful results contain `status: "ok"`, `provider`, `model`, `answers`, and optional provider-reported `usage`. The text result, `details`, and `structuredContent` normally contain the same data. Programmatic callers receive structured data through Pi's output schema.

Text results over 50 KiB become a short notice with `fullResultPath`. Read that temporary JSON file in bounded sections. The file has owner-only permissions. Structured output and details retain every answer. The tool does not truncate input or silently omit probabilities.

The tool also forwards reported usage to Pi's session accounting. Catalog prices determine reported cost. A zero cost for direct TypeSafe does not mean the service is free.

A request uses a ten-second per-attempt timeout with no automatic retries. Cancellation reaches the classifier. Missing models, invalid credentials, service failures, and invalid answers return `isError: true` with `status: "error"`. Error results include reported usage when available, but contain no judgments.

Answer validation checks question IDs, answer types, finite numeric ranges, choice membership, and complete probability distributions. Choice probabilities must sum to one within 0.01. The selected choice must have the highest probability; ties are valid. Malformed output is a service failure, not low confidence.

## Boundaries

Only supplied state and questions reach the classifier. The tool does not read files, fetch sources, or copy session history. It writes large results only to a private temporary directory. Supplied evidence leaves the machine for the selected provider. Exclude secrets and private material that must remain local. Normal Pi tool history still contains the arguments and result.

Judgments are advisory. They do not grant permission, execute actions, replace Approval Mode, or prove that a claim is true. A high Choice confidence describes a concentrated distribution, not factual correctness. A Bool probability near 0.5 means uncertainty about yes versus no, not medium intensity. Evaluate thresholds against representative cases before automating decisions.

The tool accepts text and structured JSON, not image attachments or TypeSafe's richer structured-question interface. It does not protect the main agent from malicious text that the agent already read.

## Design references

1. [TypeSafe's API](https://docs.typesafe.ai/api) defines the underlying state-and-questions interface. [Pi's classifier interface](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md#classify) defines the narrower question and answer types used here.
2. [jev-mcp](https://github.com/jkudish/jev-mcp) exposes focused verification, ranking, and review tools. This extension starts with one general tool instead of maintaining separate question sets.
3. [jev-gateway](https://github.com/vinilana/jev-gateway) selects tools before the main model fills arguments. That design changes agent behavior and requires task-level evaluation.
4. [Jev Tool Router](https://github.com/jackbarunz/jev-tool-router) selects tools from large catalogs with an uncertain-result fallback. This extension does not hide or route tools.

These projects informed the interface comparison. Their performance claims are not measurements of this extension.

## Verification

```bash
npx vitest run test/extensions/jev.test.ts
npm run validate:one -- extensions/jev/jev.ts
npm run check
```

For a live check, load the extension with configured credentials. Ask the agent to use `jev` with the example above. A live call sends evidence to the provider and can incur a charge. Offline tests validate the tool contract, not Jev's judgment quality.
