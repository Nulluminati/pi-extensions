/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (neuralwatt.com) as a Pi model provider using their
 * OpenAI-compatible API. Ships a hardcoded model catalog so registration is
 * synchronous, and checks it against the live public /v1/models list on
 * session_start so newly published models can be added.
 *
 * Neuralwatt exposes per-model energy usage (kWh) alongside token pricing; the
 * /neuralwatt-quota command surfaces credits, monthly usage, and (when active)
 * subscription energy quota.
 *
 * Auth (choose one):
 *   1. NEURALWATT_API_KEY environment variable
 *   2. ~/.pi/agent/auth.json: { "neuralwatt": { "type": "api_key", "key": "..." } }
 *   3. CLI flag: pi --model neuralwatt/glm-5.2 --api-key ...
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig, ThinkingLevelMap } from "pi";

// --- Constants ---

const NEURALWATT_API_BASE_URL = "https://api.neuralwatt.com/v1";
const NEURALWATT_MODELS_ENDPOINT = `${NEURALWATT_API_BASE_URL}/models`;
const NEURALWATT_QUOTA_ENDPOINT = `${NEURALWATT_API_BASE_URL}/quota`;
const FETCH_TIMEOUT_MS = 15_000;

// Client attribution headers Neuralwatt's gateway expects (same convention as
// OpenRouter: Referer/X-Title identify the calling app). Sent on every provider
// request and on the catalog fetch.
const NEURALWATT_CLIENT_HEADERS: Record<string, string> = {
  Referer: "https://pi.dev",
  "X-Title": "pi-extensions/neuralwatt",
};

/**
 * Compat flags applied to non-reasoning Neuralwatt models. The gateway accepts
 * max_tokens and does not support the OpenAI developer role.
 */
const NEURALWATT_COMPAT = {
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const satisfies ProviderModelConfig["compat"];

/**
 * Compat flags for reasoning models. supportsReasoningEffort is required for pi
 * to send reasoning_effort on the wire; without it the thinking levels shown in
 * the UI are silent no-ops.
 *
 * requiresReasoningContentOnAssistantMessages is intentionally NOT set.
 * Neuralwatt returns thinking under a top-level `reasoning` field, not
 * `reasoning_content` (verified via streaming and non-streaming requests).
 * Pi's openai-completions provider reads reasoning from any of
 * ["reasoning_content", "reasoning", "reasoning_text"], so the thinking block
 * parses and replays correctly with no flag. The flag would only inject an
 * empty `reasoning_content: ""` on replayed assistant messages, which the API
 * accepts but does not need.
 */
const NEURALWATT_REASONING_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
} as const satisfies ProviderModelConfig["compat"];

/**
 * Thinking maps for reasoning models.
 *
 * Verified 2026-06 by probing the gateway (see .pi/skills/probe-model): send
 * each `reasoning_effort` value on a reasoning prompt and check the returned
 * `reasoning` field for thinking output. Three findings drove these maps:
 *
 *   1. Neuralwatt's gateway accepts `max` for some models and it produces
 *      deeper reasoning than `xhigh` (e.g. kimi-k2.6: 933 vs 487 chars). Where
 *      accepted, xhigh maps to `max` so pi's deepest tier engages the deepest
 *      thinking. The probe-model skill warns `max` is usually rejected by
 *      OpenAI-compatible shims; Neuralwatt's vLLM gateway is an exception.
 *   2. Some models reject `minimal`, `xhigh`, and `max` with HTTP 400 enum
 *      errors. Those levels map to null (hidden in pi).
 *   3. Some models keep thinking even at `none` and cannot be disabled. For
 *      those, off maps to null so pi hides the off level instead of sending a
 *      value the model ignores.
 *
 * The published pi-neuralwatt extension exposes only `medium` for Kimi/Qwen,
 * but that restriction came from probing with the wrong key
 * (`reasoning_content` instead of `reasoning`); direct probing shows low and
 * high are also accepted and engage thinking, so they are exposed here.
 */

