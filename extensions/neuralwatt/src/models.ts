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
 *   2. Every reasoning model except the glm-5.3 family is disableable: `none`
 *      disables thinking (verified 2026-08 for kimi-k2.7-code and qwen3.6-35b,
 *      which were always-on and restricted in earlier probes, and 2026-09 for
 *      qwen-3.8-27b). glm-5.3 and glm-5.3-flash are the exceptions: their
 *      catalog entries mark reasoning mandatory and the probes show thinking
 *      output even at `none`, so they use ALWAYS_ON_FULL_MAP with off:null.
 *
 * The published pi-neuralwatt extension exposes only `medium` for Kimi/Qwen,
 * but that restriction came from probing with the wrong key
 * (`reasoning_content` instead of `reasoning`); direct probing shows low and
 * high are also accepted and engage thinking, so they are exposed here.
 */

// Disableable with identity mapping through xhigh (DeepSeek V4 Flash,
// gemma-4-31b, kimi-k3, nw-flash, nw-small, qwen3.6-35b, qwen-3.8-27b).
const DISABLEABLE_IDENTITY_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// Disableable, accepts the full enum including `max` (glm-5.2, glm-5.2-short,
// kimi-k2.7-code, kimi-k2.7-code-fast, nw-large). xhigh maps to `max` because
// the gateway accepts it and it produces deeper reasoning than `xhigh`.
const DISABLEABLE_FULL_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// Always-on, accepts the full enum including `max` (glm-5.3, glm-5.3-flash).
// The catalog marks reasoning mandatory and omits `none` from accepted_efforts,
// and the probes show a reasoning block even when `none` is sent, so thinking
// cannot be turned off: off is hidden. xhigh maps to `max` like the other
// full-enum models.
const ALWAYS_ON_FULL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// Disableable with only two real modes (mimo-v2.6-pro). The catalog's
// supported_efforts are just {none, high}; its effort_aliases collapse every
// other level (max/xhigh/medium/low -> high, minimal -> none), and a probe
// across low/medium/high/xhigh showed no behavioral spread. Pi's levels route
// onto the two real modes: minimal behaves like off, and every enabled level
// engages the gateway's `high`.
const DISABLEABLE_BINARY_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
};

// --- Static model catalog ---

/**
 * Hardcoded catalog of Neuralwatt's public models (the unauthenticated
 * /v1/models view). Pricing, context windows, and modalities are sourced from
 * the live API's metadata. Reasoning models carry a verified thinkingLevelMap
 * (see the DISABLEABLE map constants below); each map's comment records how
 * that model's levels were probed against the gateway.
 *
 * The nw-* ids are Neuralwatt's tracking aliases: first-class selectable ids
 * that follow the catalog's current model per size tier and move to a newer
 * model with notice (per the tracking aliases guide). They behave exactly like
 * the model they point at (same defaults, same price); each entry's comment
 * records the underlying model its probe evidence is based on. Re-probe an
 * alias after Neuralwatt announces a move.
 *
 * The GLM-5.2, Kimi, and Qwen3.6 reasoning/fast pairs share pricing; their
 * "-fast" variants are non-reasoning. glm-5.3-flash, deepseek-v4-flash-speed,
 * and deepseek-v4.1-flash-speed are the exceptions: reasoning fast/speed
 * variants. Neuralwatt publishes both DeepSeek V4 Flash ids (and the Speed
 * variant) for the same 0731 checkpoint. The glm-5.3 family (gated glm-5.3 preview,
 * glm-5.3-flash) forces always-on thinking (catalog marks reasoning mandatory;
 * see their entries); every other reasoning model is disableable
 * (qwen3.6-35b's previous restriction was lifted in 2026-08, and qwen-3.8-27b
 * shipped disableable in 2026-09).
 */
