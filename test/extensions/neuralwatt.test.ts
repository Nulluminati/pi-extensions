import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import neuralwattExtension from "../../extensions/neuralwatt/neuralwatt.ts";
import { MISSING_MODELS_MESSAGE } from "../../extensions/neuralwatt/src/catalog.ts";
import { FETCH_TIMEOUT_MS } from "../../extensions/neuralwatt/src/constants.ts";
import {
  computeFlexState,
  FLEX_EVENT,
  fetchFlexCapableIds,
  injectServiceTier,
} from "../../extensions/neuralwatt/src/flex.ts";
import { STATIC_MODELS } from "../../extensions/neuralwatt/src/models.ts";
import type {
  NeuralwattModelsResponse,
  NeuralwattQuotaResponse,
} from "../../extensions/neuralwatt/src/types.ts";
import { createMockCommandContext, createMockModel } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

function mockModelsResponse(models: unknown[]): Response {
  return { ok: true, json: () => Promise.resolve({ data: models }) } as Response;
}

/**
 * session_start returns before its network checks finish. Wait one macrotask so
 * the background checks settle against the resolved fetch mocks.
 */
function settleStartupChecks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal Model shape for overriding mockCtx.model with a specific id/provider. */
function makeModel(id: string, provider = "neuralwatt") {
  return createMockModel({ id, name: id, provider });
}

// Ids present in the static catalog. Startup check tests use these.
const EXPECTED_MODEL_IDS = [
  "deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-speed",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-speed",
  "gemma-4-31b",
  "glm-5.2",
  "glm-5.2-fast",
  "glm-5.2-short",
  "glm-5.2-short-fast",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k2.7-code",
  "kimi-k2.7-code-fast",
  "kimi-k3",
  "kimi-k3-fast",
  "mimo-v2.6-pro",
  "nw-flash",
  "nw-large",
  "nw-small",
  "qwen-3.8-27b",
  "qwen3.6-35b",
  "qwen3.6-35b-fast",
];