// Disableable with identity mapping through xhigh (gemma-4-31b).
const DISABLEABLE_IDENTITY_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// Disableable, accepts the full enum including `max` (glm-5.2, qwen3.5-397b).
const DISABLEABLE_FULL_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// Cannot be disabled, accepts the full enum including `max` (kimi-k2.6,
// kimi-k2.7-code). off is hidden since `none` still produces thinking.
const ALWAYS_ON_FULL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// Cannot be disabled and accepts identity-mapped levels through xhigh
// (moonshotai/Kimi-K2.5). Re-probed in 2026-07 after the gateway behavior
// changed: `none` still produced reasoning, while minimal and xhigh returned
// HTTP 200. Keep xhigh as an identity mapping because the probe found no
// evidence to remap it.
const KIMI_K2_5_MAP: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// Cannot be disabled and rejects minimal/xhigh/max (qwen3.6-35b).
const ALWAYS_ON_RESTRICTED_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
};

// --- Types ---

interface NeuralwattCatalogModel {
  id: string;
  metadata?: {
    deprecated?: boolean;
    pricing?: { pricing_tbd?: boolean };
    capabilities?: { tools?: boolean };
  };
}

interface NeuralwattModelsResponse {
  data: NeuralwattCatalogModel[];
}

interface NeuralwattQuotaResponse {
  snapshot_at?: string;
  balance?: {
    credits_remaining_usd?: number;
    total_credits_usd?: number;
    credits_used_usd?: number;
    accounting_method?: string;
  };
  usage?: {
    current_month?: {
      cost_usd?: number;
      requests?: number;
      tokens?: number;
      energy_kwh?: number;
    };
  };
  limits?: {
    overage_limit_usd?: number | null;
    rate_limit_tier?: string;
  };
  subscription?: {
    plan?: string;
    status?: string;
    billing_interval?: string;
    current_period_end?: string;
    kwh_included?: number;
    kwh_used?: number;
    kwh_remaining?: number;
    in_overage?: boolean;
  } | null;
  key?: {
    name?: string;
    allowance?: {
      limit_usd?: number;
      period?: string;
      spent_usd?: number;
      remaining_usd?: number;
      blocked?: boolean;
    } | null;
  };
}

// --- Static model catalog ---

/**
 * Hardcoded catalog of Neuralwatt's public models (the unauthenticated
 * /v1/models view). Pricing, context windows, and modalities are sourced from
 * the live API's metadata. Reasoning models carry a verified thinkingLevelMap
 * (see the DISABLEABLE and ALWAYS_ON map constants below); each map's comment
 * records how that model's levels were probed against the gateway.
 *
 * The GLM, Kimi, and Qwen reasoning/fast pairs share pricing; their "-fast"
 * variants are non-reasoning. Legacy model ids (e.g. glm-5.1,
 * moonshotai/Kimi-K2.6) are not included — add them as aliases if backwards
 * compatibility is needed.
 */
const STATIC_MODELS: ProviderModelConfig[] = [
  // --- Gemma 4 (Google/NVIDIA) ---
  // The catalog reports reasoning:false and reasoning_effort:false, but two
  // direct probes in 2026-07 showed that efforts through xhigh are accepted,
  // those enabled levels emit `reasoning`, and none disables thinking.
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.144, output: 0.42, cacheRead: 0.036, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 16384,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- GLM-5.2 (ZhipuAI) ---
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "glm-5.2-fast",
    name: "GLM-5.2 Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },

  // GLM-5.2 (short) — 200K context variant, same pricing as the 1M glm-5.2.
  // Private preview; gateway-acceptance probed 2026-06 (see probe-model).
  // Accepts the full reasoning_effort enum (none, minimal, low, medium, high,
  // xhigh, max all return HTTP 200), and `none` produces no thinking, so
  // thinking is disableable. Follows the same DISABLEABLE_FULL_MAP pattern as
  // glm-5.2 / qwen3.5-397b: xhigh maps to `max` for the deepest tier.
  {
    id: "glm-5.2-short",
    name: "GLM-5.2 Short",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 },
    contextWindow: 199984,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "glm-5.2-short-fast",
    name: "GLM-5.2 Short Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 },
    contextWindow: 199984,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },

  // --- Kimi K2.5 / K2.6 / K2.7 (MoonshotAI) ---
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: KIMI_K2_5_MAP,
    input: ["text", "image"],
    cost: { input: 0.52, output: 2.59, cacheRead: 0.13, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "kimi-k2.5-fast",
    name: "Kimi K2.5 Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.52, output: 2.59, cacheRead: 0.13, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 0.69, output: 3.22, cacheRead: 0.1725, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "kimi-k2.6-fast",
    name: "Kimi K2.6 Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.69, output: 3.22, cacheRead: 0.1725, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.2375, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- Qwen (Qwen) ---
  {
    id: "qwen3.5-397b",
    name: "Qwen3.5 397B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 0.69, output: 4.14, cacheRead: 0.1725, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "qwen3.5-397b-fast",
    name: "Qwen3.5 397B Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.69, output: 4.14, cacheRead: 0.1725, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },
  {
    id: "qwen3.6-35b",
    name: "Qwen3.6 35B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_RESTRICTED_MAP,
    input: ["text", "image"],
    cost: { input: 0.29, output: 1.15, cacheRead: 0.0725, cacheWrite: 0 },
    contextWindow: 131056,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "qwen3.6-35b-fast",
    name: "Qwen3.6 35B Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.29, output: 1.15, cacheRead: 0.0725, cacheWrite: 0 },
    contextWindow: 131056,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },
];

/** Prefix used for the missing-models notice so callers/tests can match it. */
export const MISSING_MODELS_MESSAGE =
  "New Neuralwatt models available that are not in the static list";

export type { NeuralwattModelsResponse, NeuralwattQuotaResponse };

// --- Utilities ---

function getApiKey(): string | undefined {
  const val = process.env.NEURALWATT_API_KEY;
  return val ? val.trim() || undefined : undefined;
}

async function getResolvedApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const authKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
    if (authKey) return authKey;
  } catch {
    // Provider not registered yet, ignore.
  }
  return getApiKey();
}

function createAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

/**
 * Fetch the public model catalog from the unauthenticated /v1/models view.
 * Neuralwatt's public list is reachable without a key, so this runs even before
 * credentials are configured. The authenticated view additionally returns
 * hidden/opt-in models, which we do not want to surface here, so no
 * Authorization header is sent. Returns an empty array on any error so the
 * caller stays silent.
 */
async function fetchCatalog(signal?: AbortSignal): Promise<NeuralwattCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(NEURALWATT_MODELS_ENDPOINT, {
      headers: { Accept: "application/json", ...NEURALWATT_CLIENT_HEADERS },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as NeuralwattModelsResponse;
    return data.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compare the live public catalog against the static list and return any
 * non-deprecated, priced model ids the static list does not include. Hidden /
 * opt-in models are not exposed by the unauthenticated view, so they do not
 * trigger false positives here.
 */
function findMissingModels(catalog: NeuralwattCatalogModel[]): string[] {
  const known = new Set(STATIC_MODELS.map((m) => m.id));
  const missing: string[] = [];
  for (const m of catalog) {
    if (m.metadata?.deprecated) continue;
    if (m.metadata?.pricing?.pricing_tbd) continue;
    if (!known.has(m.id)) missing.push(m.id);
  }
  return missing;
}

async function fetchQuota(apiKey: string, signal?: AbortSignal): Promise<NeuralwattQuotaResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(NEURALWATT_QUOTA_ENDPOINT, {
      headers: createAuthHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch quota: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<NeuralwattQuotaResponse>;
  } finally {
    clearTimeout(timeout);
  }
}

function formatModelList(models: ProviderModelConfig[]): string {
  if (models.length === 0) return "No models available.";
  return models
    .map((m) => {
      const caps: string[] = [];
      if (m.input.includes("image")) caps.push("vision");
      if (m.reasoning) caps.push("reasoning");
      caps.push("tools");
      const capStr = ` (${caps.join(", ")})`;
      const price = ` · in $${m.cost.input.toFixed(2)}/out $${m.cost.output.toFixed(2)}`;
      return `  • ${m.id}${capStr}${price}`;
    })
    .join("\n");
}

function formatEnergy(kwh: number | undefined | null): string {
  if (kwh === undefined || kwh === null) return "—";
  return `${kwh.toFixed(4)} kWh`;
}

function formatQuotaDisplay(quota: NeuralwattQuotaResponse): string {
  const lines: string[] = [];

  if (quota.balance && typeof quota.balance.total_credits_usd === "number") {
    const remaining = quota.balance.credits_remaining_usd ?? 0;
    const total = quota.balance.total_credits_usd;
    const pct = total > 0 ? (((total - remaining) / total) * 100).toFixed(1) : "0";
    lines.push(
      `Credits: $${remaining.toFixed(2)} remaining of $${total.toFixed(2)} (${pct}% used)`,
    );
    if (quota.balance.accounting_method) {
      lines.push(`Accounting: ${quota.balance.accounting_method}`);
    }
  }

  if (quota.usage?.current_month) {
    const u = quota.usage.current_month;
    const parts: string[] = [];
    if (typeof u.cost_usd === "number") parts.push(`$${u.cost_usd.toFixed(2)}`);
    if (typeof u.requests === "number") parts.push(`${u.requests} requests`);
    if (typeof u.tokens === "number") parts.push(`${u.tokens.toLocaleString()} tokens`);
    if (parts.length > 0) lines.push(`This month: ${parts.join(" · ")}`);
    if (typeof u.energy_kwh === "number") lines.push(`Energy: ${formatEnergy(u.energy_kwh)}`);
  }

  if (quota.subscription) {
    const s = quota.subscription;
    const parts: string[] = [];
    if (s.plan) parts.push(s.plan);
    if (s.status) parts.push(s.status);
    if (typeof s.kwh_included === "number")
      parts.push(`${s.kwh_used ?? 0}/${s.kwh_included} kWh used`);
    if (s.in_overage) parts.push("in overage");
    if (parts.length > 0) lines.push(`Subscription: ${parts.join(" · ")}`);
    if (s.current_period_end) lines.push(`Period ends: ${s.current_period_end}`);
  }

  if (quota.key?.allowance) {
    const a = quota.key.allowance;
    const parts: string[] = [];
    if (typeof a.spent_usd === "number" && typeof a.limit_usd === "number") {
      parts.push(`$${a.spent_usd.toFixed(2)}/$${a.limit_usd.toFixed(2)} spent`);
    }
    if (a.period) parts.push(a.period);
    if (typeof a.remaining_usd === "number") parts.push(`$${a.remaining_usd.toFixed(2)} left`);
    if (a.blocked) parts.push("BLOCKED");
    lines.push(`Key allowance: ${parts.join(" · ")}`);
  }

  if (quota.limits) {
    const l = quota.limits;
    const parts: string[] = [];
    if (l.rate_limit_tier) parts.push(`tier ${l.rate_limit_tier}`);
    if (typeof l.overage_limit_usd === "number")
      parts.push(`overage $${l.overage_limit_usd.toFixed(2)}`);
    if (parts.length > 0) lines.push(`Limits: ${parts.join(" · ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No quota information available.";
}

// --- Default export ---

export default async function neuralwattExtension(pi: ExtensionAPI) {
  // Register the static catalog synchronously. No startup fetch blocks
  // registration, and the list is available even without an API key.
  pi.registerProvider("neuralwatt", {
    baseUrl: NEURALWATT_API_BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: NEURALWATT_CLIENT_HEADERS,
    models: STATIC_MODELS,
  });

  // session_start: best-effort staleness check against the public catalog.
  // Warns (once per session) when Neuralwatt publishes models the static list
  // does not include. Gated on a configured key so non-Neuralwatt users do not
  // pay a startup fetch; uses the unauthenticated /v1/models view so hidden /
  // opt-in models never produce false positives. Silent on network error; never
  // blocks.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const apiKey = await getResolvedApiKey(ctx);
    if (!apiKey) return;
    const catalog = await fetchCatalog(ctx.signal);
    const missing = findMissingModels(catalog);
    if (missing.length === 0) return;
    ctx.ui.notify(
      `${MISSING_MODELS_MESSAGE}:\n${missing.map((id) => `  • ${id}`).join("\n")}`,
      "warning",
    );
  });

  // /neuralwatt-models command
  pi.registerCommand("neuralwatt-models", {
    description: "Display all available Neuralwatt models with pricing and capabilities",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const text = formatModelList(STATIC_MODELS);
      ctx.ui.notify(`Neuralwatt models:\n${text}`, "info");
    },
  });

  // /neuralwatt-quota command
  pi.registerCommand("neuralwatt-quota", {
    description: "Display current Neuralwatt API quota usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const apiKey = await getResolvedApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          "Neuralwatt API key not configured. Set NEURALWATT_API_KEY or add to ~/.pi/agent/auth.json.",
          "error",
        );
        return;
      }
      try {
        const quota = await fetchQuota(apiKey, ctx.signal);
        const text = formatQuotaDisplay(quota);
        ctx.ui.notify(`Neuralwatt quota:\n${text}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Error fetching quota: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Notify when a Neuralwatt model is selected
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider === "neuralwatt") {
      const modelName = event.model.name || event.model.id;
      ctx.ui.notify(`Using Neuralwatt model: ${modelName}`, "info");
    }
  });
}

export { STATIC_MODELS };
