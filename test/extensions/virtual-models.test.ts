import type { ClassifierResult, ExtensionVirtualModel, Model, ModelRouteRequest } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/virtual-models/virtual-models.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const specs = ["openai-codex/gpt-6.1-sol", "opencode-go/deepseek-v4.1-flash", "zai/glm-5.3-flash"];
function model(spec: string, api = "openai-completions"): Model {
  const slash = spec.indexOf("/");
  return {
    provider: spec.slice(0, slash),
    id: spec.slice(slash + 1),
    name: spec,
    api,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 4096,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
  };
}
function failedMessage(errorMessage: string) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    stopReason: "error" as const,
    errorMessage,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const virtual = model("virtual-models/rules-v1", "pi-virtual");
function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    model: virtual,
    thinkingLevel: "medium",
    reason: "user",
    messages: [{ role: "user", content: "Find the worker model configuration.", timestamp: 1 }],
    ...overrides,
  };
}
function result(choice = "deepseek"): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    timestamp: 1,
    stopReason: "stop",
    usage: { input: 31, output: 2, totalTokens: 33 },
    answers: {
      route: {
        type: "choice",
        choice,
        confidence: 0.8,
        probabilities: {
          sol: choice === "sol" ? 0.8 : 0.1,
          deepseek: choice === "deepseek" ? 0.8 : 0.1,
          glm: choice === "glm" ? 0.8 : 0.1,
        },
      },
    },
  };
}
async function boot() {
  const pi = createMockPi();
  const ctx = createMockContext();
  const pool = specs.map((spec) => model(spec));
  ctx.modelRegistry.find.mockImplementation((provider, id) =>
    pool.find((entry) => entry.provider === provider && entry.id === id),
  );
  ctx.modelRegistry.getAvailable.mockReturnValue(pool);
  ctx.modelRegistry.findOfType.mockReturnValue(model("typesafe/jev-latest", "typesafe-system-one"));
  ctx.modelRegistry.getAvailableOfType.mockResolvedValue([
    model("typesafe/jev-latest", "typesafe-system-one"),
  ]);
  ctx.modelRegistry.classify.mockResolvedValue(result());
  pi.registerVirtualModel = vi.fn();
  await extension(pi);
  const definitions = pi.registerVirtualModel.mock.calls.map(([definition]) => definition);
  const get = (id: string): ExtensionVirtualModel => {
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) throw new Error("Missing router");
    return definition;
  };
  return { pi, ctx, pool, rules: get("rules-v1"), jev: get("jev-v1") };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PI_WORKER", "");
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("opt-in virtual model routers", () => {
  it("registers separate virtual selections without changing the selected model or defaults", async () => {
    const { pi, rules, jev } = await boot();
    expect(rules).toMatchObject({
      provider: "virtual-models",
      id: "rules-v1",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(jev.id).toBe("jev-v1");
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });
  it("does not collect provider usage in normal sessions without experiment tracing", async () => {
    const { pi, ctx } = await boot();
    const handler = pi.on.mock.calls.find(([name]) => name === "provider_stream_event")?.[1];
    if (!handler) throw new Error("Missing provider usage handler");
    await handler(
      {
        type: "provider_stream_event",
        provider: "zai",
        api: "openai-completions",
        model: "glm-5.3-flash",
        data: { usage: { total_tokens: 10 } },
      },
      ctx,
    );
    const start = pi.on.mock.calls.find(([name]) => name === "session_start")?.[1];
    if (!start) throw new Error("Missing startup handler");
    await start({ type: "session_start", reason: "startup" }, ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("records the effective loadout without exposing tool descriptions or credentials", async () => {
    const { pi, ctx } = await boot();
    ctx.model = virtual;
    pi.getActiveTools.mockReturnValue(["read", "bash"]);
    pi.getAllTools.mockReturnValue([]);
    const handler = pi.on.mock.calls.find(([name]) => name === "session_start")?.[1];
    if (!handler) throw new Error("Missing loadout handler");
    await handler({ type: "session_start", reason: "startup" }, ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-loadout",
      expect.objectContaining({ activeTools: ["bash", "read"], role: "main" }),
    );
  });

  it.each([
    ["Find configuration", 2],
    ["Diagnose the failing test", 1],
    ["Find an optimal schedule under memory constraints", 0],
  ])("routes observable user requests: %s", async (text, index) => {
    const { rules, ctx, pool, pi } = await boot();
    const routed = await rules.route(
      request({ messages: [{ role: "user", content: text, timestamp: 1 }] }),
      ctx,
    );
    expect(routed.model).toEqual(pool[index]);
    expect(routed.thinkingLevel).toBe("high");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({
        selected: "virtual-models/rules-v1",
        dispatched: specs[index],
        requestedThinking: "medium",
        effectiveThinking: "high",
        role: "main",
        policyVersion: "teop-policy-v1",
      }),
    );
  });
  it("keeps tool continuations and retries on their physical model without classifying", async () => {
    const { jev, ctx, pool } = await boot();
    const previous = { model: pool[2], thinkingLevel: "low" as const };
    const first = await jev.route(request(), ctx);
    ctx.modelRegistry.classify.mockClear();
    const continuation = await jev.route(
      request({ reason: "continuation", previous, state: first.state }),
      ctx,
    );
    expect(continuation.model).toEqual(pool[2]);
    expect(continuation.thinkingLevel).toBe("low");
    expect(continuation.state).toBe(first.state);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });
  it("retries the failed dispatch, not an earlier successful physical model", async () => {
    const { jev, ctx, pool } = await boot();
    const failed = {
      model: pool[1],
      thinkingLevel: "high" as const,
      message: failedMessage("overloaded"),
    };
    const routed = await jev.route(
      request({ reason: "retry", previous: { model: pool[2] }, failed }),
      ctx,
    );
    expect(routed.model).toEqual(pool[1]);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });
  it("does not substitute an older model when routing itself failed before physical dispatch", async () => {
    const { jev, ctx, pool } = await boot();
    await expect(
      jev.route(request({ reason: "retry", previous: { model: pool[2] } }), ctx),
    ).rejects.toThrow("routing failed before physical dispatch");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("pauses exhausted chat subscriptions rather than trying another model", async () => {
    const { jev, ctx, pool, pi } = await boot();
    await expect(
      jev.route(
        request({
          reason: "retry",
          failed: {
            model: pool[1],
            message: failedMessage("subscription quota exhausted; reset tomorrow"),
          },
        }),
        ctx,
      ),
    ).rejects.toThrow("Experiment paused");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ status: "paused" }),
    );
  });
  it("uses branch-local state when a continuation has no previous response", async () => {
    const { rules, ctx } = await boot();
    const branchA = await rules.route(
      request({ messages: [{ role: "user", content: "Find an optimal schedule", timestamp: 1 }] }),
      ctx,
    );
    const branchB = await rules.route(request(), ctx);
    const restoredA = await rules.route(
      request({ reason: "continuation", state: branchA.state }),
      ctx,
    );
    const restoredB = await rules.route(
      request({ reason: "continuation", state: branchB.state }),
      ctx,
    );
    expect(restoredA.model.id).toBe("gpt-6.1-sol");
    expect(restoredB.model.id).toBe("glm-5.3-flash");
    expect(restoredA.state).toBe(branchA.state);
  });
  it("routes direct requests conservatively without creating session state or classifying", async () => {
    const { jev, ctx } = await boot();
    const routed = await jev.route(request({ reason: "direct" }), ctx);
    expect(routed.model.id).toBe("gpt-6.1-sol");
    expect(routed.state).toBeUndefined();
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });
  it("rejects missing, unauthenticated, and virtual destinations", async () => {
    const { rules, ctx } = await boot();
    ctx.modelRegistry.find.mockReturnValue(undefined);
    await expect(rules.route(request(), ctx)).rejects.toThrow("not in the catalog");
    ctx.modelRegistry.find.mockReturnValue(model(specs[2], "pi-virtual"));
    await expect(rules.route(request(), ctx)).rejects.toThrow("physical");
    ctx.modelRegistry.find.mockReturnValue(model(specs[2]));
    ctx.modelRegistry.getAvailable.mockReturnValue([]);
    await expect(rules.route(request(), ctx)).rejects.toThrow("credentials");
  });
  it("bounds classifier evidence, supplies worker role, and captures classifier usage once", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const { jev, ctx, pi } = await boot();
    await jev.route(
      request({
        model: model("virtual-models/jev-v1", "pi-virtual"),
        messages: [{ role: "user", content: "x".repeat(20000), timestamp: 1 }],
      }),
      ctx,
    );
    expect(ctx.modelRegistry.classify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "jev-latest" }),
      expect.objectContaining({ state: { role: "worker", prompt: "x".repeat(12000) } }),
      expect.objectContaining({ timeoutMs: 10000, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({
        classifier: expect.objectContaining({
          status: "ok",
          usage: { input: 31, output: 2, totalTokens: 33 },
        }),
      }),
    );
  });
  it.each(["malformed", "error", "credentials"])(
    "records conservative fallback after classifier %s",
    async (failure) => {
      const { jev, ctx, pi } = await boot();
      if (failure === "credentials") ctx.modelRegistry.getAvailableOfType.mockResolvedValue([]);
      else
        ctx.modelRegistry.classify.mockResolvedValue(
          failure === "error"
            ? { ...result(), stopReason: "error", errorMessage: "classifier unavailable" }
            : { ...result(), answers: {} },
        );
      const routed = await jev.route(request(), ctx);
      expect(routed.model.id).toBe("gpt-6.1-sol");
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "virtual-models-route",
        expect.objectContaining({
          reason: "classifier-fallback",
          classifier: expect.objectContaining({ status: expect.not.stringMatching(/^ok$/) }),
        }),
      );
    },
  );
  it("enforces the classifier deadline even if a provider ignores cancellation", async () => {
    vi.useFakeTimers();
    const { jev, ctx, pi } = await boot();
    ctx.modelRegistry.classify.mockImplementation(() => new Promise(() => {}));
    const pending = jev.route(request(), ctx);
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).model.id).toBe("gpt-6.1-sol");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ classifier: expect.objectContaining({ status: "timeout" }) }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds classifier availability checks as well as inference", async () => {
    vi.useFakeTimers();
    const { jev, ctx, pi } = await boot();
    ctx.modelRegistry.getAvailableOfType.mockImplementation(() => new Promise(() => {}));
    const pending = jev.route(request(), ctx);
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).model.id).toBe("gpt-6.1-sol");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ classifier: expect.objectContaining({ status: "timeout" }) }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an active classifier without fallback and removes timers", async () => {
    vi.useFakeTimers();
    const { jev, ctx } = await boot();
    ctx.modelRegistry.classify.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = jev.route(request({ signal: controller.signal }), ctx);
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels without fallback or classifier dispatch", async () => {
    const { jev, ctx } = await boot();
    await expect(jev.route(request({ signal: AbortSignal.abort() }), ctx)).rejects.toThrow(
      "cancelled",
    );
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });
});
