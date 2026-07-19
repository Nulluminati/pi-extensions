/**
 * Synthetic Provider Extension
 *
 * Registers Synthetic (synthetic.new) as a Pi model provider using their
 * OpenAI-compatible API. Ships a hardcoded model catalog so registration is
 * synchronous and thinking levels are configured correctly per model.
 *
 * The model list is validated against the live catalog on session_start: if
 * Synthetic exposes models this extension does not know about, the user is
 * notified so the list can be updated. Pricing and capabilities are stable, so
 * there is no runtime refresh of the static list itself.
 *
 * Auth (choose one):
 *   1. SYNTHETIC_API_KEY environment variable
 *   2. ~/.pi/agent/auth.json: { "synthetic": { "type": "api_key", "key": "syn_..." } }
 *   3. CLI flag: pi --model synthetic/hf:moonshotai/Kimi-K2.6 --api-key syn_...
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig, ThinkingLevelMap } from "pi";

// --- Constants ---

const SYNTHETIC_API_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_MODELS_ENDPOINT = `${SYNTHETIC_API_BASE_URL}/models`;
const SYNTHETIC_QUOTAS_ENDPOINT = "https://api.synthetic.new/v2/quotas";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Compat flags applied to every Synthetic model.
 *
 * supportsReasoningEffort is true because the gateway accepts the OpenAI
 * reasoning_effort enum (none/minimal/low/medium/high/xhigh) for reasoning
 * models. Non-reasoning models simply ignore the parameter.
 */
const SYNTHETIC_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsStrictMode: false,
  supportsUsageInStreaming: false,
  supportsStore: false,
  maxTokensField: "max_tokens",
  requiresToolResultName: true,
} as const satisfies ProviderModelConfig["compat"];

/**
 * Thinking map for reasoning models whose thinking can be disabled. The
 * Synthetic gateway accepts the full pi enum verbatim, so each level passes
 * through by name. The model decides whether lower tiers actually engage
 * thinking (e.g. GLM-5.2 treats none/minimal/low as no thinking).
 */
const DISABLEABLE_THINKING_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Thinking map for MiniMax-M3, whose thinking cannot be disabled. Mapping off
 * to null hides the off level in pi's UI rather than sending a value the model
 * ignores.
 */
const ALWAYS_ON_THINKING_MAP: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// --- Types ---

interface SyntheticCatalogModel {
  id: string;
  always_on?: boolean;
  supported_features?: string[];
}

interface SyntheticModelsResponse {
  data: SyntheticCatalogModel[];
}

interface SyntheticQuotaResponse {
  subscription?: { limit: number; requests: number; renewsAt: string };
  search?: { hourly?: { limit: number; requests: number; renewsAt: string } };
  freeToolCalls?: { limit: number; requests: number; renewsAt: string };
  weeklyTokenLimit?: { nextRegenAt: string; percentRemaining: number };
  rollingFiveHourLimit?: {
    nextTickAt: string;
    tickPercent: number;
    remaining: number;
    max: number;
    limited: boolean;
  };
}

// --- Static model catalog ---

/**
 * Hardcoded catalog of always-on Synthetic models with tools support.
 *
 * Pricing is per million tokens, sourced from the authenticated
 * GET /openai/v1/models endpoint. Thinking maps reflect the gateway's accepted
 * reasoning_effort enum (verified 2026-07): every reasoning model accepts
 * none/minimal/low/medium/high/xhigh and rejects "max". Two models always think
 * and cannot be turned off (MiniMax-M3, gpt-oss-120b), so off maps to null for
 * them.
 *
 * The syn:* ids are first-class selectable models in the Synthetic API (each
 * points at a concrete model behind the scenes) and are registered standalone.
 */
