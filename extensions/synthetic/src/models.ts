import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderChatModelConfig } from "../../../lib/pi-types.ts";

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
} as const satisfies ProviderChatModelConfig["compat"];

/**
 * Thinking map for reasoning models whose thinking can be disabled. The
 * Synthetic gateway accepts the full pi enum verbatim, so each level passes
 * through by name. The model decides whether lower tiers actually engage
 * thinking (e.g. GLM-5.3-Flash treats none/minimal/low as no thinking).
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
 * Thinking map for models whose thinking cannot be disabled (gpt-oss-120b,
 * GLM-5.3, Kimi-K3.1-Pro). Mapping off to null hides the off level in pi's UI
 * rather than sending a value the model ignores.
 */
const ALWAYS_ON_THINKING_MAP: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// --- Static model catalog ---

/**
 * Hardcoded catalog of always-on Synthetic models with tools support.
 *
 * Pricing is per million tokens, sourced from the authenticated
 * GET /openai/v1/models endpoint (checked 2026-11; syn:large:text and
 * syn:small:vision re-aliased onto DeepSeek-V4.1-Flash-1017 and
 * syn:large:vision onto Kimi-K3.1-Pro, so their rows were updated to
 * match). Thinking maps reflect
 * the gateway's accepted reasoning_effort enum (probed 2026-08): every
 * reasoning model accepts none/minimal/low/medium/high/xhigh; the
 * GLM-5.3-Flash and Qwen3.8-27B probes returned HTTP 200 for the
 * non-OpenAI "max" sentinel (the identity map is kept either way — max is
 * not a pi thinking level and is never sent). Three models always think and
 * cannot be turned off (gpt-oss-120b, GLM-5.3, Kimi-K3.1-Pro), so off maps
 * to null for them.
 *
 * Kimi-K2.7-Code, MiniMax-M3, GLM-5.2, Kimi-K3, Qwen3.6-27B,
 * NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4, and DeepSeek-V4.1-Flash no longer
 * appear in /v1/models, so their static entries were removed.
 *
 * The syn:* ids are first-class selectable models in the Synthetic API (each
 * points at a concrete model behind the scenes) and are registered standalone.
 */
export const STATIC_MODELS: ProviderChatModelConfig[] = [
  // --- syn: aliases (first-class selectable ids) ---
  // Live catalog targets (checked 2026-11): syn:large:text and
  // syn:small:vision alias deepseek-ai/DeepSeek-V4.1-Flash-1017,
  // syn:large:vision aliases moonshotai/Kimi-K3.1-Pro, and syn:small:text
  // aliases zai-org/GLM-4.7-Flash. Pricing from the live catalog.
  {
    id: "syn:large:text",
    name: "syn:large:text",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
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
    cost: { input: 0.1, output: 0.5, cacheRead: 0.02, cacheWrite: 0 },
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
    cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 524288,
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
    cost: { input: 0.6, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- infinite:* aliases (Big subscription tier) ---
  // infinite:small:vision — aliases DeepSeek-V4.1-Flash with vision enabled,
  // billed at $0 per token (included with the Big subscription plan). The
  // catalog declares efforts [none, low, high, xhigh, max], but that field is
  // a tier hint, not a hard enum (GLM-5.3-Flash catalogs [low, high, max] yet
  // accepts every pi level), so the map mirrors the aliased model's 2026-09
  // probe: none disables thinking and every pi level is accepted. A fresh
  // probe of this id is blocked: the gateway returns HTTP 402 "Infinite
  // models require an active Big plan subscription" for lower plans before
  // the effort value is even validated. Infinite models reject non-streaming
  // requests ("Infinite models require streaming"); pi always streams
  // openai-completions requests, so this is transparent in use.
  {
    id: "infinite:small:vision",
    name: "infinite:small:vision",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- Z.AI GLM family ---
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "GLM-4.7-Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 196608,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // GLM-5.3 — full (non-Flash) sibling of GLM-5.3-Flash: text-only, 524K
  // context. Probed 2026-10: every effort is accepted and every enabled level
  // engages thinking, but the catalog flags always_on and the disable check
  // shows thinking even at `none` (rt=301 on the reasoning prompt), so
  // thinking cannot be turned off: off is hidden (unlike GLM-5.3-Flash, whose
  // probe showed `none` disables thinking). No `max` tier to exploit here, so
  // the identity map through xhigh applies.
  {
    id: "hf:zai-org/GLM-5.3",
    name: "GLM-5.3",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_THINKING_MAP,
    input: ["text"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // GLM-5.3 (Flash) — vision-capable, 524K context, Opus-4.8-class. The
  // catalog flags always_on, but the 2026-08 disable check shows none
  // produces no thinking, so off maps to "none"; every pi level is accepted
  // and medium/high/xhigh engage thinking.
  {
    id: "hf:zai-org/GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.04, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },

  // --- Other reasoning models ---
  // Kimi-K3.1-Pro — 2.8T-parameter reasoning model with vision and a 524K
  // context (2.0/10.0 per million). Probed
  // 2026-10: the gateway accepts every pi level and thinking cannot be turned
  // off — `none` still produces thinking (reasoning_tokens=65 on a reasoning
  // prompt), so off is hidden. The thinking block arrives under `reasoning`,
  // not `reasoning_content`. The catalog lists efforts [low, high, max], which
  // is a tier hint: minimal/medium/xhigh are accepted too.
  {
    id: "hf:moonshotai/Kimi-K3.1-Pro",
    name: "Kimi-K3.1-Pro",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // Qwen3.8-27B — small vision-capable coding model. Probed 2026-08: none
  // disables thinking and every pi level is accepted (medium/high/xhigh engage),
  // so the identity map applies despite the catalog's always_on flag.
  {
    id: "hf:Qwen/Qwen3.8-27B",
    name: "Qwen3.8-27B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 2.2, cacheRead: 0.09, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 and the undated
  // DeepSeek-V4.1-Flash were removed likewise.

  // DeepSeek-V4.1-Flash-1017 — dated 10/17 snapshot of DeepSeek-V4.1-Flash;
  // after the undated id left the live catalog (checked 2026-11), this is the
  // only V4.1-Flash id Synthetic serves. Probed 2026-10: none
  // disables thinking and every pi level is accepted (medium/high/xhigh
  // engage), so the identity map applies despite the catalog's always_on flag.
  // Unlike the undated entry, this snapshot returns the thinking block under
  // `reasoning_content`. Catalog advertises image input; a direct vision
  // request succeeds, so input includes image.
  {
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    name: "DeepSeek-V4.1-Flash-1017",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 524288,
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
    cost: { input: 0.1, output: 0.1, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
];