describe("neuralwatt-extension", () => {
  let debugSpy: MockInstance<typeof console.debug>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFetch = vi.fn();
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = mockFetch;
    vi.stubEnv("NEURALWATT_API_KEY", "nw_test_key_123");
    // Default: live public catalog in sync with the static list (no warning).
    mockFetch.mockResolvedValue(mockModelsResponse(STATIC_MODELS));
    // Capture debug diagnostics so failure-path output stays out of the test log.
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/neuralwatt");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["neuralwatt.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(7);
    });
  });

  // --- static list ---

  it("exposes a static list covering every known model id", () => {
    const ids = STATIC_MODELS.map((m) => m.id).sort();
    for (const id of EXPECTED_MODEL_IDS) {
      expect(ids, `static list missing ${id}`).toContain(id);
    }
  });

  it("documents the DeepSeek Speed, V4.1, and MiMo models in the introduction and catalog tables", async () => {
    const readme = await readFile(
      resolve(import.meta.dirname, "../../extensions/neuralwatt/README.md"),
      "utf8",
    );
    const introduction = readme.split("## Usage")[0];
    const catalog = readme.split("### Static catalog")[1]?.split("### Startup staleness check")[0];
    const thinking = readme.split("## Thinking levels")[1]?.split("## Pi APIs Used")[0];

    expect(introduction).toContain("DeepSeek V4 Flash (Speed)");
    expect(introduction).toContain("DeepSeek V4.1 Flash");
    expect(introduction).toContain("DeepSeek V4.1 Flash (Speed)");
    expect(introduction).toContain("MiMo-V2.6-Pro");
    expect(catalog).toContain("| deepseek-v4-flash-speed | 1M | yes | — | $0.14 / $0.28 |");
    expect(catalog).toContain("| deepseek-v4.1-flash | 1M | yes | yes | $0.15 / $0.60 |");
    expect(catalog).toContain("| deepseek-v4.1-flash-speed | 1M | yes | yes | $0.15 / $0.60 |");
    expect(catalog).toContain("| mimo-v2.6-pro | 1M | yes | yes | $0.87 / $1.74 |");
    expect(thinking).toContain(
      "| deepseek-v4-flash-speed | none | minimal | low | medium | high | max |",
    );
    expect(thinking).toContain(
      "| deepseek-v4.1-flash | none | minimal | low | medium | high | xhigh |",
    );
    expect(thinking).toContain(
      "| deepseek-v4.1-flash-speed | none | minimal | low | medium | high | xhigh |",
    );
    expect(thinking).toContain("| mimo-v2.6-pro | none | none | high | high | high | high |");
  });

  it("configures Gemma 4 from live metadata and probed reasoning behavior", () => {
    const model = STATIC_MODELS.find((candidate) => candidate.id === "gemma-4-31b");

    expect(model).toEqual(
      expect.objectContaining({
        name: "Gemma 4 31B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.144, output: 0.42, cacheRead: 0.0144, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 16384,
      }),
    );
  });

  it("configures DeepSeek V4 Flash from live metadata and probed reasoning behavior", () => {
    const model = STATIC_MODELS.find(
      (candidate) => candidate.id === "deepseek-ai/DeepSeek-V4-Flash",
    );

    expect(model).toEqual(
      expect.objectContaining({
        name: "DeepSeek V4 Flash 0731 (Canary)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 65536,
      }),
    );
  });

  it("configures Kimi K3 and its fast variant from live metadata", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((model) => [model.id, model]));

    expect(byId["kimi-k3"]).toEqual(
      expect.objectContaining({
        name: "Kimi K3",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 65536,
      }),
    );
    expect(byId["kimi-k3-fast"]).toEqual(
      expect.objectContaining({
        name: "Kimi K3 Fast",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 65536,
      }),
    );
  });

  it("configures GLM-5.3 Flash and Qwen 3.8 27B from live metadata and probed reasoning behavior", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((model) => [model.id, model]));

    expect(byId["glm-5.3-flash"]).toEqual(
      expect.objectContaining({
        name: "GLM-5.3 Flash",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 65536,
      }),
    );
    expect(byId["qwen-3.8-27b"]).toEqual(
      expect.objectContaining({
        name: "Qwen3.8 27B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.45, output: 3.2, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 131072,
      }),
    );
  });

  it("configures Qwen3.6 35B and its fast variant from live metadata", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((model) => [model.id, model]));

    expect(byId["qwen3.6-35b"]).toEqual(
      expect.objectContaining({
        name: "Qwen3.6 35B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.29, output: 1.15, cacheRead: 0.029, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 65536,
      }),
    );
    expect(byId["qwen3.6-35b-fast"]).toEqual(
      expect.objectContaining({
        name: "Qwen3.6 35B Fast",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.29, output: 1.15, cacheRead: 0.029, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 65536,
      }),
    );
  });

  it("configures the nw-* tracking aliases from live metadata and probed reasoning behavior", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((model) => [model.id, model]));

    expect(byId["nw-large"]).toEqual(
      expect.objectContaining({
        name: "Neuralwatt Large",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 65536,
      }),
    );
    expect(byId["nw-flash"]).toEqual(
      expect.objectContaining({
        name: "Neuralwatt Flash",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 393216,
      }),
    );
    expect(byId["nw-small"]).toEqual(
      expect.objectContaining({
        name: "Neuralwatt Small",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.45, output: 3.2, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 131072,
      }),
    );
  });

  it("configures MiMo-V2.6-Pro from live metadata and probed reasoning behavior", () => {
    const model = STATIC_MODELS.find((candidate) => candidate.id === "mimo-v2.6-pro");

    expect(model).toEqual(
      expect.objectContaining({
        name: "MiMo-V2.6-Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.87, output: 1.74, cacheRead: 0.036, cacheWrite: 0 },
        contextWindow: 1048560,
        maxTokens: 393216,
      }),
    );
  });

  it("registers the provider synchronously with the full static model list", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledTimes(1);
    const [name, config] = mockPi.registerProvider.mock.calls[0];
    expect(name).toBe("neuralwatt");
    expect(config.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(config.apiKey).toBe("$NEURALWATT_API_KEY");
    expect(config.api).toBe("openai-completions");
    expect(config.authHeader).toBe(true);
    expect(config.headers).toEqual(
      expect.objectContaining({ Referer: "https://pi.dev", "X-Title": "pi-extensions/neuralwatt" }),
    );
    const ids = (config.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(EXPECTED_MODEL_IDS));
  });

  it("registers the static list even with no API key configured", async () => {
    vi.stubEnv("NEURALWATT_API_KEY", undefined);
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledTimes(1);
    const config = mockPi.registerProvider.mock.calls[0][1];
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
  });

  it("registers the static list even when the startup fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);

    const config = mockPi.registerProvider.mock.calls[0][1];
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
  });

  // --- thinking level map ---

  it("marks every reasoning model reasoning:true with a thinkingLevelMap", () => {
    const reasoning = STATIC_MODELS.filter((m) => m.reasoning);
    expect(reasoning.length).toBeGreaterThan(0);
    for (const m of reasoning) {
      expect(m.thinkingLevelMap, `${m.id} reasoning but no thinkingLevelMap`).toBeDefined();
    }
  });

  // Verified per-model thinking maps (probed against the gateway 2026-08).
  // See DISABLEABLE_* map constants in the extension source.
  it("maps each reasoning model's levels to the probed gateway behavior", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((m) => [m.id, m]));

    // Disableable + accepts identity-mapped levels through xhigh.
    expect(byId["deepseek-ai/DeepSeek-V4-Flash"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(byId["deepseek-v4-flash"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    // deepseek-v4-flash-speed (2026-09 probe): same checkpoint as
    // deepseek-v4-flash and also disableable, but the catalog aliases
    // xhigh -> max, so xhigh maps to "max" like the GLM/Kimi full-enum models.
    expect(byId["deepseek-v4-flash-speed"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // deepseek-v4.1-flash (2026-09 probe): disableable, full enum accepted.
    // The catalog aliases medium -> high and minimal -> low but keeps xhigh
    // and max distinct, so identity through xhigh is correct.
    expect(byId["deepseek-v4.1-flash"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    // deepseek-v4.1-flash-speed (2026-10 probe): same checkpoint as
    // deepseek-v4.1-flash on the Speed lane, also disableable. The catalog
    // keeps xhigh and max distinct (a level-compare probe showed max ~=
    // xhigh within noise), so identity through xhigh like the V4.1 sibling.
    expect(byId["deepseek-v4.1-flash-speed"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(byId["gemma-4-31b"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(byId["kimi-k3"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    // qwen3.6-35b previously rejected minimal/xhigh/max and kept thinking on at
    // none; the 2026-08 re-probe shows the full enum accepted with none
    // disabling thinking.
    expect(byId["qwen3.6-35b"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    // qwen-3.8-27b (2026-09 probe): full enum accepted, none disables
    // thinking. The catalog aliases max -> xhigh, so identity through xhigh is
    // the real top level.
    expect(byId["qwen-3.8-27b"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });

    // Disableable + accepts full enum (incl. max); xhigh -> "max" for deepest
    // tier.
    expect(byId["glm-5.2"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    expect(byId["glm-5.2-short"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // kimi-k2.7-code was always-on at probe time; the 2026-08 re-probe shows
    // none disables thinking, so off maps to "none" and the full map applies.
    expect(byId["kimi-k2.7-code"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // kimi-k2.7-code-fast now reasons (catalog metadata + 2026-08 probe), same
    // map as its sibling.
    expect(byId["kimi-k2.7-code-fast"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });

    // Always-on: catalog marks reasoning mandatory and the probe shows a
    // reasoning block even at `none`, so off is hidden. Accepts the full
    // enum incl. max, so xhigh -> "max" as on the other GLM entries.
    expect(byId["glm-5.3"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // glm-5.3-flash (2026-09 probe): same always-on behavior as glm-5.3 —
    // reasoning block even at `none`, full enum accepted, so off is hidden and
    // xhigh maps to "max" (the catalog aliases xhigh -> max).
    expect(byId["glm-5.3-flash"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });

    // mimo-v2.6-pro (2026-09 probe): disableable, but the catalog's
    // supported_efforts are only {none, high} and its aliases collapse every
    // other level (minimal -> none, low/medium/xhigh/max -> high), so pi's
    // levels route onto the two real modes.
    expect(byId["mimo-v2.6-pro"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "none",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "high",
    });

    // nw-large (2026-10 probe): tracking alias for the large tier (currently
    // Kimi K3). Disableable, and the catalog aliases xhigh -> max (accepted
    // natively by the gateway), so the full map applies like the other
    // full-enum models.
    expect(byId["nw-large"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    // nw-flash (2026-10 probe): tracking alias for the fast tier (currently
    // DeepSeek V4.1 Flash). Disableable; the catalog keeps xhigh distinct and
    // literal `max` returned 200 with no reasoning output, so identity
    // through xhigh is correct.
    expect(byId["nw-flash"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    // nw-small (2026-10 probe): tracking alias for the small tier (currently
    // Qwen3.8-27B). Disableable; the catalog aliases max/high -> xhigh, so
    // identity through xhigh is correct.
    expect(byId["nw-small"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("marks non-reasoning models reasoning:false with no thinkingLevelMap", () => {
    for (const m of STATIC_MODELS) {
      if (m.reasoning) continue;
      expect(m.thinkingLevelMap, `${m.id} should not carry a thinkingLevelMap`).toBeUndefined();
    }
  });

  it("sets compat.supportsReasoningEffort true on reasoning models only", () => {
    for (const m of STATIC_MODELS) {
      if (m.reasoning) {
        expect(
          (m.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort,
          `${m.id}`,
        ).toBe(true);
      } else {
        expect(
          (m.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort,
          `${m.id}`,
        ).toBeUndefined();
      }
    }
  });

  it("does not set requiresReasoningContentOnAssistantMessages (API returns 'reasoning', not 'reasoning_content')", () => {
    // Neuralwatt returns thinking under a top-level `reasoning` field. Pi's
    // openai-completions provider reads both `reasoning` and `reasoning_content`,
    // so the flag is unnecessary; setting it would inject an empty
    // reasoning_content on replay that the API does not need.
    for (const m of STATIC_MODELS) {
      expect(
        (m.compat as Record<string, unknown> | undefined)
          ?.requiresReasoningContentOnAssistantMessages,
        `${m.id} should not set requiresReasoningContentOnAssistantMessages`,
      ).toBeUndefined();
    }
  });

  // --- startup missing-models check ---

  it("registers a session_start handler", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("startup check fetches the public /v1/models catalog", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.neuralwatt.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: "https://pi.dev",
          "X-Title": "pi-extensions/neuralwatt",
        }),
      }),
    );
  });

  it("startup check does not send an Authorization header (public view)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("startup check warns when the live catalog exposes models not in the static list", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const live = [
      ...STATIC_MODELS.map((m) => ({ id: m.id })),
      { id: "glm-6.0" },
      { id: "qwen4-720b" },
    ];
    mockFetch.mockResolvedValueOnce(mockModelsResponse(live));

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("glm-6.0"), "warning");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("qwen4-720b"),
      "warning",
    );
  });

  it("startup check ignores flex siblings represented by the flex toggle", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const live = [
      ...STATIC_MODELS.map((m) => ({ id: m.id })),
      { id: "glm-5.2-flex" },
      { id: "glm-5.2-short-flex" },
      { id: "glm-5.2-short-fast-flex" },
      { id: "kimi-k2.7-code-flex" },
    ];
    mockFetch.mockResolvedValueOnce(mockModelsResponse(live));

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    const warnings = mockCtx.ui.notify.mock.calls.filter((call) => call[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check skips deprecated and pricing-tbd models", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const live = [
      ...STATIC_MODELS.map((m) => ({ id: m.id })),
      { id: "deprecated-model", metadata: { deprecated: true } },
      { id: "unpriced-model", metadata: { pricing: { pricing_tbd: true } } },
    ];
    mockFetch.mockResolvedValueOnce(mockModelsResponse(live));

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check does not warn when the catalog matches the static list", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check is silent when no API key is configured", async () => {
    vi.stubEnv("NEURALWATT_API_KEY", undefined);
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check logs a diagnostic and still loads flex capabilities on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.model = makeModel("glm-5.2");
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("neuralwatt"));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
    // The public catalog failed, but flex discovery still fetched and published.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const flexHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(flexHeaders.Authorization).toBe("Bearer nw_test_key_123");
    const emits = mockPi.events.emit.mock.calls.filter((c) => c[0] === FLEX_EVENT);
    expect(emits.length).toBeGreaterThan(0);
    expect(emits[emits.length - 1][1]).toEqual({ flexOn: false, flexCapable: false });
  });

  it("startup check logs a diagnostic with the HTTP status when the catalog endpoint errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("neuralwatt"));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("401"));
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check logs no diagnostic for a valid empty catalog", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();

    expect(debugSpy).not.toHaveBeenCalled();
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check returns before the network answers and settles within one timeout window", async () => {
    vi.useFakeTimers();
    try {
      // A server that accepts the connection and never answers: fetch settles
      // only when its abort signal fires.
      mockFetch.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.model = makeModel("glm-5.2");
      await neuralwattExtension(mockPi);

      const handler = getEventHandler(mockPi, "session_start");
      let settled = false;
      void Promise.resolve(handler({ type: "session_start", reason: "new" }, mockCtx)).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Both checks run in parallel, so one timeout window settles them.
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
      const emits = mockPi.events.emit.mock.calls.filter((c) => c[0] === FLEX_EVENT);
      expect(emits[emits.length - 1]?.[1]).toEqual({ flexOn: false, flexCapable: false });
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("aborted"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("startup check ignores a stale ctx when the session is replaced before the checks settle", async () => {
    const stale = new Error("This extension ctx is stale after session replacement or reload.");
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    // Pi invalidates the captured ctx after the handler returns.
    Object.defineProperty(mockCtx, "model", {
      get: () => {
        throw stale;
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await settleStartupChecks();
      await settleStartupChecks();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("exposes a static message id for the missing-models notice", () => {
    expect(typeof MISSING_MODELS_MESSAGE).toBe("string");
    expect(MISSING_MODELS_MESSAGE.length).toBeGreaterThan(0);
  });

  // --- commands ---

  it("registers /neuralwatt:models command", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "neuralwatt:models",
      expect.objectContaining({
        description: expect.stringContaining("Neuralwatt models"),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers /neuralwatt:quota command", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "neuralwatt:quota",
      expect.objectContaining({
        description: expect.stringContaining("quota"),
        handler: expect.any(Function),
      }),
    );
  });

  it("/neuralwatt:models displays the static list with capabilities and pricing", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getCommandHandler(mockPi, "neuralwatt:models");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("vision"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reasoning"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("glm-5.2"), "info");
  });

  it("/neuralwatt:models shows no fetch on subsequent calls (purely static)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);
    const fetchesAfterInit = mockFetch.mock.calls.length;

    const handler = getCommandHandler(mockPi, "neuralwatt:models");
    await handler("", mockCtx);
    await handler("", mockCtx);

    expect(mockFetch.mock.calls.length).toBe(fetchesAfterInit);
  });

  it("/neuralwatt:quota fetches from /v1/quota endpoint with auth", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const quota: NeuralwattQuotaResponse = {
      balance: {
        credits_remaining_usd: 5,
        total_credits_usd: 10,
        credits_used_usd: 5,
        accounting_method: "prepaid",
      },
      usage: {
        current_month: { cost_usd: 1.5, requests: 42, tokens: 12345, energy_kwh: 0.0123 },
      },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(quota) });

    const handler = getCommandHandler(mockPi, "neuralwatt:quota");
    await handler("", mockCtx);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.neuralwatt.com/v1/quota",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer nw_test_key_123" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Credits"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("This month"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Energy"), "info");
  });

  it("/neuralwatt:quota renders subscription and key allowance when present", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const quota: NeuralwattQuotaResponse = {
      subscription: {
        plan: "pro",
        status: "active",
        current_period_end: "2026-07-01T00:00:00Z",
        kwh_included: 50,
        kwh_used: 12,
        in_overage: false,
      },
      key: {
        name: "default",
        allowance: {
          limit_usd: 100,
          period: "monthly",
          spent_usd: 20,
          remaining_usd: 80,
          blocked: false,
        },
      },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(quota) });

    const handler = getCommandHandler(mockPi, "neuralwatt:quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Subscription"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pro"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Key allowance"),
      "info",
    );
  });

  it("/neuralwatt:quota shows error when API key is missing", async () => {
    vi.stubEnv("NEURALWATT_API_KEY", undefined);
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getCommandHandler(mockPi, "neuralwatt:quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("API key not configured"),
      "error",
    );
  });

  it("/neuralwatt:quota handles fetch errors gracefully", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    mockFetch.mockRejectedValueOnce(new Error("Quota service down"));

    const handler = getCommandHandler(mockPi, "neuralwatt:quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Quota service down"),
      "error",
    );
  });

  // --- model_select ---

  it("registers model_select event handler", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
  });

  it("model_select notifies when a neuralwatt model is selected", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "model_select");
    await handler(
      {
        type: "model_select",
        model: { id: "glm-5.2", name: "GLM-5.2", provider: "neuralwatt" },
        previousModel: undefined,
        source: "set",
      },
      mockCtx,
    );

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Using Neuralwatt model"),
      "info",
    );
  });

  it("model_select does not notify for non-neuralwatt models", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "model_select");
    await handler(
      {
        type: "model_select",
        model: { id: "gpt-4", provider: "openai" },
        previousModel: undefined,
        source: "set",
      },
      mockCtx,
    );

    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  // --- helper type sanity (imports compile) ---

  it("NeuralwattModelsResponse type import resolves at runtime", () => {
    const sample = { data: [] } satisfies NeuralwattModelsResponse;
    expect(sample.data).toEqual([]);
  });
});

describe("neuralwatt flex helpers", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFetch = vi.fn();
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = mockFetch;
  });

  it("fetchFlexCapableIds returns base ids that have a -flex sibling", async () => {
    mockFetch.mockResolvedValue(
      mockModelsResponse([
        { id: "glm-5.2" },
        { id: "glm-5.2-flex" },
        { id: "kimi-k2.7-code" },
        { id: "kimi-k2.7-code-flex" },
        { id: "qwen3.6-35b" }, // no flex sibling
      ]),
    );
    const capable = await fetchFlexCapableIds("key", undefined);
    expect([...capable].sort()).toEqual(["glm-5.2", "kimi-k2.7-code"]);
  });

  it("fetchFlexCapableIds returns an empty set on a non-OK response", async () => {
    const resp = { ok: false, json: () => Promise.resolve({ data: [] }) } as Response;
    mockFetch.mockResolvedValue(resp);
    const capable = await fetchFlexCapableIds("key", undefined);
    expect([...capable]).toEqual([]);
  });

  it("fetchFlexCapableIds returns an empty set when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    const capable = await fetchFlexCapableIds("key", undefined);
    expect([...capable]).toEqual([]);
  });

  it("computeFlexState reports capable only for a Neuralwatt model in the set", () => {
    const capable = new Set(["glm-5.2"]);
    const model = (id: string, provider = "neuralwatt") => ({ id, provider });
    const enabled = new Set(["glm-5.2"]);
    expect(computeFlexState(model("glm-5.2"), enabled, capable)).toEqual({
      flexOn: true,
      flexCapable: true,
    });
    expect(computeFlexState(model("glm-5.2"), new Set(), capable)).toEqual({
      flexOn: false,
      flexCapable: true,
    });
    // Not flex-capable.
    expect(computeFlexState(model("qwen3.6-35b"), new Set(["qwen3.6-35b"]), capable)).toEqual({
      flexOn: false,
      flexCapable: false,
    });
    // Non-Neuralwatt provider is never capable even if the id matches.
    expect(computeFlexState(model("glm-5.2", "openai"), enabled, capable)).toEqual({
      flexOn: false,
      flexCapable: false,
    });
    // No model selected.
    expect(computeFlexState(undefined, enabled, capable)).toEqual({
      flexOn: false,
      flexCapable: false,
    });
  });

  it("injectServiceTier injects service_tier only when flex is enabled for a capable model", () => {
    const capable = new Set(["glm-5.2", "kimi-k2.7-code"]);
    const enabled = new Set(["glm-5.2"]);
    const out = injectServiceTier(
      { model: "glm-5.2", messages: [] },
      "neuralwatt",
      enabled,
      capable,
    );
    expect(out).toEqual({ model: "glm-5.2", messages: [], service_tier: "flex" });

    // Flex not enabled for any model: no change.
    expect(
      injectServiceTier({ model: "glm-5.2", messages: [] }, "neuralwatt", new Set(), capable),
    ).toBeUndefined();
    // Capable model without flex enabled for it: no change.
    expect(
      injectServiceTier({ model: "kimi-k2.7-code" }, "neuralwatt", enabled, capable),
    ).toBeUndefined();
    // Enabled but no longer capable: no change.
    expect(
      injectServiceTier({ model: "qwen3.6-35b" }, "neuralwatt", new Set(["qwen3.6-35b"]), capable),
    ).toBeUndefined();
    // Non-string model: no change.
    expect(injectServiceTier({ model: 123 }, "neuralwatt", enabled, capable)).toBeUndefined();
    // Non-object payload: no change.
    expect(injectServiceTier(null, "neuralwatt", enabled, capable)).toBeUndefined();
    // Existing service_tier is preserved/overridden cleanly via spread.
    const overridden = injectServiceTier(
      { model: "glm-5.2", service_tier: "auto" },
      "neuralwatt",
      enabled,
      capable,
    );
    expect(overridden).toEqual({ model: "glm-5.2", service_tier: "flex" });
  });

  it("injectServiceTier leaves other providers' requests untouched when the model id matches", () => {
    const capable = new Set(["glm-5.2"]);
    const enabled = new Set(["glm-5.2"]);
    expect(injectServiceTier({ model: "glm-5.2" }, "zai", enabled, capable)).toBeUndefined();
    expect(injectServiceTier({ model: "glm-5.2" }, undefined, enabled, capable)).toBeUndefined();
  });
});

describe("neuralwatt flex integration", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFetch = vi.fn();
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = mockFetch;
    vi.stubEnv("NEURALWATT_API_KEY", "nw_test_key_123");
    mockFetch.mockResolvedValue(mockModelsResponse(STATIC_MODELS));
  });

  /** Catalog response carrying `<id>-flex` siblings for the given base ids. */
  function flexCatalog(baseIds: string[]): Response {
    const data = baseIds.flatMap((id) => [{ id }, { id: `${id}-flex` }]);
    return mockModelsResponse(data);
  }

  /** Boot the extension and run session_start with the given flex-capable ids. */
  async function bootWithFlex(
    mockPi: ReturnType<typeof createMockPi>,
    mockCtx: ReturnType<typeof createMockCommandContext>,
    modelId: string,
    capableIds: string[],
  ) {
    await neuralwattExtension(mockPi);
    mockCtx.model = makeModel(modelId);
    mockFetch.mockResolvedValue(flexCatalog(capableIds));
    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);
    await settleStartupChecks();
  }

  it("session_start builds the flex-capable set and emits flex state", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2", "kimi-k2.7-code"]);

    const emits = mockPi.events.emit.mock.calls.filter((c) => c[0] === FLEX_EVENT);
    expect(emits.length).toBeGreaterThan(0);
    expect(emits[emits.length - 1][1]).toEqual({ flexOn: false, flexCapable: true });
  });

  it("/neuralwatt:flex errors when the current model is not a Neuralwatt model", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);
    // Non-Neuralwatt: do not run session_start's flex fetch.
    mockCtx.model = makeModel("gpt-4", "openai");

    const handler = getCommandHandler(mockPi, "neuralwatt:flex");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("only applies to Neuralwatt"),
      "error",
    );
  });

  it("/neuralwatt:flex warns when the Neuralwatt model has no flex tier", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // Build capable set that does NOT include the selected model.
    await bootWithFlex(mockPi, mockCtx, "qwen3.6-35b", ["glm-5.2"]);

    mockCtx.ui.notify.mockClear();
    const handler = getCommandHandler(mockPi, "neuralwatt:flex");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no flex tier available"),
      "warning",
    );
  });

  it("/neuralwatt:flex toggles flex on/off and emits state for a capable model", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2"]);

    mockPi.events.emit.mockClear();
    const handler = getCommandHandler(mockPi, "neuralwatt:flex");
    await handler("", mockCtx); // enable

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Flex enabled"), "info");
    const enableEmit = mockPi.events.emit.mock.calls.find((c) => c[0] === FLEX_EVENT);
    expect(enableEmit?.[1]).toEqual({ flexOn: true, flexCapable: true });

    mockCtx.ui.notify.mockClear();
    mockPi.events.emit.mockClear();
    await handler("", mockCtx); // disable
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Flex disabled"),
      "info",
    );
    const disableEmit = mockPi.events.emit.mock.calls.find((c) => c[0] === FLEX_EVENT);
    expect(disableEmit?.[1]).toEqual({ flexOn: false, flexCapable: true });
  });

  it("before_provider_request injects service_tier only when flex is on and the model is capable", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2"]);

    const providerHandler = getEventHandler(mockPi, "before_provider_request");

    // Flex off by default: no injection.
    let result = await providerHandler(
      { type: "before_provider_request", payload: { model: "glm-5.2", messages: [] } },
      mockCtx,
    );
    expect(result).toBeUndefined();

    // Enable flex, then inject.
    await getCommandHandler(mockPi, "neuralwatt:flex")("", mockCtx);
    result = await providerHandler(
      { type: "before_provider_request", payload: { model: "glm-5.2", messages: [] } },
      mockCtx,
    );
    expect(result).toEqual({ model: "glm-5.2", messages: [], service_tier: "flex" });

    // Capable toggle on but a non-capable model in the payload: no injection.
    result = await providerHandler(
      { type: "before_provider_request", payload: { model: "qwen3.6-35b" } },
      mockCtx,
    );
    expect(result).toBeUndefined();
  });

  it("before_provider_request leaves another provider's request untouched with flex on", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2"]);
    await getCommandHandler(mockPi, "neuralwatt:flex")("", mockCtx);

    // Switch to a different provider that ships the same model id.
    mockCtx.model = makeModel("glm-5.2", "zai");
    const providerHandler = getEventHandler(mockPi, "before_provider_request");
    const result = await providerHandler(
      { type: "before_provider_request", payload: { model: "glm-5.2", messages: [] } },
      mockCtx,
    );
    expect(result).toBeUndefined();
  });

  it("flex enabled for one model stays off for another capable model", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2", "kimi-k2.7-code"]);
    await getCommandHandler(mockPi, "neuralwatt:flex")("", mockCtx);

    // Switch to another flex-capable Neuralwatt model.
    mockPi.events.emit.mockClear();
    const kimi = makeModel("kimi-k2.7-code");
    mockCtx.model = kimi;
    const selectHandler = getEventHandler(mockPi, "model_select");
    await selectHandler(
      { type: "model_select", model: kimi, previousModel: undefined, source: "set" },
      mockCtx,
    );
    const kimiEmit = mockPi.events.emit.mock.calls.find((c) => c[0] === FLEX_EVENT);
    expect(kimiEmit?.[1]).toEqual({ flexOn: false, flexCapable: true });

    const providerHandler = getEventHandler(mockPi, "before_provider_request");
    const kimiResult = await providerHandler(
      { type: "before_provider_request", payload: { model: "kimi-k2.7-code", messages: [] } },
      mockCtx,
    );
    expect(kimiResult).toBeUndefined();

    // Enabling flex on kimi does not disable it for glm-5.2, and vice versa.
    await getCommandHandler(mockPi, "neuralwatt:flex")("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Flex enabled"), "info");

    // Switching back keeps the earlier per-model choice.
    mockPi.events.emit.mockClear();
    const glm = makeModel("glm-5.2");
    mockCtx.model = glm;
    await selectHandler(
      { type: "model_select", model: glm, previousModel: kimi, source: "set" },
      mockCtx,
    );
    const glmEmit = mockPi.events.emit.mock.calls.find((c) => c[0] === FLEX_EVENT);
    expect(glmEmit?.[1]).toEqual({ flexOn: true, flexCapable: true });
    const glmResult = await providerHandler(
      { type: "before_provider_request", payload: { model: "glm-5.2", messages: [] } },
      mockCtx,
    );
    expect(glmResult).toEqual({ model: "glm-5.2", messages: [], service_tier: "flex" });
  });

  it("model_select emits flex state and notifies for Neuralwatt models", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await bootWithFlex(mockPi, mockCtx, "glm-5.2", ["glm-5.2", "kimi-k2.7-code"]);

    mockPi.events.emit.mockClear();
    mockCtx.ui.notify.mockClear();
    const handler = getEventHandler(mockPi, "model_select");
    await handler(
      {
        type: "model_select",
        model: { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", provider: "neuralwatt" },
        previousModel: undefined,
        source: "set",
      },
      mockCtx,
    );

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Using Neuralwatt model"),
      "info",
    );
    // kimi-k2.7-code is capable too, so flexCapable stays true and flexOn false.
    const emit = mockPi.events.emit.mock.calls.find((c) => c[0] === FLEX_EVENT);
    expect(emit?.[1]).toEqual({ flexOn: false, flexCapable: true });
  });
});
