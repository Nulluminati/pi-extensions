# Synthetic Provider Extension

Registers [Synthetic](https://synthetic.new) as a Pi model provider using their OpenAI-compatible API, with dynamic model discovery, capability detection, cost tracking, and quota display.

## What It Does

This extension registers the "synthetic" provider so you can use Synthetic's hosted models (Kimi-K2.7-Code, MiniMax-M3, etc.) directly in Pi. It:

1. **Registers the provider** at load time with a static catalog of always-on models (so Pi can start even if the API is unavailable)
2. **Checks for staleness** on `session_start` and notifies you when the live catalog exposes models the static list does not know about
3. **Provides `/synthetic:models`** to list all available models with capabilities and pricing
4. **Provides `/synthetic:quota`** to display current API quota usage

## Usage

### Select a Synthetic model

```
/model synthetic/hf:moonshotai/Kimi-K2.7-Code
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

The extension ships a hardcoded list of always-on, tools-capable models with known pricing and capabilities (priced per million tokens):

| Model | Context | Reasoning | Vision | Input/Output Cost |
|-------|---------|-----------|--------|-------------------|
| moonshotai/Kimi-K2.7-Code | 262K | ✓ | ✓ | $0.95 / $4.00 |
| zai-org/GLM-5.2 | 524K | ✓ | — | $1.40 / $4.40 |
| MiniMaxAI/MiniMax-M3 | 262K | ✓ (always on) | ✓ | $0.60 / $1.20 |
| nvidia/NVIDIA-Nemotron-3-Super | 262K | ✓ | — | $0.30 / $1.00 |
| openai/gpt-oss-120b | 131K | ✓ (always on) | — | $0.10 / $0.10 |

Two models (`MiniMax-M3`, `gpt-oss-120b`) always think and cannot be turned off, so the `off` thinking level is hidden for them. Every other reasoning model accepts the full `none`/`minimal`/`low`/`medium`/`high`/`xhigh` enum.

### Startup staleness check

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
2. **Auth file**: Add to `~/.pi/agent/auth.json`:
   ```json
   { "synthetic": { "type": "api_key", "key": "syn_..." } }
   ```
3. **CLI flag**: `pi --model synthetic/hf:moonshotai/Kimi-K2.7-Code --api-key syn_...`
