# Synthetic Provider Extension

Registers [Synthetic](https://synthetic.new) as a Pi model provider using their OpenAI-compatible API. It ships a static model catalog with pricing and capabilities, warns when the live catalog gains new models, and displays quota usage.

## What It Does

This extension registers the "synthetic" provider so you can use Synthetic's hosted models (GLM-5.2, Kimi-K3, Kimi-K3.1-Pro, gpt-oss-120b, etc.) directly in Pi. It:

1. **Registers the provider** at load time with a static catalog of always-on models (so Pi can start even if the API is unavailable)
2. **Checks for staleness** on `session_start` and notifies you when the live catalog exposes models the static list does not know about
3. **Provides `/synthetic:models`** to list all available models with capabilities and pricing
4. **Provides `/synthetic:quota`** to display current API quota usage

## Usage

### Select a Synthetic model

```
/model synthetic/hf:zai-org/GLM-5.2
```

Or use Pi's model cycling (`Ctrl+M`) to cycle through available models.

### List models

```
/synthetic:models
```

Displays all always-on models with their capabilities (vision, reasoning, tools) and per-million-token pricing.

### Check quota

```
/synthetic:quota
```

Shows subscription usage, rolling 5-hour rate limits, weekly token remaining, search hourly limits, and free tool call counts.

## How It Works

### Provider registration

The extension calls `pi.registerProvider("synthetic", config)` at load time. The `config` includes:

- **`baseUrl`**: `https://api.synthetic.new/openai/v1` — the OpenAI-compatible completions endpoint
- **`apiKey`**: `"SYNTHETIC_API_KEY"` — a literal identifier that Pi's runtime resolves via `auth.json`, environment variables, or CLI flags
- **`api`**: `"openai-completions"` — tells Pi to use the OpenAI completions protocol
- **`models`**: A list of `ProviderModelConfig` objects with id, capabilities, cost, context window, and compat flags

### Static model catalog

The extension ships a hardcoded list of always-on, tools-capable models with known pricing and capabilities (priced per million tokens, sourced from the live catalog). The table lists registered ids exactly as the live catalog reports them: `syn:` ids are first-class Synthetic catalog entries, and the rest carry the `hf:` prefix.

| Model | Context | Reasoning | Vision | Input/Output Cost |
|-------|---------|-----------|--------|-------------------|
| syn:large:text | 524K | ✓ | — | $1.00 / $3.00 |
| syn:small:text | 196K | ✓ | — | $0.10 / $0.50 |
| syn:large:vision | 524K | ✓ | ✓ | $3.00 / $15.00 |
| syn:small:vision | 262K | ✓ | ✓ | $0.45 / $2.20 |
| hf:zai-org/GLM-5.2 | 524K | ✓ | — | $1.00 / $3.00 |
| hf:zai-org/GLM-5.3 | 524K | ✓ (always on) | — | $1.40 / $4.40 |
| hf:zai-org/GLM-5.3-Flash | 524K | ✓ | ✓ | $0.15 / $0.50 |
| hf:zai-org/GLM-4.7-Flash | 196K | ✓ | — | $0.10 / $0.50 |
| hf:moonshotai/Kimi-K3 | 524K | ✓ | ✓ | $3.00 / $15.00 |
| hf:moonshotai/Kimi-K3.1-Pro | 524K | ✓ (always on) | ✓ | $2.00 / $10.00 |
| hf:Qwen/Qwen3.6-27B | 262K | ✓ | ✓ | $0.45 / $2.20 |
| hf:Qwen/Qwen3.8-27B | 262K | ✓ | ✓ | $0.45 / $2.20 |
| hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 | 262K | ✓ | — | $0.30 / $1.00 |
| hf:deepseek-ai/DeepSeek-V4.1-Flash | 524K | ✓ | — | $0.80 / $1.20 |
| hf:deepseek-ai/DeepSeek-V4.1-Flash-1017 | 524K | ✓ | ✓ | $0.60 / $1.20 |
| hf:openai/gpt-oss-120b | 131K | ✓ (always on) | — | $0.10 / $0.10 |

Two models (`gpt-oss-120b`, `GLM-5.3`) plus `Kimi-K3.1-Pro` always think and cannot be turned off, so their `off` thinking level is hidden. Every other reasoning model accepts the full `none`/`minimal`/`low`/`medium`/`high`/`xhigh` enum. The `Kimi-K3.1-Pro` probe showed `none` still produces reasoning tokens, so `off` maps to `null` for it. Its catalog entry lists only the efforts `[low, high, max]`, but the gateway accepts `minimal` and `medium` too. GLM-5.3-Flash, Qwen3.8-27B, and the DeepSeek-V4.1-Flash snapshots carry an `always_on` flag in the catalog, but probing shows `none` still disables thinking on all of them, so they get the normal `off: "none"` map (the full GLM-5.3 behaves the opposite way: its probe shows thinking even at `none`). Synthetic serves both DeepSeek-V4.1-Flash ids (the undated model and the 10/17 snapshot), so both stay registered. `Kimi-K2.7-Code` and `MiniMax-M3` were retired by Synthetic (HTTP 404 "no longer supported") and are no longer listed.

### Startup staleness check

On `session_start`, the extension compares the live catalog against the static list. The check is best effort and runs in the background: the handler resolves the API key and returns, so startup does not wait for the network. The warning arrives when the fetch settles, at worst one timeout after startup.

1. Skip when there is no UI or no resolved API key.
2. Fetch `GET https://api.synthetic.new/openai/v1/models` with the key (15 second timeout). A network error or non-OK response skips the warning and logs one `console.debug` diagnostic containing the provider and the error or HTTP status; no UI warning is shown for a failed check.
3. Filter the live catalog to models with `always_on: true` and `"tools"` in `supported_features`, since Pi requires tool calling.
4. Send one warning notification listing the filtered ids the static list does not include.

### Auth resolution

The extension resolves the API key in order of priority:

1. `ctx.modelRegistry.getApiKeyForProvider("synthetic")` — checks Pi's auth.json and registered providers
2. `process.env.SYNTHETIC_API_KEY` — environment variable fallback

### Model caching

Fetched catalog data (for the staleness check) is requested fresh on `session_start`; `/synthetic:models` reads directly from the static list, so no caching is needed.

## Key Design Decisions

- **Static catalog** — Registering the provider at load time with a hardcoded model list ensures Pi can start and show models in the model selector even if the API is down or no key is configured. Pricing and capabilities are stable, so there is no runtime refresh of the list itself.
- **Staleness check, not refresh** — `session_start` only warns when the live catalog exposes always-on, tools-capable models the static list does not include. It never silently rewrites the list.
- **Only always-on tool-supporting models** — The catalog is filtered to `always_on: true` and `supported_features` includes `"tools"`, since Pi requires tool-calling capability.
- **Compat flags** — `SYNTHETIC_COMPAT` sets `maxTokensField: "max_tokens"` and `requiresToolResultName: true` to handle protocol differences with the OpenAI-compatible API.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerProvider("synthetic")` | Registers the provider and its models |
| `pi.registerCommand("synthetic:models")` | Lists models with capabilities and pricing |
| `pi.registerCommand("synthetic:quota")` | Displays API quota usage |
| `pi.on("session_start")` | Startup staleness check against the live catalog |
| `pi.on("model_select")` | Notifies when a Synthetic model is selected |
| `ctx.modelRegistry.getApiKeyForProvider()` | Auth resolution from Pi's credential store |
| `ctx.ui.notify()` | Model list and quota display |

## Configuration

Configure your Synthetic API key using one of:

1. **Environment variable**: `export SYNTHETIC_API_KEY=syn_...`
2. **Auth file**: Add to `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`):
   ```json
   { "synthetic": { "type": "api_key", "key": "syn_..." } }
   ```
3. **CLI flag**: `pi --model synthetic/hf:zai-org/GLM-5.2 --api-key syn_...`
