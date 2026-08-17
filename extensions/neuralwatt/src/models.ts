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
 * Verified by probing the gateway (see .pi/skills/probe-model): send each
 * `reasoning_effort` value on a reasoning prompt and check the returned
 * `reasoning` field for thinking output. Two findings drive these maps as of
 * the 2026-08 re-probe:
 *
 *   1. Neuralwatt's gateway accepts `max` for the GLM and Kimi K2.7 family and
 *      it produces deeper reasoning than `xhigh` there. Where accepted, xhigh
 *      maps to `max` so pi's deepest tier engages the deepest thinking. The
 *      probe-model skill warns `max` is usually rejected by OpenAI-compatible
 *      shims; Neuralwatt's vLLM gateway is an exception.
 *   2. No current reasoning model forces always-on thinking: `none` disables
 *      thinking on every model (verified 2026-08, including kimi-k2.7-code and
 *      qwen3.6-35b, which were always-on and restricted in earlier probes).
 *      Every reasoning model here uses an DISABLEABLE_* map with off:"none".
 *
 * The published pi-neuralwatt extension exposes only `medium` for Kimi/Qwen,
 * but that restriction came from probing with the wrong key
 * (`reasoning_content` instead of `reasoning`); direct probing shows low and
 * high are also accepted and engage thinking, so they are exposed here.
 */

// Disableable with identity mapping through xhigh (DeepSeek V4 Flash,
// gemma-4-31b, kimi-k3, qwen3.6-35b).
const DISABLEABLE_IDENTITY_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// Disableable, accepts the full enum including `max` (glm-5.2, glm-5.2-short,
// kimi-k2.7-code, kimi-k2.7-code-fast). xhigh maps to `max` because the
// gateway accepts it and it produces deeper reasoning than `xhigh`.
const DISABLEABLE_FULL_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// --- Static model catalog ---

/**
 * Hardcoded catalog of Neuralwatt's public models (the unauthenticated
 * /v1/models view). Pricing, context windows, and modalities are sourced from
 * the live API's metadata. Reasoning models carry a verified thinkingLevelMap
 * (see the DISABLEABLE map constants below); each map's comment records how
 * that model's levels were probed against the gateway.
 *
 * The GLM, Kimi, and Qwen reasoning/fast pairs share pricing; their "-fast"
 * variants are non-reasoning. Neuralwatt publishes both DeepSeek ids for the
 * same 0731 checkpoint. No reasoning model currently forces always-on thinking
 * (qwen3.6-35b's previous restriction was lifted in 2026-08; see its entry).
 */
export const STATIC_MODELS: ProviderModelConfig[] = [
  // --- Gemma 4 (Google/NVIDIA) ---
  // Catalog metadata reports reasoning:true with reasoning_effort support and
  // effort aliases that route every level to `max`. A direct probe in 2026-08
  // confirmed all efforts are accepted, none disables thinking, and enabled
  // levels emit reasoning, so the identity map through xhigh is correct.
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.144, output: 0.42, cacheRead: 0.0144, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 16384,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- GLM-5.2 (ZhipuAI) ---
  // Probed 2026-08: every effort returns HTTP 200 and `none` produces no
  // thinking, so thinking is disableable. xhigh maps to `max` because the
  // gateway accepts `max` and it produces deeper reasoning than `xhigh`.
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.145, cacheWrite: 0 },
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
    cost: { input: 1.45, output: 4.5, cacheRead: 0.145, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },

  // GLM-5.2 (short) — 200K context variant, same pricing as the 1M glm-5.2.
  // Gateway-acceptance probed 2026-08: accepts the full reasoning_effort enum
  // (none, minimal, low, medium, high, xhigh, max all return HTTP 200), and
  // `none` produces no thinking, so thinking is disableable. Uses the same
  // DISABLEABLE_FULL_MAP as glm-5.2: xhigh maps to `max` for the deepest tier.
  {
    id: "glm-5.2-short",
    name: "GLM-5.2 Short",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.145, cacheWrite: 0 },
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
    cost: { input: 1.45, output: 4.5, cacheRead: 0.145, cacheWrite: 0 },
    contextWindow: 199984,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },

  // --- DeepSeek V4 Flash (DeepSeek) ---
  // Probed 2026-07: every effort (none/minimal/low/medium/high/xhigh/max)
  // returns HTTP 200 and `none` produces no thinking, so thinking is
  // disableable. minimal through xhigh all engage reasoning under the
  // top-level `reasoning` field; the identity map through xhigh is correct.
  // Neuralwatt publishes both ids for the same 0731 checkpoint.
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash 0731 (Canary)",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- Kimi K2.7 / K3 (MoonshotAI) ---
  // kimi-k2.7-code was always-on originally (none still reasoned) but a
  // re-probe in 2026-08 showed `none` now disables thinking, so off maps to
  // "none". The K2.5 ids are hard-deprecated by the gateway (HTTP 410 "has
  // been deprecated"); the K2.5 and K2.6 families no longer appear in
  // /v1/models, so their static entries were removed to mirror the catalog.
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.095, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  // kimi-k2.7-code-fast is the fast sibling of kimi-k2.7-code and now reasons:
  // catalog metadata lists reasoning:true, and a 2026-08 probe showed every
  // effort returns HTTP 200 with `reasoning` output while `none` disables it.
  // Registered as a reasoning model with the same map as its sibling.
  {
    id: "kimi-k2.7-code-fast",
    name: "Kimi K2.7 Code Fast",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.095, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  // Probed 2026-08: none disables thinking and minimal through xhigh all
  // return HTTP 200 with reasoning output, so the identity map is correct.
  // The fast sibling produced no reasoning at high and follows its catalog's
  // reasoning:false metadata.
  {
    id: "kimi-k3",
    name: "Kimi K3",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },
  {
    id: "kimi-k3-fast",
    name: "Kimi K3 Fast",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_COMPAT,
  },

  // --- Qwen (Qwen) ---
  // qwen3.6-35b previously rejected minimal/xhigh/max and kept thinking on at
  // `none` (always-on, restricted map). A 2026-08 re-probe showed the gateway
  // now accepts the full enum (every effort returns HTTP 200) and `none`
  // disables thinking, so the identity map with off:"none" is correct.
  {
    id: "qwen3.6-35b",
    name: "Qwen3.6 35B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.29, output: 1.15, cacheRead: 0.029, cacheWrite: 0 },
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
    cost: { input: 0.29, output: 1.15, cacheRead: 0.029, cacheWrite: 0 },
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
