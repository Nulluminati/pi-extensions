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
 * Thinking map for models whose thinking cannot be disabled (gpt-oss-120b,
 * GLM-5.3). Mapping off to null hides the off level in pi's UI rather than
 * sending a value the model ignores.
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
 * GET /openai/v1/models endpoint (verified 2026-08; GLM-5.2 dropped 1.4/4.4 to
 * 1.0/3.0 and syn:large:vision re-aliased onto Kimi-K3). Thinking maps reflect
 * the gateway's accepted reasoning_effort enum (probed 2026-08): every
 * reasoning model accepts none/minimal/low/medium/high/xhigh; the 2026-08
 * probes of GLM-5.2 and Kimi-K3 rejected the non-OpenAI "max" sentinel, while
 * the GLM-5.3-Flash and Qwen3.8-27B probes returned HTTP 200 for it (the
 * identity map is kept either way — max is not a pi thinking level and is
 * never sent). Two models always think and cannot be turned off
 * (gpt-oss-120b, Kimi-K3.1-Pro), so off maps to null for them. Kimi-K3 briefly
 * rejected `medium` (probed 2026-07) but the 2026-08 probe shows it accepted
 * again, so the full identity map applies.
 *
 * Kimi-K2.7-Code and MiniMax-M3 no longer appear in /v1/models and return
 * HTTP 404 "no longer supported", so their static entries were removed.
 *
 * The syn:* ids are first-class selectable models in the Synthetic API (each
 * points at a concrete model behind the scenes) and are registered standalone.
 */
export const STATIC_MODELS: ProviderChatModelConfig[] = [
  // --- syn: aliases (first-class selectable ids) ---
  // syn:large:* currently alias GLM-5.2 and Kimi-K3 respectively; pricing
  // from the live catalog (2026-08).
  {
    id: "syn:large:text",
    name: "syn:large:text",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 1.0, output: 3.0, cacheRead: 0.16, cacheWrite: 0 },
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
    cost: { input: 3.0, output: 15.0, cacheRead: 0.45, cacheWrite: 0 },
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
    cost: { input: 0.45, output: 2.2, cacheRead: 0.09, cacheWrite: 0 },
    contextWindow: 262144,
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
    id: "hf:zai-org/GLM-5.2",
    name: "GLM-5.2",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 1.0, output: 3.0, cacheRead: 0.16, cacheWrite: 0 },
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
  // produces no thinking, so off maps to "none" (same pattern as GLM-5.2);
  // every pi level is accepted and medium/high/xhigh engage thinking.
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
  // Kimi-K3 briefly rejected `medium` (probed 2026-07) but the 2026-08 probe
  // shows the gateway accepts the full enum again with medium engaging
  // thinking, so the identity map applies.
  {
    id: "hf:moonshotai/Kimi-K3",
    name: "Kimi-K3",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.45, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // Kimi-K3.1-Pro — 2.8T-parameter sibling of Kimi-K3 with vision and a 524K
  // context, priced below it (2.0/10.0 versus 3.0/15.0 per million). Probed
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
  {
    id: "hf:Qwen/Qwen3.6-27B",
    name: "Qwen3.6-27B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 2.2, cacheRead: 0.09, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // Qwen3.8-27B — small vision-capable coding model at the same specs and
  // pricing as Qwen3.6-27B. Probed 2026-08: none disables thinking and every
  // pi level is accepted (medium/high/xhigh engage), so the identity map
  // applies despite the catalog's always_on flag.
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
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "Nemotron-3-Super-120B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.3, output: 1, cacheRead: 0.06, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // DeepSeek-V4.1-Flash — probed 2026-09: none disables thinking and every pi
  // level is accepted (medium/high/xhigh engage), so the identity map applies
  // despite the catalog's always_on flag. The gateway returns the thinking
  // block under `reasoning` rather than DeepSeek's usual `reasoning_content`.
  {
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
    name: "DeepSeek-V4.1-Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_THINKING_MAP,
    input: ["text"],
    cost: { input: 0.8, output: 1.2, cacheRead: 0.16, cacheWrite: 0 },
    contextWindow: 524288,
    maxTokens: 65536,
    compat: SYNTHETIC_COMPAT,
  },
  // DeepSeek-V4.1-Flash-1017 — dated 10/17 snapshot of DeepSeek-V4.1-Flash.
  // Synthetic serves both ids, so both stay registered. Probed 2026-10: none
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

  // DeepSeek-V4.1-Flash-1017 — dated 10/17 snapshot of DeepSeek-V4.1-Flash.
  // Synthetic serves both ids, so both stay registered. Probed 2026-10: none
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