const STATIC_MODELS: ProviderModelConfig[] = [
  // --- syn: aliases (first-class selectable ids) ---
  {
    id: "syn:large:text",
    name: "syn:large:text",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 1.4, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "syn:small:text",
    name: "syn:small:text",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 196608,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "syn:large:vision",
    name: "syn:large:vision",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4, cacheRead: 0.95, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "syn:small:vision",
    name: "syn:small:vision",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 3.6, cacheRead: 0.45, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- Z.AI GLM family ---
  {
    id: "hf:zai-org/GLM-5.2",
    name: "GLM-5.2",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 1.4, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "GLM-4.7-Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 196608,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- Other reasoning models ---
  {
    id: "hf:moonshotai/Kimi-K2.7-Code",
    name: "Kimi-K2.7-Code",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4, cacheRead: 0.95, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "hf:Qwen/Qwen3.6-27B",
    name: "Qwen3.6-27B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 3.6, cacheRead: 0.45, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "hf:MiniMaxAI/MiniMax-M3",
    name: "MiniMax-M3",
    api: "openai-completions",
    reasoning: true,
    // Thinking cannot be disabled for MiniMax-M3; off is hidden.
    thinkingLevelMap: ALWAYS_ON_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.6, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "Nemotron-3-Super-120B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.3, output: 1, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- gpt-oss (reasoning, always on) ---
  {
    id: "hf:openai/gpt-oss-120b",
    name: "gpt-oss-120b",
    api: "openai-completions",
    reasoning: true,
    // The catalog advertises reasoning and the probe confirms it: gpt-oss-120b
    // emits a `reasoning` block on every request including `none`, so thinking
    // cannot be turned off. off is hidden.
    thinkingLevelMap: ALWAYS_ON_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
];

/** Prefix used for the missing-models notice so callers/tests can match it. */
export const MISSING_MODELS_MESSAGE =
  "New Synthetic models available that are not in the static list";

export type { SyntheticModelsResponse };

// --- Utilities ---

function getApiKey(): string | undefined {
  const val = process.env.SYNTHETIC_API_KEY;
  return val ? val.trim() || undefined : undefined;
}

async function getResolvedApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
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
 * Fetch the live catalog (id + always_on + supported_features only) for the
 * startup staleness check. Returns an empty array on any error or missing key
 * so the caller stays silent.
 */
async function fetchCatalog(
  apiKey: string,
  signal?: AbortSignal,
): Promise<SyntheticCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, {
      headers: createAuthHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as SyntheticModelsResponse;
    return data.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compare the live catalog against the static list and return any always-on,
 * tools-capable model ids the static list does not include. This is the only
 * signal we surface to the user — pricing and capability drift are ignored on
 * purpose (they have not changed historically).
 */
function findMissingModels(catalog: SyntheticCatalogModel[]): string[] {
  const known = new Set(STATIC_MODELS.map((m) => m.id));
  const missing: string[] = [];
  for (const m of catalog) {
    if (!m.always_on) continue;
    if (m.supported_features && !m.supported_features.includes("tools")) continue;
    if (!known.has(m.id)) missing.push(m.id);
  }
  return missing;
}

async function fetchQuota(apiKey: string, signal?: AbortSignal): Promise<SyntheticQuotaResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(SYNTHETIC_QUOTAS_ENDPOINT, {
      headers: createAuthHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch quota: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<SyntheticQuotaResponse>;
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

function formatQuotaDisplay(quota: SyntheticQuotaResponse): string {
  const lines: string[] = [];

  if (quota.subscription && (quota.subscription.limit > 0 || quota.subscription.requests > 0)) {
    const pct =
      quota.subscription.limit > 0
        ? ((quota.subscription.requests / quota.subscription.limit) * 100).toFixed(1)
        : "0";
    lines.push(
      `Subscription: ${quota.subscription.requests}/${quota.subscription.limit} requests (${pct}% used)`,
    );
  }

  if (quota.rollingFiveHourLimit) {
    const r = quota.rollingFiveHourLimit;
    const status = r.limited ? "LIMITED" : "available";
    lines.push(`Rolling 5h: ${r.remaining}/${r.max} remaining (${status})`);
  }

  if (quota.weeklyTokenLimit) {
    const w = quota.weeklyTokenLimit;
    lines.push(`Weekly tokens: ${w.percentRemaining.toFixed(1)}% remaining`);
  }

  if (quota.search?.hourly && (quota.search.hourly.limit > 0 || quota.search.hourly.requests > 0)) {
    lines.push(
      `Search hourly: ${quota.search.hourly.requests}/${quota.search.hourly.limit} requests`,
    );
  }

  if (quota.freeToolCalls && (quota.freeToolCalls.limit > 0 || quota.freeToolCalls.requests > 0)) {
    lines.push(
      `Free tool calls: ${quota.freeToolCalls.requests}/${quota.freeToolCalls.limit} requests`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "No quota information available.";
}

// --- Default export ---

export default async function syntheticExtension(pi: ExtensionAPI) {
  // Register the static catalog synchronously. No startup fetch blocks
  // registration, and the list is available even without an API key.
  pi.registerProvider("synthetic", {
    baseUrl: SYNTHETIC_API_BASE_URL,
    apiKey: "$SYNTHETIC_API_KEY",
    api: "openai-completions",
    models: STATIC_MODELS,
  });

  // session_start: best-effort staleness check. Warns (once per session) when
  // the live catalog exposes always-on, tools-capable models the static list
  // does not include. Silent on missing key or network error; never blocks.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const apiKey = await getResolvedApiKey(ctx);
    if (!apiKey) return;
    const catalog = await fetchCatalog(apiKey, ctx.signal);
    const missing = findMissingModels(catalog);
    if (missing.length === 0) return;
    ctx.ui.notify(
      `${MISSING_MODELS_MESSAGE}:\n${missing.map((id) => `  • ${id}`).join("\n")}`,
      "warning",
    );
  });

  // /synthetic-models command
  pi.registerCommand("synthetic-models", {
    description: "Display all available Synthetic models with pricing and capabilities",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const text = formatModelList(STATIC_MODELS);
      ctx.ui.notify(`Synthetic models:\n${text}`, "info");
    },
  });

  // /synthetic-quota command
  pi.registerCommand("synthetic-quota", {
    description: "Display current Synthetic API quota usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const apiKey = await getResolvedApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          "Synthetic API key not configured. Set SYNTHETIC_API_KEY or add to ~/.pi/agent/auth.json.",
          "error",
        );
        return;
      }
      try {
        const quota = await fetchQuota(apiKey, ctx.signal);
        const text = formatQuotaDisplay(quota);
        ctx.ui.notify(`Synthetic quota:\n${text}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Error fetching quota: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Notify when a Synthetic model is selected
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider === "synthetic") {
      const modelName = event.model.name || event.model.id;
      ctx.ui.notify(`Using Synthetic model: ${modelName}`, "info");
    }
  });
}

export { STATIC_MODELS };