export const STATIC_MODELS: ProviderModelConfig[] = [
  // --- Neuralwatt tracking aliases (nw-*) ---
  // nw-large — large tier (catalog: currently Kimi K3; same pricing and
  // limits as the kimi-k3 entry). Probed 2026-10: every effort returns HTTP
  // 200 and `none` produces no thinking, so thinking is disableable. The
  // catalog aliases xhigh -> max (accepted natively by the gateway) plus
  // medium -> high and minimal -> low, so DISABLEABLE_FULL_MAP applies like
  // the other full-enum models.
  {
    id: "nw-large",
    name: "Neuralwatt Large",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // nw-flash — cheap fast tier (catalog: currently DeepSeek V4.1 Flash; same
  // pricing and limits as the deepseek-v4.1-flash entry). Probed 2026-10:
  // every effort returns HTTP 200 and `none` produces no thinking, so
  // thinking is disableable. The catalog aliases medium -> high and
  // minimal -> low but keeps xhigh distinct, and literal `max` returned 200
  // with no reasoning output, so xhigh is the real deepest level and
  // DISABLEABLE_IDENTITY_MAP applies like deepseek-v4.1-flash.
  {
    id: "nw-flash",
    name: "Neuralwatt Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 393216,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // nw-small — small tier (catalog: currently Qwen3.8-27B; same pricing and
  // limits as the qwen-3.8-27b entry). Probed 2026-10: every effort returns
  // HTTP 200 and `none` produces no thinking, so thinking is disableable. The
  // catalog aliases max/high -> xhigh (plus minimal -> low), so xhigh is the
  // gateway's real deepest level and DISABLEABLE_IDENTITY_MAP applies like
  // qwen-3.8-27b.
  {
    id: "nw-small",
    name: "Neuralwatt Small",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 3.2, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 131072,
    compat: NEURALWATT_REASONING_COMPAT,
  },

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

  // GLM-5.3 (gated preview) — same architecture as GLM-5.2 ("weight swap
  // confirmed" per the catalog description) at GLM-5.2 parity pricing and
  // context. Probed 2026-08: every effort returns HTTP 200, but the catalog
  // marks reasoning mandatory, omits `none` from accepted_efforts, and the
  // disable check shows a reasoning block even at `none` (r=735 on the
  // reasoning prompt), so thinking cannot be turned off: off is hidden.
  // xhigh maps to `max`, which the gateway accepts and which produces deeper
  // reasoning than `xhigh`, matching the other GLM entries.
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_FULL_MAP,
    input: ["text"],
    cost: { input: 1.45, output: 4.5, cacheRead: 0.145, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // GLM-5.3 Flash — fast glm5_next sibling of glm-5.3 (exited preview
  // 2026-09-11). Probed 2026-09: every effort including `max` returns HTTP 200
  // with reasoning output, but the catalog marks reasoning mandatory (no
  // `none` in accepted_efforts) and the disable check shows a reasoning block
  // even at `none`, so thinking cannot be turned off: off is hidden. The
  // catalog aliases xhigh -> max, so xhigh maps to `max` like glm-5.3.
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ALWAYS_ON_FULL_MAP,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 65536,
    compat: NEURALWATT_REASONING_COMPAT,
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

  // deepseek-v4-flash-speed — the same 0731 checkpoint as deepseek-v4-flash
  // (identical huggingface_id and pricing) with improved speculative decoding
  // ("Speed" tier). Despite the name it reasons: probed 2026-09, every effort
  // returns HTTP 200 with `reasoning` output and `none` produces no thinking,
  // so thinking is disableable. The catalog aliases xhigh -> max (plus
  // medium/low/minimal -> high), so the gateway's real deepest level is `max`
  // and xhigh maps to `max` like the GLM/Kimi full-enum models.
  {
    id: "deepseek-v4-flash-speed",
    name: "DeepSeek V4 Flash (Speed)",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_FULL_MAP,
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 393216,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- DeepSeek V4.1 Flash (DeepSeek) ---
  // New V4.1 generation: vision-capable MoE with 1M context. Probed 2026-09:
  // every effort returns HTTP 200 and `none` produces no thinking, so thinking
  // is disableable. The catalog aliases medium -> high and minimal -> low but
  // keeps xhigh and max as distinct levels, and the probe showed no benefit
  // routing xhigh to max (xhigh produced the deepest thinking), so the
  // identity map through xhigh is correct.
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 393216,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // deepseek-v4.1-flash-speed — the same DeepSeek-V4.1-Flash checkpoint as
  // deepseek-v4.1-flash (identical huggingface_id, pricing, and vision
  // support) on a "Speed" lane: a dedicated server serving few sessions at
  // the engine's solo decode rate (private preview). Probed 2026-10: every
  // effort returns HTTP 200 and `none` produces no thinking, so thinking is
  // disableable. The catalog aliases medium -> high and minimal -> low but
  // keeps xhigh and max distinct, exactly like deepseek-v4.1-flash. A
  // level-compare probe (2000-token reasoning budget) showed max ~= xhigh
  // (r=8612 vs r=8383, within single-prompt noise and reversed by the
  // truncated enum probe), so there is no evidence to route xhigh -> max and
  // the identity map applies like the V4.1 sibling.
  {
    id: "deepseek-v4.1-flash-speed",
    name: "DeepSeek V4.1 Flash (Speed)",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 393216,
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
  // Probed 2026-09: the full enum is accepted (every effort returns HTTP 200)
  // and `none` disables thinking, so the identity map with off:"none" is
  // correct. The catalog aliases max -> xhigh, so xhigh (not max) is the
  // gateway's real deepest level — identity through xhigh, unlike the
  // GLM/Kimi full-enum models.
  {
    id: "qwen-3.8-27b",
    name: "Qwen3.8 27B",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_IDENTITY_MAP,
    input: ["text", "image"],
    cost: { input: 0.45, output: 3.2, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 262128,
    maxTokens: 131072,
    compat: NEURALWATT_REASONING_COMPAT,
  },

  // --- MiMo (Xiaomi) ---
  // Probed 2026-09: every accepted_effort returns HTTP 200 and `none` produces
  // no thinking, so thinking is disableable. The catalog's supported_efforts
  // are only {none, high} and its aliases collapse every other level onto
  // those two (minimal -> none, low/medium/xhigh/max -> high); a level-compare
  // probe showed no reasoning spread across low/medium/high/xhigh, so the
  // binary map routes pi's levels onto the two real modes. MOPD upgrade of
  // MiMo-V2.6 (sparse MoE, 1.02T total / 42B active) with native vision, tool
  // calling, optional reasoning, and 1M-token context. No fast variant.
  {
    id: "mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: DISABLEABLE_BINARY_MAP,
    input: ["text", "image"],
    cost: { input: 0.87, output: 1.74, cacheRead: 0.036, cacheWrite: 0 },
    contextWindow: 1048560,
    maxTokens: 393216,
    compat: NEURALWATT_REASONING_COMPAT,
  },
];
