---
name: probe-model
description: Determine a model's correct thinkingLevelMap and reasoning config for a pi provider extension by probing its reasoning_effort API. Use whenever adding a new model to a provider extension's static model list (especially extensions/synthetic/synthetic.ts), whenever the session_start missing-models check surfaces an unknown model id, or when debugging why thinking levels don't work or are missing (e.g. xhigh not appearing) for a provider's models. Also use when validating whether a third-party provider extension's published thinkingLevelMap is correct.
---

# Probing a Model's Thinking Levels

A provider's `/models` endpoint tells you whether a model *can* reason, but not
which `reasoning_effort` values it accepts, whether thinking can be turned off,
or whether each level actually engages thinking. That information is not
discoverable from the catalog — it has to be probed by sending real requests.
This skill is that probe.

The output is a `thinkingLevelMap` + `reasoning`/`compat` config that drops
straight into a `ProviderModelConfig` in the extension's static model list.

## When to run this

- **Adding a model to a static provider list.** Before committing the entry,
  probe it so the `thinkingLevelMap` reflects what the gateway actually accepts.
  A wrong map either hides working levels (the xhigh bug) or sends values the
  API rejects.
- **The `session_start` missing-models check fired.** It surfaced new ids the
  static list doesn't know about. Probe each new id before adding it.
- **A thinking level is missing or a no-op.** If `xhigh`/`high` doesn't appear,
  or appears but doesn't change behavior, the map or `supportsReasoningEffort`
  is wrong. Probe to find the truth.
- **Validating a third-party extension's config.** Published `thinkingLevelMap`
  values go stale (see Lessons). Probe rather than copy.

## Running the probe

The skill ships a stdlib-only Python script — no dependencies, runs anywhere
with `python3`:

```bash
cd /path/to/repo
export SYNTHETIC_API_KEY=syn_...
.pi/skills/probe-model/scripts/probe_model.py hf:zai-org/GLM-5.2
```

For a non-synthetic OpenAI-compatible provider, pass `--base-url` and `-k`:

```bash
.pi/skills/probe-model/scripts/probe_model.py some-model-id \
  --base-url https://provider.example.com/v1 -k $PROVIDER_KEY
```

The script prints the catalog entry, an enum-acceptance table, a disable +
engagement check, and a suggested config block.

## Reading the output

**Enum acceptance table** — one row per `reasoning_effort` value plus an
omitted baseline:

```
effort     http   signals
none       200    rt=0    none=0    <- accepted, no thinking
medium     200    rt=49   rc=160    <- accepted, thinking engaged
max        400    [object Object] failed...   <- REJECTED by gateway
```

- **HTTP 200** = the gateway accepts that value. Add it to the map.
- **HTTP 400 with an enum-validation error** = rejected. Map it to `null` (hide
  it in pi) or remap to an accepted value.
- **5xx "No targets available" / similar** = the inference backend is down, not
  an enum rejection. Retry later before concluding anything about that level.

`rt` is `usage.reasoning_tokens` (billed thinking). The other column shows the
length of the thinking text block tagged with the field that carried it:
`rc`=`reasoning_content`, `r`=`reasoning`, `rtx`=`reasoning_text`, `none=0`
when no reasoning field is populated. A level "engages thinking" when **either**
`rt` or the reasoning length is greater than zero — see the Signals section for
why both matter and why the field varies by provider.

**Disable + engagement check** — sends `none` and `high` against a reasoning
prompt:

```
none:  rt=0     none=0    -> thinks=False
high:  rt=301   rc=804    -> thinks=True
```

- `none` → `thinks=False`: thinking can be disabled. Map `off: "none"`.
- `none` → `thinks=True`: thinking is always on. Map `off: null` so pi hides
  the off level instead of sending a value the model ignores.

## Turning results into config

The default, correct-for-most-models outcome is the **identity map**: every
accepted pi level maps to itself. Resist the urge to remap levels unless you
have evidence the gateway rejects a value.

```typescript
{
  id: "hf:zai-org/GLM-5.2",
  reasoning: true,
  thinkingLevelMap: {
    off: "none",       // or null if the disable check showed thinks=True at none
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  },
  compat: {
    supportsReasoningEffort: true,   // required, or no effort is sent on the wire
    supportsDeveloperRole: false,
    // ...other provider compat flags
  },
  // ...cost, contextWindow, maxTokens, input
}
```

