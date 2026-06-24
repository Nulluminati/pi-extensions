# Synthetic Provider Extension

Registers [Synthetic](https://synthetic.new) as a Pi model provider using their OpenAI-compatible API, with dynamic model discovery, capability detection, cost tracking, and quota display.

## What It Does

This extension registers the "synthetic" provider so you can use Synthetic's hosted models (Kimi-K2.6, MiniMax-M2.5, etc.) directly in Pi. It:

1. **Registers the provider** at load time with a set of fallback models (so Pi can start even if the API is unavailable)
2. **Dynamically fetches live models** on `session_start` and re-registers the provider with up-to-date model metadata
3. **Provides `/synthetic-models`** to list all available models with capabilities and pricing
4. **Provides `/synthetic-quota`** to display current API quota usage

## Usage

### Select a Synthetic model

```
/model synthetic/hf:moonshotai/Kimi-K2.6
```

Or use Pi's model cycling (`Ctrl+M`) to cycle through available models.

### List models

```
/synthetic-models
```

Displays all always-on models with their capabilities (vision, reasoning, tools) and per-million-token pricing.

### Check quota

```
/synthetic-quota
```

Shows subscription usage, rolling 5-hour rate limits, weekly token remaining, search hourly limits, and free tool call counts.

## How It Works

### Provider registration

The extension calls `pi.registerProvider("synthetic", config)` at load time. The `config` includes:

- **`baseUrl`**: `https://api.synthetic.new/openai/v1` — the OpenAI-compatible completions endpoint
- **`apiKey`**: `"SYNTHETIC_API_KEY"` — a literal identifier that Pi's runtime resolves via `auth.json`, environment variables, or CLI flags
- **`api`**: `"openai-completions"` — tells Pi to use the OpenAI completions protocol
- **`models`**: A list of `ProviderModelConfig` objects with id, capabilities, cost, context window, and compat flags

### Fallback models

If the Synthetic API is unreachable during session start, the extension uses a hardcoded list of popular models with known pricing and capabilities:

| Model | Context | Reasoning | Vision | Input/Output Cost |
|-------|---------|-----------|--------|-------------------|
| moonshotai/Kimi-K2.6 | 262K | ✓ | ✓ | $0.95 / $4.00 |
| MiniMaxAI/MiniMax-M2.5 | 191K | ✓ | — | $0.40 / $2.00 |
| nvidia/NVIDIA-Nemotron-3-Super | 262K | ✓ | — | $0.30 / $1.00 |
| zai-org/GLM-5.1 | 197K | ✓ | — | $1.00 / $3.00 |

### Dynamic model discovery

On `session_start`, if an API key is available, the extension:

1. Fetches `GET https://api.synthetic.new/openai/v1/models`
2. Filters for `always_on: true` models that support `tools`
3. Converts each to a `ProviderModelConfig` with:
   - Reasoning detection from `supported_features`
   - Vision detection from `input_modalities`
   - Cost parsing from pricing strings (handles both per-token and per-million formats)
4. Re-registers the provider with the live model list

### Pricing parsing

The Synthetic API returns pricing as strings like `"$0.95"` (per million tokens) or `"$0.00000055"` (per token). The `parsePrice()` function detects which format is used: values below 0.001 are multiplied by 1,000,000 to normalize to per-million-token cost.

### Auth resolution

The extension resolves the API key in order of priority:

1. `ctx.modelRegistry.getApiKeyForProvider("synthetic")` — checks Pi's auth.json and registered providers
2. `process.env.SYNTHETIC_API_KEY` — environment variable fallback

### Model caching

Fetched models are cached in a `WeakMap<ExtensionAPI, SyntheticModel[]>` so the `/synthetic-models` command doesn't re-fetch on every call within the same session.

## Key Design Decisions

- **Fallback models** — Registering the provider at load time with hardcoded models ensures Pi can start and show models in the model selector even if the API is down or no key is configured.
- **`WeakMap` for caching** — Per-instance state that doesn't survive across sessions. Appropriate for transient API data.
- **Only always-on tool-supporting models** — The model list is filtered to `always_on: true` and `supported_features` includes `"tools"`, since Pi requires tool-calling capability.
- **Compat flags** — `SYNTHETIC_COMPAT` sets `maxTokensField: "max_tokens"` and `requiresToolResultName: true` to handle protocol differences with the OpenAI-compatible API.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerProvider("synthetic")` | Registers the provider and its models |
| `pi.registerCommand("synthetic-models")` | Lists models with capabilities and pricing |
| `pi.registerCommand("synthetic-quota")` | Displays API quota usage |
| `pi.on("session_start")` | Dynamic model discovery on session start |
| `pi.on("model_select")` | Notifies when a Synthetic model is selected |
| `ctx.modelRegistry.getApiKeyForProvider()` | Auth resolution from Pi's credential store |
| `ctx.ui.notify()` | Model list and quota display |

## Configuration

Configure your Synthetic API key using one of:

1. **Environment variable**: `export SYNTHETIC_API_KEY=syn_...`
2. **Auth file**: Add to `~/.pi/agent/auth.json`:
   ```json
   { "synthetic": { "type": "api_key", "key": "syn_..." } }
   ```
3. **CLI flag**: `pi --model synthetic/hf:moonshotai/Kimi-K2.6 --api-key syn_...`
