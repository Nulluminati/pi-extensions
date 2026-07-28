import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import syntheticExtension, {
  MISSING_MODELS_MESSAGE,
  STATIC_MODELS,
  type SyntheticModelsResponse,
} from "../../extensions/synthetic/synthetic.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

function mockModelsResponse(models: unknown[]): Response {
  return { ok: true, json: () => Promise.resolve({ data: models }) } as Response;
}

// Ids present in the live catalog snapshot. Startup check tests use these.
const EXPECTED_MODEL_IDS = [
  "syn:large:text",
  "syn:small:text",
  "syn:large:vision",
  "syn:small:vision",
  "hf:zai-org/GLM-5.2",
  "hf:moonshotai/Kimi-K2.7-Code",
  "hf:moonshotai/Kimi-K3",
  "hf:Qwen/Qwen3.6-27B",
  "hf:MiniMaxAI/MiniMax-M3",
  "hf:zai-org/GLM-4.7-Flash",
  "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
  "hf:openai/gpt-oss-120b",
];

describe("synthetic-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/synthetic");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["synthetic.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(6);
    });
  });

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFetch = vi.fn();
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = mockFetch;
    vi.stubEnv("SYNTHETIC_API_KEY", "syn_test_key_123");
    // Default: live catalog in sync with the static list (no warning).
    mockFetch.mockResolvedValue(mockModelsResponse(STATIC_MODELS));
  });

  // --- static list ---

  it("exposes a static list covering every known model id", () => {
    const ids = STATIC_MODELS.map((m) => m.id).sort();
    for (const id of EXPECTED_MODEL_IDS) {
      expect(ids, `static list missing ${id}`).toContain(id);
    }
  });

  it("registers the provider synchronously with the full static model list", async () => {
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledTimes(1);
    const [name, config] = mockPi.registerProvider.mock.calls[0];
    expect(name).toBe("synthetic");
    expect(config.baseUrl).toBe("https://api.synthetic.new/openai/v1");
    expect(config.apiKey).toBe("$SYNTHETIC_API_KEY");
    expect(config.api).toBe("openai-completions");
    const ids = (config.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(EXPECTED_MODEL_IDS));
  });

  it("registers the static list even with no API key configured", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", undefined);
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledTimes(1);
    const config = mockPi.registerProvider.mock.calls[0][1];
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
  });

  it("registers the static list even when the startup fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);

    const config = mockPi.registerProvider.mock.calls[0][1];
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
  });

  // --- thinking level map (the actual bug fix) ---

  it("marks every reasoning model reasoning:true with a thinkingLevelMap", () => {
    const reasoning = STATIC_MODELS.filter((m) => m.reasoning);
    expect(reasoning.length).toBeGreaterThan(0);
    for (const m of reasoning) {
      expect(m.thinkingLevelMap, `${m.id} reasoning but no thinkingLevelMap`).toBeDefined();
    }
  });

  it("exposes xhigh on every reasoning model (gateway accepts the full enum)", () => {
    for (const m of STATIC_MODELS) {
      if (!m.reasoning) continue;
      const map = m.thinkingLevelMap;
      expect(map?.xhigh, `${m.id} should map xhigh to "xhigh"`).toBe("xhigh");
    }
  });

  it("hides medium for Kimi-K3 (gateway rejects it; supported values are high/low/max)", () => {
    const kimi = STATIC_MODELS.find((m) => m.id === "hf:moonshotai/Kimi-K3");
    expect(kimi).toBeDefined();
    expect(kimi?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("maps off to null for always-on reasoning models (thinking cannot be disabled)", () => {
    const alwaysOn = STATIC_MODELS.filter(
      (m) =>
        m.reasoning && (m.id === "hf:MiniMaxAI/MiniMax-M3" || m.id === "hf:openai/gpt-oss-120b"),
    );
    expect(alwaysOn.length).toBe(2);
    for (const m of alwaysOn) {
      expect(m.thinkingLevelMap?.off, `${m.id} should map off to null`).toBeNull();
    }
  });

  it("maps off to 'none' for the other reasoning models (thinking is disableable)", () => {
    const disableable = STATIC_MODELS.filter(
      (m) => m.reasoning && m.id !== "hf:MiniMaxAI/MiniMax-M3" && m.id !== "hf:openai/gpt-oss-120b",
    );
    expect(disableable.length).toBeGreaterThan(0);
    for (const m of disableable) {
      expect(m.thinkingLevelMap?.off, `${m.id} should map off to "none"`).toBe("none");
    }
  });

  it("marks every non-reasoning model reasoning:false with no thinkingLevelMap", () => {
    // The live catalog (verified 2026-07) lists reasoning support on every
    // always-on, tools-capable model, so there are currently no non-reasoning
    // entries. The guard stays in case the catalog regresses.
    const nonReasoning = STATIC_MODELS.filter((m) => !m.reasoning);
    for (const m of nonReasoning) {
      expect(m.thinkingLevelMap, `${m.id} should not carry a thinkingLevelMap`).toBeUndefined();
    }
  });

  it("sets compat.supportsReasoningEffort true on every model", () => {
    // Provider-wide flag; the actual bug we are fixing had it false, so even the
    // levels pi exposed were no-ops on the wire.
    for (const m of STATIC_MODELS) {
      expect(m.compat?.supportsReasoningEffort, `${m.id}`).toBe(true);
    }
  });

  // --- startup missing-models check ---

  it("registers a session_start handler", async () => {
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("startup check warns when the live catalog exposes models not in the static list", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const live = [
      ...STATIC_MODELS.map((m) => ({ id: m.id, always_on: true })),
      { id: "hf:brandnew/Model-X", always_on: true, supported_features: ["tools"] },
      { id: "hf:brandnew/Model-Y", always_on: true, supported_features: ["tools"] },
    ];
    mockFetch.mockResolvedValueOnce(mockModelsResponse(live));

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("hf:brandnew/Model-X"),
      "warning",
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("hf:brandnew/Model-Y"),
      "warning",
    );
  });

  it("startup check does not warn when the catalog matches the static list", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check is silent when no API key is configured", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", undefined);
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    expect(mockFetch).not.toHaveBeenCalled();
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check is silent on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("exposes a static message id for the missing-models notice", () => {
    expect(typeof MISSING_MODELS_MESSAGE).toBe("string");
    expect(MISSING_MODELS_MESSAGE.length).toBeGreaterThan(0);
  });

  // --- commands ---

  it("registers /synthetic-models command", async () => {
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "synthetic-models",
      expect.objectContaining({
        description: expect.stringContaining("Synthetic models"),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers /synthetic-quota command", async () => {
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "synthetic-quota",
      expect.objectContaining({
        description: expect.stringContaining("quota"),
        handler: expect.any(Function),
      }),
    );
  });

  it("/synthetic-models displays the static list with capabilities and pricing", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getCommandHandler(mockPi, "synthetic-models");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("vision"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reasoning"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("hf:moonshotai/Kimi-K2.7-Code"),
      "info",
    );
  });

  it("/synthetic-models shows no fetch on subsequent calls (purely static)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);
    const fetchesAfterInit = mockFetch.mock.calls.length;

    const handler = getCommandHandler(mockPi, "synthetic-models");
    await handler("", mockCtx);
    await handler("", mockCtx);

    expect(mockFetch.mock.calls.length).toBe(fetchesAfterInit);
  });

  it("/synthetic-quota fetches from v2/quotas endpoint", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          subscription: { limit: 1000, requests: 100, renewsAt: "2026-06-01T00:00:00Z" },
        }),
    });

    const handler = getCommandHandler(mockPi, "synthetic-quota");
    await handler("", mockCtx);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer syn_test_key_123" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Subscription"), "info");
  });

  it("/synthetic-quota shows error when API key is missing", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", undefined);
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getCommandHandler(mockPi, "synthetic-quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("API key not configured"),
      "error",
    );
  });

  it("/synthetic-quota handles fetch errors gracefully", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    mockFetch.mockRejectedValueOnce(new Error("Quota service down"));

    const handler = getCommandHandler(mockPi, "synthetic-quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Quota service down"),
      "error",
    );
  });

  // --- model_select ---

  it("registers model_select event handler", async () => {
    const mockPi = createMockPi();
    await syntheticExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
  });

  it("model_select notifies when a synthetic model is selected", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

    const handler = getEventHandler(mockPi, "model_select");
    await handler(
      {
        type: "model_select",
        model: {
          id: "hf:moonshotai/Kimi-K2.7-Code",
          name: "Kimi-K2.7-Code",
          provider: "synthetic",
        },
        previousModel: undefined,
        source: "set",
      },
      mockCtx,
    );

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Using Synthetic model"),
      "info",
    );
  });

  it("model_select does not notify for non-synthetic models", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await syntheticExtension(mockPi);

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

  // --- helper type sanity (import compiles) ---

  it("SyntheticModelsResponse type import resolves at runtime", () => {
    const sample = { data: [] } satisfies SyntheticModelsResponse;
    expect(sample.data).toEqual([]);
  });
});