Non-reasoning models (`reasoning: false`) get no `thinkingLevelMap` at all — pi
only offers `off` for them.

`supportsReasoningEffort: true` is mandatory for any reasoning model whose
thinking you want to control. With it `false`, pi never sends `reasoning_effort`
and the thinking levels shown in the UI are silent no-ops. This was the actual
root-cause bug in the synthetic extension before it went static.

## Signals: reasoning_tokens vs the thinking text block

Two independent signals indicate thinking, and providers are inconsistent about
which they return:

- `usage.reasoning_tokens` — the billed thinking token count. Canonical, but
  some providers omit it entirely from the usage object.
- the thinking text block — returned on `message.reasoning_content` (the
  DeepSeek/llama.cpp convention), `message.reasoning` (e.g. Neuralwatt's vLLM
  gateway), or `message.reasoning_text`. Present on most OpenAI-compatible
  reasoning models, but some include an **empty** string even when not thinking.

The probe checks all three field names — mirroring pi's own openai-completions
provider, which reads reasoning from any of `reasoning_content`, `reasoning`, or
`reasoning_text` and uses the first non-empty one. (Checking only
`reasoning_content` would read providers that think under `reasoning` as never
thinking and produce a wrong `thinkingLevelMap` — that was the original
Neuralwatt failure mode.)

So: count a level as "thinks" when `reasoning_tokens > 0` **or** any reasoning
field is non-empty. Mere presence of a reasoning field is not evidence of
thinking (some models emit an empty one when idle). The script already applies
this rule.

## Lessons (things that have bitten us)

- **`max` is not part of the OpenAI `reasoning_effort` enum.** Providers built
  on that field (synthetic, most OpenAI-compatible gateways) reject literal
  `max` with a 400 enum-validation error. It is a *provider-side* value (e.g.
  the native Z.AI API accepts it; synthetic's OpenAI shim does not). Do not try
  to send `max` through an OpenAI-compatible gateway. The script includes `max`
  as a sentinel precisely to confirm this rejection per provider.

- **Third-party `thinkingLevelMap` values go stale.** The published
  `aliou/pi-synthetic` extension mapped GLM-5.2's `xhigh → "medium"` based on a
  since-corrected assumption that the gateway only accepted low/medium/high and
  that non-`high` values fell through to max. Direct probing showed `xhigh` is
  accepted and produces the deepest reasoning. Trust probe output over copied
  configs.

- **Catalog-advertised reasoning is not always observable.** Some models list
  `reasoning` in `supported_features` but produce no thinking output (across any
  reasoning field) even at `high` effort on a reasoning prompt (Nemotron-3-Super
  through synthetic did this). This is a judgment call, not a bug in the probe:
  we keep `reasoning: true` to match the official catalog rather than
  contradicting it from one prompt, since the gateway still accepts the efforts.
  Note the discrepancy in a code comment so the next person knows the evidence
  is thin.

- **Reasoning can come back under `reasoning`, not just `reasoning_content`.**
  The thinking text block's field name is not standardized. DeepSeek/llama.cpp
  use `reasoning_content`; Neuralwatt's vLLM gateway uses `reasoning`; some use
  `reasoning_text`. The probe checks all three (matching pi's openai-completions
  provider). If engagement reads zero across *every* model on a provider, dump
  one raw response and look for a thinking field under a different name — the
  provider may use a fourth. When that happens, extend `REASONING_FIELDS` in
  the script.

- **Transient backend 5xx is not enum rejection.** "No targets available" means
  the inference backend is down. If every effort returns 5xx for one model but
  200 for others, wait and re-probe before deciding that model's map.

## After probing

1. Add or update the model entry in the extension's static list
   (`extensions/synthetic/synthetic.ts` `STATIC_MODELS`).
2. Paste the script's suggested `thinkingLevelMap` and adjust only where you
   have evidence to.
3. For reasoning models, confirm `compat.supportsReasoningEffort: true`.
4. If you discovered a model whose catalog claims reasoning but the probe shows
   no engagement, leave `reasoning: true` and add a comment noting the evidence.
5. The `session_start` missing-models check will stop warning once the new id is
   in the static list.
