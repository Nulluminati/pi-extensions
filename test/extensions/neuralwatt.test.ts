import { beforeEach, describe, expect, it, vi } from "vitest";
import neuralwattExtension, {
  MISSING_MODELS_MESSAGE,
  type NeuralwattModelsResponse,
  type NeuralwattQuotaResponse,
  STATIC_MODELS,
} from "../../extensions/neuralwatt/neuralwatt.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

function mockModelsResponse(models: unknown[]): Response {
  return { ok: true, json: () => Promise.resolve({ data: models }) } as Response;
}

// Ids present in the static catalog. Startup check tests use these.
const EXPECTED_MODEL_IDS = [
  "gemma-4-31b",
  "glm-5.2",
  "glm-5.2-fast",
  "glm-5.2-short",
  "glm-5.2-short-fast",
  "moonshotai/Kimi-K2.5",
  "kimi-k2.5-fast",
  "kimi-k2.6",
  "kimi-k2.6-fast",
  "kimi-k2.7-code",
  "qwen3.5-397b",
  "qwen3.5-397b-fast",
  "qwen3.6-35b",
  "qwen3.6-35b-fast",
];

describe("neuralwatt-extension", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFetch = vi.fn();
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = mockFetch;
    vi.stubEnv("NEURALWATT_API_KEY", "nw_test_key_123");
    // Default: live public catalog in sync with the static list (no warning).
    mockFetch.mockResolvedValue(mockModelsResponse(STATIC_MODELS));
  });

  // --- static list ---

  it("exposes a static list covering every known model id", () => {
    const ids = STATIC_MODELS.map((m) => m.id).sort();
    for (const id of EXPECTED_MODEL_IDS) {
      expect(ids, `static list missing ${id}`).toContain(id);
    }
  });

  it("configures Gemma 4 from live metadata and probed reasoning behavior", () => {
    const model = STATIC_MODELS.find((candidate) => candidate.id === "gemma-4-31b");

    expect(model).toEqual(
      expect.objectContaining({
        name: "Gemma 4 31B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.144, output: 0.42, cacheRead: 0.036, cacheWrite: 0 },
        contextWindow: 262128,
        maxTokens: 16384,
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

  // Verified per-model thinking maps (probed against the gateway 2026-06).
  // See DISABLEABLE_*/ALWAYS_ON_* map constants in the extension source.
  it("maps each reasoning model's levels to the probed gateway behavior", () => {
    const byId = Object.fromEntries(STATIC_MODELS.map((m) => [m.id, m]));

    // Disableable + accepts identity-mapped levels through xhigh.
    expect(byId["gemma-4-31b"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });

    // Disableable + accepts full enum (incl. max); xhigh -> "max" for deepest tier.
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
    expect(byId["qwen3.5-397b"].thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });

    // Cannot be disabled (off hidden) + accepts full enum.
    expect(byId["kimi-k2.6"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
    expect(byId["kimi-k2.7-code"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });

    // Cannot be disabled + accepts identity-mapped levels through xhigh.
    expect(byId["moonshotai/Kimi-K2.5"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });

    // Cannot be disabled and rejects minimal/xhigh/max.
    expect(byId["qwen3.6-35b"].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
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
        expect(m.compat?.supportsReasoningEffort, `${m.id}`).toBe(true);
      } else {
        expect(m.compat?.supportsReasoningEffort, `${m.id}`).toBeUndefined();
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
        m.compat?.requiresReasoningContentOnAssistantMessages,
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

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("glm-6.0"), "warning");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("qwen4-720b"),
      "warning",
    );
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

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check does not warn when the catalog matches the static list", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

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

    expect(mockFetch).not.toHaveBeenCalled();
    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check is silent on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    const warnings = mockCtx.ui.notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warnings).toEqual([]);
  });

  it("startup check is silent when the catalog endpoint errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

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

  it("registers /neuralwatt-models command", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "neuralwatt-models",
      expect.objectContaining({
        description: expect.stringContaining("Neuralwatt models"),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers /neuralwatt-quota command", async () => {
    const mockPi = createMockPi();
    await neuralwattExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "neuralwatt-quota",
      expect.objectContaining({
        description: expect.stringContaining("quota"),
        handler: expect.any(Function),
      }),
    );
  });

  it("/neuralwatt-models displays the static list with capabilities and pricing", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getCommandHandler(mockPi, "neuralwatt-models");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("vision"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reasoning"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("glm-5.2"), "info");
  });

  it("/neuralwatt-models shows no fetch on subsequent calls (purely static)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);
    const fetchesAfterInit = mockFetch.mock.calls.length;

    const handler = getCommandHandler(mockPi, "neuralwatt-models");
    await handler("", mockCtx);
    await handler("", mockCtx);

    expect(mockFetch.mock.calls.length).toBe(fetchesAfterInit);
  });

  it("/neuralwatt-quota fetches from /v1/quota endpoint with auth", async () => {
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

    const handler = getCommandHandler(mockPi, "neuralwatt-quota");
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

  it("/neuralwatt-quota renders subscription and key allowance when present", async () => {
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

    const handler = getCommandHandler(mockPi, "neuralwatt-quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Subscription"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pro"), "info");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Key allowance"),
      "info",
    );
  });

  it("/neuralwatt-quota shows error when API key is missing", async () => {
    vi.stubEnv("NEURALWATT_API_KEY", undefined);
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    const handler = getCommandHandler(mockPi, "neuralwatt-quota");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("API key not configured"),
      "error",
    );
  });

  it("/neuralwatt-quota handles fetch errors gracefully", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await neuralwattExtension(mockPi);

    mockFetch.mockRejectedValueOnce(new Error("Quota service down"));

    const handler = getCommandHandler(mockPi, "neuralwatt-quota");
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
