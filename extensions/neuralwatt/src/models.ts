import type { ProviderModelConfig, ThinkingLevelMap } from "pi";

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
export const STATIC_MODELS: ProviderModelConfig[] = [
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

  // --- DeepSeek V4 Flash (DeepSeek) ---
  // Probed 2026-07: every effort (none/minimal/low/medium/high/xhigh/max)
  // returns HTTP 200 and `none` produces no thinking, so thinking is
  // disableable. minimal through xhigh all engage reasoning under the
  // top-level `reasoning` field; the identity map through xhigh is correct.
  // `max` is also accepted (deeper than xhigh) but is not a pi level.
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text"],
    cost: { input: 0.104, output: 0.207, cacheRead: 0.026, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
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
  // Kimi K2.7 Code with thinking disabled — the fast sibling of
  // kimi-k2.7-code. Probed 2026-07: the gateway returns HTTP 200 for every
  // reasoning_effort value but produces no reasoning_tokens and no thinking
  // text block even at `high` on a reasoning prompt, confirming it is a
  // non-reasoning model. Mirrors kimi-k2.6-fast: shares the reasoning sibling's
  // pricing and context window, and carries no thinkingLevelMap (pi only offers
  // `off` for non-reasoning models).
  {
    id: "kimi-k2.7-code-fast",
    name: "Kimi K2.7 Code Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.2375, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
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
