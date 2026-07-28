import type { ProviderModelConfig, ThinkingLevelMap } from "pi";

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

/**
 * Thinking map for Kimi-K3, whose gateway rejects the `medium` effort. Probed
 * 2026-07: the inference backend reports `supported values are ['high', 'low',
 * 'max']` and returns HTTP 500 for `medium`, so medium maps to null (hidden in
 * pi). `none` disables thinking; minimal and low are accepted but do not
 * engage thinking (the model decides whether lower tiers think, like GLM-5.2).
 * high and xhigh both engage reasoning. `max` is also accepted but is not a pi
 * level, so xhigh stays identity-mapped.
 */
const DISABLEABLE_NO_MEDIUM_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: null,
  high: "high",
  xhigh: "xhigh",
};

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
export const STATIC_MODELS: ProviderModelConfig[] = [
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
    id: "hf:moonshotai/Kimi-K3",
    name: "Kimi-K3",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_NO_MEDIUM_MAP,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 3.0, cacheWrite: 0 },
    contextWindow: 524288,
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

export function formatModelList(models: ProviderModelConfig[]): string {
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
