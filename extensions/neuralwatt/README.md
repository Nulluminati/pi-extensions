# Neuralwatt Provider Extension

Registers [Neuralwatt](https://neuralwatt.com) as a Pi model provider using their OpenAI-compatible API. Ships a static model catalog, a startup staleness check against the public `/v1/models` list, and commands for listing models and checking quota (including energy usage).

## What It Does

Registers the `neuralwatt` provider so you can use Neuralwatt's hosted open-source models (DeepSeek V4 Flash, Gemma 4, GLM-5.2, Kimi K2.5/K2.6/K2.7/K3, and Qwen3.5/3.6) in Pi. It:

1. Registers the provider at load time with a hardcoded catalog of public models, so Pi starts even when the API is unreachable or no key is configured.
2. On `session_start`, fetches the public `/v1/models` view and warns when Neuralwatt publishes models the static list lacks.
3. `/neuralwatt:models` lists every model with capabilities and pricing.
4. `/neuralwatt:quota` shows credit balance, monthly usage (cost, requests, tokens, energy in kWh), and subscription or key-allowance details.

## Usage

Select a model:

```
/model neuralwatt/glm-5.2
```

List models:

```
/neuralwatt:models
```

Check quota:

```
/neuralwatt:quota
```

## How It Works

### Provider registration

`pi.registerProvider("neuralwatt", config)` runs at load time. The config sets:

- `baseUrl`: `https://api.neuralwatt.com/v1`, the OpenAI-compatible endpoint
- `apiKey`: `$NEURALWATT_API_KEY`, which Pi resolves from auth.json, the environment, or CLI flags
- `api`: `openai-completions`
- `authHeader: true`, so Pi sends `Authorization: Bearer <key>`
- `headers`: `Referer` and `X-Title`, which Neuralwatt's gateway uses for client attribution (same convention as OpenRouter)
- `models`: the static catalog

### Static catalog

The catalog comes from Neuralwatt's `/v1/models` metadata. Pricing is per million tokens.

| Model | Context | Reasoning | Vision | In / Out (per 1M) |
|-------|---------|-----------|--------|--------------------|
| deepseek-v4-flash | 1M | yes | — | $0.14 / $0.28 |
| deepseek-ai/DeepSeek-V4-Flash | 1M | yes | — | $0.14 / $0.28 |
| gemma-4-31b | 256K | yes* | yes | $0.144 / $0.42 |
| glm-5.2 | 1M | yes | — | $1.45 / $4.50 |
| glm-5.2-fast | 1M | no | — | $1.45 / $4.50 |
| glm-5.2-short | 200K | yes | — | $1.45 / $4.50 |
| glm-5.2-short-fast | 200K | no | — | $1.45 / $4.50 |
| moonshotai/Kimi-K2.5 | 256K | yes | yes | $0.52 / $2.59 |
| kimi-k2.5-fast | 256K | no | yes | $0.52 / $2.59 |
| kimi-k2.6 | 256K | yes | yes | $0.69 / $3.22 |
| kimi-k2.6-fast | 256K | no | yes | $0.69 / $3.22 |
| kimi-k2.7-code | 256K | yes | yes | $0.95 / $4.00 |
| kimi-k2.7-code-fast | 256K | no | yes | $0.95 / $4.00 |
| kimi-k3 | 1M | yes | yes | $3.00 / $15.00 |
| kimi-k3-fast | 1M | no | yes | $3.00 / $15.00 |
| qwen3.5-397b | 256K | yes | — | $0.69 / $4.14 |
| qwen3.5-397b-fast | 256K | no | — | $0.69 / $4.14 |
| qwen3.6-35b | 128K | yes | yes | $0.29 / $1.15 |
| qwen3.6-35b-fast | 128K | no | yes | $0.29 / $1.15 |

The GLM, Kimi, and Qwen reasoning models pair with `-fast` non-reasoning variants that share pricing. Neuralwatt publishes both DeepSeek ids for the same 0731 checkpoint. Gemma has no listed fast variant. Its catalog metadata says reasoning is unsupported, but direct probes found that levels through `xhigh` are accepted, enabled levels emit reasoning, and `none` disables it. Flex siblings are not separate entries because `/neuralwatt:flex` selects that service tier without changing the model id. Legacy ids (for example `glm-5.1`, `moonshotai/Kimi-K2.6`) are not included; add them as aliases if you need backwards compatibility.

### Startup staleness check

On `session_start`, if a Neuralwatt key is configured, the extension fetches the unauthenticated `/v1/models` view. When the live catalog contains selectable models the static list lacks, Pi shows a warning once per session. `-flex` siblings are ignored because the flex toggle already represents them. The check is silent on network error and never blocks.

### Auth resolution

The key is resolved in this order:

1. `ctx.modelRegistry.getApiKeyForProvider("neuralwatt")` (Pi's auth.json and registered providers)
2. `process.env.NEURALWATT_API_KEY`

## Thinking levels

Reasoning models carry per-model `thinkingLevelMap` values verified by probing the gateway (see `.pi/skills/probe-model`). Three findings drove the maps:

- Neuralwatt's gateway accepts `max` for some models, and it produces deeper reasoning than `xhigh` (kimi-k2.6: 933 vs 487 chars). Where accepted, `xhigh` maps to `max` so pi's deepest tier engages the deepest thinking.
- Some models reject `minimal`, `xhigh`, and `max` with HTTP 400 enum errors; those levels are hidden (`null`).
- Some models keep thinking even at `none` and cannot be disabled; for those `off` maps to `null` (hidden).

| Model | off | minimal | low | medium | high | xhigh |
|-------|-----|---------|-----|--------|------|-------|
| deepseek-v4-flash | none | minimal | low | medium | high | xhigh |
| deepseek-ai/DeepSeek-V4-Flash | none | minimal | low | medium | high | xhigh |
| gemma-4-31b | none | minimal | low | medium | high | xhigh |
| glm-5.2 | none | minimal | low | medium | high | max |
| glm-5.2-short | none | minimal | low | medium | high | max |
| qwen3.5-397b | none | minimal | low | medium | high | max |
| kimi-k2.6 | (hidden) | minimal | low | medium | high | max |
| kimi-k2.7-code | (hidden) | minimal | low | medium | high | max |
| kimi-k3 | none | minimal | low | medium | high | xhigh |
| moonshotai/Kimi-K2.5 | (hidden) | minimal | low | medium | high | xhigh |
| qwen3.6-35b | (hidden) | (hidden) | low | medium | high | (hidden) |

Neuralwatt returns thinking under a top-level `reasoning` field, not `reasoning_content`. Pi's openai-completions provider reads reasoning from any of `reasoning_content`, `reasoning`, or `reasoning_text`, so thinking parses and replays correctly with no special compat flag. `compat.supportsReasoningEffort` is `true` on every reasoning model so pi sends `reasoning_effort` on the wire.

The published pi-neuralwatt extension exposes only `medium` for Kimi/Qwen, but that restriction came from probing with the wrong key (`reasoning_content` instead of `reasoning`). Direct probes show the other listed levels are accepted and engage thinking. Kimi K2.5 was re-probed in 2026-07 after its gateway behavior changed: `none` still produced reasoning, while `minimal` and `xhigh` returned HTTP 200. To re-verify a model after API changes:

```bash
.pi/skills/probe-model/scripts/probe_model.py glm-5.2 \
  --base-url https://api.neuralwatt.com/v1 -k $NEURALWATT_API_KEY
```

The probe checks `reasoning_content`, `reasoning`, and `reasoning_text`. Neuralwatt currently returns thinking through `reasoning`.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerProvider("neuralwatt")` | Registers the provider and its models |
| `pi.registerCommand("neuralwatt:flex")` | Toggles the flex pricing tier for the current model |
| `pi.registerCommand("neuralwatt:models")` | Lists models with capabilities and pricing |
| `pi.registerCommand("neuralwatt:quota")` | Displays quota and energy usage |
| `pi.on("session_start")` | Public-catalog staleness check |
| `pi.on("model_select")` | Notifies when a Neuralwatt model is selected |
| `ctx.modelRegistry.getApiKeyForProvider()` | Auth resolution from Pi's credential store |
| `ctx.ui.notify()` | Model list and quota display |

## Configuration

Configure your Neuralwatt API key with one of:

1. Environment variable: `export NEURALWATT_API_KEY=...`
2. Auth file: add to `~/.pi/agent/auth.json`:
   ```json
   { "neuralwatt": { "type": "api_key", "key": "..." } }
   ```
3. CLI flag: `pi --model neuralwatt/glm-5.2 --api-key ...`
