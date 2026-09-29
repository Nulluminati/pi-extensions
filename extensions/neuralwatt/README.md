# Neuralwatt Provider Extension

Registers [Neuralwatt](https://neuralwatt.com) as a Pi model provider using their OpenAI-compatible API. Ships a static model catalog, a startup staleness check against the public `/v1/models` list, and commands for listing models and checking quota (including energy usage).

## What It Does

Registers the `neuralwatt` provider so you can use Neuralwatt's hosted open-source models (DeepSeek V4 Flash, DeepSeek V4 Flash (Speed), DeepSeek V4.1 Flash, Gemma 4, GLM-5.2/5.3, Kimi K2.7/K3, MiMo-V2.6-Pro, and Qwen3.6/3.8) in Pi. It:

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
| deepseek-v4-flash-speed | 1M | yes | — | $0.14 / $0.28 |
| deepseek-v4.1-flash | 1M | yes | yes | $0.15 / $0.60 |
| gemma-4-31b | 256K | yes | yes | $0.144 / $0.42 |
| glm-5.2 | 1M | yes | — | $1.45 / $4.50 |
| glm-5.2-fast | 1M | no | — | $1.45 / $4.50 |
| glm-5.2-short | 200K | yes | — | $1.45 / $4.50 |
| glm-5.2-short-fast | 200K | no | — | $1.45 / $4.50 |
| glm-5.3 | 1M | yes | — | $1.45 / $4.50 |
| glm-5.3-flash | 1M | yes | yes | $0.15 / $0.50 |
| kimi-k2.7-code | 256K | yes | yes | $0.95 / $4.00 |
| kimi-k2.7-code-fast | 256K | yes | yes | $0.95 / $4.00 |
| kimi-k3 | 1M | yes | yes | $3.00 / $15.00 |
| kimi-k3-fast | 1M | no | yes | $3.00 / $15.00 |
| mimo-v2.6-pro | 1M | yes | yes | $0.87 / $1.74 |
| qwen3.6-35b | 128K | yes | yes | $0.29 / $1.15 |
| qwen3.6-35b-fast | 128K | no | yes | $0.29 / $1.15 |
| qwen-3.8-27b | 256K | yes | yes | $0.45 / $3.20 |

The GLM-5.2, Kimi, and Qwen3.6 reasoning models pair with `-fast` non-reasoning variants that share pricing. `glm-5.3-flash` is the exception: a reasoning fast variant (exited preview 2026-09-11) with native vision at its own pricing. `glm-5.3` remains a gated preview at GLM-5.2 parity pricing with no fast variant, and `qwen-3.8-27b` is a dense VL model with no fast variant. Neuralwatt publishes the base and canary DeepSeek V4 Flash ids for the same 0731 checkpoint. The Speed tier uses that checkpoint with speculative decoding. DeepSeek V4.1 Flash has vision and separate pricing. Gemma has no listed fast variant; its catalog metadata lists reasoning support and direct probes confirm levels through `xhigh` are accepted and `none` disables it. Flex siblings are not separate entries because `/neuralwatt:flex` selects that service tier without changing the model id. The K2.5 and K2.6 families were removed from `/v1/models` (K2.5 ids now return HTTP 410 "has been deprecated"), and Qwen3.5 dropped from the catalog, so their entries were removed to mirror the live list.

### Startup staleness check

On `session_start`, if a Neuralwatt key is configured, the extension fetches the unauthenticated `/v1/models` view. When the live catalog contains selectable models the static list lacks, Pi shows a warning once per session. `-flex` siblings are ignored because the flex toggle already represents them. The check is silent on network error and never blocks.

### Auth resolution

The key is resolved in this order:

1. `ctx.modelRegistry.getApiKeyForProvider("neuralwatt")` (Pi's auth.json and registered providers)
2. `process.env.NEURALWATT_API_KEY`

## Thinking levels

Reasoning models carry per-model `thinkingLevelMap` values verified by probing the gateway (see `.pi/skills/probe-model`). Two findings drive the maps as of the 2026-09 probe:

- Neuralwatt's gateway accepts `max` for the GLM and Kimi K2.7 families, and it produces deeper reasoning than `xhigh` there. Where accepted, `xhigh` maps to `max` so pi's deepest tier engages the deepest thinking.
- Every reasoning model is disableable except the glm-5.3 family: `none` turns thinking off (verified 2026-08 for kimi-k2.7-code and qwen3.6-35b, which were always-on in earlier probes, and 2026-09 for qwen-3.8-27b). glm-5.3's catalog entry marks reasoning mandatory and the probe shows thinking output even at `none`, so its `off` level is hidden; glm-5.3-flash behaves the same (probed 2026-09).

| Model | off | minimal | low | medium | high | xhigh |
|-------|-----|---------|-----|--------|------|-------|
| deepseek-v4-flash | none | minimal | low | medium | high | xhigh |
| deepseek-ai/DeepSeek-V4-Flash | none | minimal | low | medium | high | xhigh |
| deepseek-v4-flash-speed | none | minimal | low | medium | high | max |
| deepseek-v4.1-flash | none | minimal | low | medium | high | xhigh |
| gemma-4-31b | none | minimal | low | medium | high | xhigh |
| glm-5.2 | none | minimal | low | medium | high | max |
| glm-5.2-short | none | minimal | low | medium | high | max |
| glm-5.3 | — | minimal | low | medium | high | max |
| glm-5.3-flash | — | minimal | low | medium | high | max |
| kimi-k2.7-code | none | minimal | low | medium | high | max |
| kimi-k2.7-code-fast | none | minimal | low | medium | high | max |
| kimi-k3 | none | minimal | low | medium | high | xhigh |
| mimo-v2.6-pro | none | none | high | high | high | high |
| qwen3.6-35b | none | minimal | low | medium | high | xhigh |
| qwen-3.8-27b | none | minimal | low | medium | high | xhigh |

qwen-3.8-27b's catalog aliases `max -> xhigh`, so `xhigh` is its real deepest level; glm-5.3 and glm-5.3-flash alias `xhigh -> max`. mimo-v2.6-pro supports only two real modes: its catalog `supported_efforts` are `none` and `high`, and its aliases collapse every other level (`minimal -> none`, `low`/`medium`/`xhigh`/`max -> high`), so pi's levels route onto those two modes and `minimal` behaves like `off`.

Neuralwatt returns thinking under a top-level `reasoning` field, not `reasoning_content`. Pi's openai-completions provider reads reasoning from any of `reasoning_content`, `reasoning`, or `reasoning_text`, so thinking parses and replays correctly with no special compat flag. `compat.supportsReasoningEffort` is `true` on every reasoning model so pi sends `reasoning_effort` on the wire.

The published pi-neuralwatt extension exposes only `medium` for Kimi/Qwen, but that restriction came from probing with the wrong key (`reasoning_content` instead of `reasoning`). Direct probes show the other listed levels are accepted and engage thinking. To re-verify a model after API changes:

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
| `pi.on("session_start")` | Public-catalog staleness check and flex-capable model discovery |
| `pi.on("before_provider_request")` | Adds `service_tier: "flex"` to requests when flex is enabled for the model |
| `pi.on("model_select")` | Notifies when a Neuralwatt model is selected and updates the flex badge |
| `pi.events.emit(FLEX_EVENT)` | Publishes flex state to the status bar |
| `ctx.modelRegistry.getApiKeyForProvider()` | Auth resolution from Pi's credential store |
| `ctx.ui.notify()` | Model list and quota display |

## Configuration

Configure your Neuralwatt API key with one of:

1. Environment variable: `export NEURALWATT_API_KEY=...`
2. Auth file: add to `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`):
   ```json
   { "neuralwatt": { "type": "api_key", "key": "..." } }
   ```
3. CLI flag: `pi --model neuralwatt/glm-5.2 --api-key ...`
