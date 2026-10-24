import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ClassifierResult, ExtensionVirtualModel, Model, ModelRouteRequest } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_POOL } from "../../extensions/virtual-models/src/policy.ts";
import extension from "../../extensions/virtual-models/virtual-models.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const selection = "virtual-models/worker-auto-v1";
function model(spec: string, api = "openai-completions"): Model {
  const slash = spec.indexOf("/");
  return {
    provider: spec.slice(0, slash),
    id: spec.slice(slash + 1),
    name: spec,
    api,
    reasoning: true,
    input: ["text"],
    contextWindow: 500000,
    maxTokens: 4096,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  };
}
const virtual = model(selection, "pi-virtual");
function assistant(
  id: string,
  spec: string,
  error?: string,
  stopReason = error ? "error" : "stop",
) {
  const physical = model(spec);
  return {
    type: "message",
    id,
    message: {
      ...fauxAssistantMessage(error ? "" : "completed"),
      provider: physical.provider,
      model: physical.id,
      stopReason,
      ...(error ? { errorMessage: error } : {}),
    },
  };
}
const assignment = {
  type: "message",
  id: "assignment",
  message: { role: "user", content: "Find the configuration", timestamp: 1 },
};
function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    model: virtual,
    thinkingLevel: "high",
    reason: "user",
    messages: [{ role: "user", content: "Find the configuration", timestamp: 1 }],
    ...overrides,
  };
}
function boundary(outcome: "error" | "aborted" | "completed" = "error") {
  return {
    type: "agent_before_settle" as const,
    outcome,
    entries: [],
    continue: false,
    context: {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
  };
}
async function boot(entries: unknown[] = [], worker = true) {
  vi.stubEnv("PI_WORKER", worker ? "1" : "");
  const pi = createMockPi();
  const ctx = createMockContext();
  ctx.model = virtual;
  const pool = Object.values(MODEL_POOL).map((spec) => model(spec));
  ctx.modelRegistry.getAvailable.mockReturnValue(pool);
  ctx.modelRegistry.find.mockImplementation((provider, id) =>
    pool.find((entry) => entry.provider === provider && entry.id === id),
  );
  ctx.sessionManager.getBranch.mockReturnValue(entries);
  await extension(pi);
  const router = pi.registerVirtualModel.mock.calls
    .map(([definition]) => definition)
    .find((definition) => definition.id === "worker-auto-v1") as ExtensionVirtualModel | undefined;
  if (!router) throw new Error("Missing opt-in worker-auto-v1 router");
  const recover = pi.on.mock.calls.find(([name]) => name === "agent_before_settle")?.[1];
  if (!recover) throw new Error("Missing worker recovery boundary");
  return { pi, ctx, pool, router, recover };
}
function classification(choice = "sol", keys = ["sol", "deepseek", "glm"]): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    timestamp: 1,
    stopReason: "stop",
    usage: { input: 20, output: 3, totalTokens: 23 },
    answers: {
      route: {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
      },
    },
  };
}
function enableJev(ctx: ReturnType<typeof createMockContext>, result = classification()) {
  const classifier = model("typesafe/jev-latest", "typesafe-system-one");
  ctx.modelRegistry.findOfType.mockReturnValue(classifier);
  ctx.modelRegistry.getAvailableOfType.mockResolvedValue([classifier]);
  ctx.modelRegistry.classify.mockResolvedValue(result);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("worker model families and provider priorities", () => {
  const syntheticDeepSeek = "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  const syntheticGlm = "synthetic/hf:zai-org/GLM-5.3-Flash";
  const goGlm = "opencode-go/glm-5.3-flash";
  function providers(
    ctx: ReturnType<typeof createMockContext>,
    specs = [...Object.values(MODEL_POOL), syntheticDeepSeek, syntheticGlm, goGlm],
  ) {
    const pool = specs.map((value) => model(value));
    ctx.modelRegistry.getAvailable.mockReturnValue(pool);
    ctx.modelRegistry.find.mockImplementation((provider, id) =>
      pool.find((value) => value.provider === provider && value.id === id),
    );
  }
  const state = (modelSpec: string) => ({ policyVersion: "worker-auto-v1", modelSpec });

  it.each([
    ["deepseek", syntheticDeepSeek],
    ["glm", MODEL_POOL.glm],
    ["sol", MODEL_POOL.sol],
  ])("resolves Jev family %s through its preferred provider", async (choice, expected) => {
    const { ctx, router } = await boot();
    providers(ctx);
    enableJev(ctx, classification(choice));
    const route = await router.route(request(), ctx);
    expect(`${route.model.provider}/${route.model.id}`).toBe(expected);
    const context = ctx.modelRegistry.classify.mock.calls[0]?.[1];
    expect(Object.keys(context?.questions.route?.criteria ?? {}).sort()).toEqual([
      "deepseek",
      "glm",
      "sol",
    ]);
    expect(context?.state).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ model: syntheticDeepSeek }),
        expect.objectContaining({ model: MODEL_POOL.glm }),
      ]),
    });
  });

  it.each([
    [syntheticGlm, [syntheticGlm, goGlm]],
    [goGlm, [goGlm]],
  ])("skips unavailable GLM providers and selects %s", async (expected, eligible) => {
    const { ctx, router } = await boot();
    providers(ctx, eligible);
    expect((await router.route(request(), ctx)).model.id).toBe(model(expected).id);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("uses the next DeepSeek provider before another Jev decision", async () => {
    const { ctx, pi, router } = await boot([
      assignment,
      assistant("quota", syntheticDeepSeek, "weekly usage limit reached"),
    ]);
    providers(ctx);
    enableJev(ctx);
    const route = await router.route(
      request({ reason: "continuation", state: state(syntheticDeepSeek) }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.deepseek);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ reason: "provider-fallback" }),
    );
  });

  it.each([
    [MODEL_POOL.glm, [MODEL_POOL.glm], syntheticGlm],
    [syntheticGlm, [MODEL_POOL.glm, syntheticGlm], goGlm],
  ])("continues GLM on its next provider after %s fails", async (previous, failures, expected) => {
    const entries = failures.map((spec, index) =>
      assistant(`quota-${index}`, spec, "weekly usage limit reached"),
    );
    const { ctx, router } = await boot(entries);
    providers(ctx);
    enableJev(ctx);
    const route = await router.route(
      request({ reason: "continuation", state: state(previous) }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(expected);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("retains the current family when Pi labels a first-request recovery as user", async () => {
    const { ctx, router } = await boot([
      assignment,
      assistant("first-quota", syntheticDeepSeek, "weekly usage limit reached"),
    ]);
    providers(ctx);
    enableJev(ctx);
    const route = await router.route(
      request({ reason: "user", state: state(syntheticDeepSeek) }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.deepseek);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("classifies a genuinely new assignment instead of retaining the prior model", async () => {
    const { ctx, router } = await boot([assistant("old", MODEL_POOL.sol), assignment]);
    providers(ctx);
    enableJev(ctx, classification("glm"));
    const route = await router.route(
      request({ reason: "user", state: state(MODEL_POOL.sol) }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.glm);
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
  });

  it("tries an alternate provider after two temporary endpoint failures", async () => {
    const entries = [
      assistant("first", syntheticDeepSeek, "503 service unavailable"),
      assistant("second", syntheticDeepSeek, "503 service unavailable"),
    ];
    const { ctx, router } = await boot(entries);
    providers(ctx);
    enableJev(ctx);
    expect(
      (
        await router.route(
          request({ reason: "continuation", state: state(syntheticDeepSeek) }),
          ctx,
        )
      ).model.provider,
    ).toBe("opencode-go");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("retains a healthy alternate provider when the preferred provider is available again", async () => {
    const { ctx, router } = await boot([assistant("success", MODEL_POOL.deepseek)]);
    providers(ctx);
    enableJev(ctx);
    const route = await router.route(
      request({ reason: "continuation", state: state(MODEL_POOL.deepseek) }),
      ctx,
    );
    expect(route.model.provider).toBe("opencode-go");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("asks Jev about another family only after the current provider chain is exhausted", async () => {
    const { ctx, router } = await boot([
      assistant("synthetic", syntheticDeepSeek, "weekly usage limit reached"),
      assistant("go", MODEL_POOL.deepseek, "weekly usage limit reached"),
    ]);
    providers(ctx);
    enableJev(ctx, classification("glm", ["glm", "sol"]));
    const route = await router.route(
      request({ reason: "continuation", state: state(MODEL_POOL.deepseek) }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.glm);
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
  });

  it.each(["quota", "temporary"])(
    "stops instead of replacing GPT-6.1 Sol after %s exhaustion",
    async (kind) => {
      const entries =
        kind === "quota"
          ? [assistant("quota", MODEL_POOL.sol, "weekly usage limit reached")]
          : [
              assistant("first", MODEL_POOL.sol, "503 service unavailable"),
              assistant("second", MODEL_POOL.sol, "503 service unavailable"),
            ];
      const { ctx, router, recover } = await boot(entries);
      providers(ctx);
      enableJev(ctx);
      expect(await recover(boundary(), ctx)).toMatchObject({
        continue: false,
        entries: [
          expect.objectContaining({
            data: expect.objectContaining({ decision: "stopped", reason: "codex-no-fallback" }),
          }),
        ],
      });
      await expect(
        router.route(request({ reason: "continuation", state: state(MODEL_POOL.sol) }), ctx),
      ).rejects.toThrow(/Codex|no fallback|stop/i);
      expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    },
  );
});

describe("Jev-primary worker model routing", () => {
  it("honors Jev over a different rule preference and records classifier usage", async () => {
    const { ctx, pi, router } = await boot();
    enableJev(ctx);
    const route = await router.route(request(), ctx);
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.sol);
    expect(ctx.modelRegistry.classify).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", id: "jev-latest" }),
      expect.objectContaining({
        state: expect.objectContaining({ role: "worker", assignment: "Find the configuration" }),
        questions: expect.objectContaining({ route: expect.objectContaining({ type: "choice" }) }),
      }),
      expect.objectContaining({ maxRetries: 0, timeoutMs: 10000 }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({
        reason: "classifier-choice",
        classifier: expect.objectContaining({
          attempted: true,
          status: "ok",
          usage: { input: 20, output: 3, totalTokens: 23 },
        }),
      }),
    );
  });

  it("uses Jev to select a replacement only from eligible physical models", async () => {
    const { ctx, router, recover } = await boot([
      assignment,
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
    ]);
    enableJev(ctx, classification("sol", ["sol", "deepseek"]));
    const resume = await recover(boundary(), ctx);
    expect(resume).toMatchObject({ continue: true });
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    const route = await router.route(
      request({
        reason: "continuation",
        state: { policyVersion: "worker-auto-v1", modelSpec: MODEL_POOL.glm },
      }),
      ctx,
    );
    expect(route.model.id).toBe("gpt-6.1-sol");
    const context = ctx.modelRegistry.classify.mock.calls[0]?.[1];
    expect(Object.keys(context?.questions.route?.criteria ?? {}).sort()).toEqual([
      "deepseek",
      "sol",
    ]);
    expect(JSON.stringify(context)).not.toContain("weekly usage limit reached");
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
  });

  it("does not classify healthy continuations or the first same-model temporary retry", async () => {
    const { ctx, router } = await boot();
    enableJev(ctx);
    const initial = await router.route(request(), ctx);
    ctx.modelRegistry.classify.mockClear();
    const next = await router.route(request({ reason: "continuation", state: initial.state }), ctx);
    expect(next.model.id).toBe("gpt-6.1-sol");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    const error = assistant("temporary", MODEL_POOL.sol, "503 service unavailable");
    ctx.sessionManager.getBranch.mockReturnValue([error]);
    const retry = await router.route(
      request({
        reason: "retry",
        state: initial.state,
        failed: {
          model: initial.model,
          message: error.message as ReturnType<typeof fauxAssistantMessage>,
        },
      }),
      ctx,
    );
    expect(retry.model.id).toBe("gpt-6.1-sol");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it.each(["error", "throw", "malformed", "missing-credentials"])(
    "uses rules only after classifier %s",
    async (failure) => {
      const { ctx, pi, router } = await boot();
      enableJev(ctx);
      if (failure === "error")
        ctx.modelRegistry.classify.mockResolvedValue({ ...classification(), stopReason: "error" });
      if (failure === "throw")
        ctx.modelRegistry.classify.mockRejectedValue(new Error("classifier unavailable"));
      if (failure === "malformed")
        ctx.modelRegistry.classify.mockResolvedValue(classification("outside"));
      if (failure === "missing-credentials")
        ctx.modelRegistry.getAvailableOfType.mockResolvedValue([]);
      expect((await router.route(request(), ctx)).model.id).toBe("glm-5.3-flash");
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "virtual-models-route",
        expect.objectContaining({
          reason: "classifier-fallback",
          classifier: expect.objectContaining({
            status:
              failure === "malformed"
                ? "malformed"
                : failure === "missing-credentials"
                  ? "unavailable"
                  : "error",
          }),
        }),
      );
    },
  );

  it("does not allow a classifier to select an excluded model", async () => {
    const { ctx, router } = await boot([
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
    ]);
    enableJev(ctx, classification("glm"));
    expect((await router.route(request(), ctx)).model.id).toBe("deepseek-v4.1-flash");
  });

  it.each(["keys", "sum", "argmax", "confidence"])(
    "rejects invalid classifier distribution %s",
    async (fault) => {
      const { ctx, router } = await boot();
      const result = classification();
      const answer = result.answers.route;
      if (answer?.type !== "choice") throw new Error("Missing fixture choice");
      if (fault === "keys") delete answer.probabilities.glm;
      if (fault === "sum") answer.probabilities.sol = 0.5;
      if (fault === "argmax") {
        answer.probabilities.sol = 0;
        answer.probabilities.glm = 1;
      }
      if (fault === "confidence") answer.confidence = Number.NaN;
      enableJev(ctx, result);
      expect((await router.route(request(), ctx)).model.id).toBe("glm-5.3-flash");
    },
  );

  it("accepts a valid low-confidence preference without an arbitrary threshold", async () => {
    const { ctx, router } = await boot();
    const result = classification();
    const answer = result.answers.route;
    if (answer?.type !== "choice") throw new Error("Missing fixture choice");
    answer.confidence = 0;
    answer.probabilities = { sol: 1 / 3, deepseek: 1 / 3, glm: 1 / 3 };
    enableJev(ctx, result);
    expect((await router.route(request(), ctx)).model.id).toBe("gpt-6.1-sol");
  });

  it.each(["availability", "inference"])(
    "bounds hung classifier %s before rule fallback",
    async (stage) => {
      vi.useFakeTimers();
      const { ctx, pi, router } = await boot();
      enableJev(ctx);
      if (stage === "availability")
        ctx.modelRegistry.getAvailableOfType.mockImplementation(() => new Promise(() => {}));
      else ctx.modelRegistry.classify.mockImplementation(() => new Promise(() => {}));
      const pending = router.route(request(), ctx);
      await vi.advanceTimersByTimeAsync(10001);
      expect((await pending).model.id).toBe("glm-5.3-flash");
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "virtual-models-route",
        expect.objectContaining({ classifier: expect.objectContaining({ status: "timeout" }) }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not fall back to rules after cancellation during classification", async () => {
    const { ctx, router } = await boot();
    enableJev(ctx);
    const controller = new AbortController();
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ctx.modelRegistry.classify.mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    const pending = router.route(request({ signal: controller.signal }), ctx);
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel|abort/i);
  });

  it("handles a single eligible destination as a constraint rather than rule ranking", async () => {
    const { ctx, pi, pool, router } = await boot();
    enableJev(ctx);
    ctx.modelRegistry.getAvailable.mockReturnValue(
      pool.filter((entry) => entry.id === "deepseek-v4.1-flash"),
    );
    expect((await router.route(request(), ctx)).model.id).toBe("deepseek-v4.1-flash");
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ reason: "only-eligible" }),
    );
  });
});

describe("opt-in automatic worker model policy", () => {
  it("registers without changing main or worker defaults", async () => {
    const { pi, router } = await boot();
    expect(router).toMatchObject({ provider: "virtual-models", id: "worker-auto-v1" });
    expect(pi.registerVirtualModel.mock.calls.map(([definition]) => definition.id)).toEqual([
      "glm-flash-fallback",
      "deepseek-flash-fallback",
      "worker-auto-v1",
    ]);
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it.each([
    ["Find the configuration", MODEL_POOL.glm],
    ["Implement a regression test and fix the parser", MODEL_POOL.deepseek],
    ["Review security and race conditions", MODEL_POOL.sol],
  ])("selects for assignment %s", async (prompt, expected) => {
    const { pi, ctx, router } = await boot();
    const route = await router.route(
      request({ messages: [{ role: "user", content: prompt, timestamp: 1 }] }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(expected);
    expect(route.thinkingLevel).toBe("high");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({
        policyVersion: "worker-auto-v1",
        role: "worker",
        dispatched: expected,
        status: "routed",
      }),
    );
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("retains a healthy physical model after tool results instead of switching phases", async () => {
    const { ctx, router } = await boot();
    const first = await router.route(request(), ctx);
    const next = await router.route(
      request({
        reason: "continuation",
        state: first.state,
        previous: { model: first.model, thinkingLevel: first.thinkingLevel },
        messages: [
          { role: "user", content: "Review security", timestamp: 1 },
          {
            role: "toolResult",
            toolCallId: "tool",
            toolName: "read",
            content: [{ type: "text", text: "Now implement the fix" }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
      ctx,
    );
    expect(next.model.id).toBe(first.model.id);
  });

  it.each([
    "GoUsageLimitError: quota reached",
    "insufficient_quota",
    "subscription_sharing_usage_limit_exceeded",
    "Weekly usage limit reached",
    "insufficient credit balance",
    "403 quota exceeded",
  ])("immediately avoids quota failure %s", async (error) => {
    const { ctx, router } = await boot([assignment, assistant("quota", MODEL_POOL.glm, error)]);
    const route = await router.route(
      request({
        reason: "continuation",
        state: { policyVersion: "worker-auto-v1", modelSpec: MODEL_POOL.glm },
      }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(MODEL_POOL.deepseek);
  });

  it("retries one transient failure, then changes model after the second", async () => {
    const failed = assistant("first", MODEL_POOL.glm, "503 service unavailable");
    const entries = [assignment, failed];
    const { ctx, router } = await boot(entries);
    const first = await router.route(
      request({
        reason: "retry",
        failed: {
          model: model(MODEL_POOL.glm),
          message: failed.message as ReturnType<typeof fauxAssistantMessage>,
        },
      }),
      ctx,
    );
    expect(first.model.id).toBe("glm-5.3-flash");
    entries.push(assistant("second", MODEL_POOL.glm, "503 service unavailable"));
    const second = await router.route(
      request({
        reason: "retry",
        state: first.state,
        failed: {
          model: model(MODEL_POOL.glm),
          message: failed.message as ReturnType<typeof fauxAssistantMessage>,
        },
      }),
      ctx,
    );
    expect(second.model.id).toBe("deepseek-v4.1-flash");
  });

  it("resets consecutive temporary failures after actual success", async () => {
    const failed = assistant("second", MODEL_POOL.glm, "503 service unavailable");
    const { ctx, router } = await boot([
      assistant("first", MODEL_POOL.glm, "503 service unavailable"),
      assistant("success", MODEL_POOL.glm),
      failed,
    ]);
    const route = await router.route(
      request({
        reason: "retry",
        failed: {
          model: model(MODEL_POOL.glm),
          message: failed.message as ReturnType<typeof fauxAssistantMessage>,
        },
      }),
      ctx,
    );
    expect(route.model.id).toBe("glm-5.3-flash");
  });

  it("restores availability from the active branch without leaking a different branch's quota", async () => {
    const { ctx, router } = await boot([
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
      { type: "context_edit", targetId: "quota", replacement: null },
    ]);
    expect((await router.route(request(), ctx)).model.id).toBe("deepseek-v4.1-flash");
    ctx.sessionManager.getBranch.mockReturnValue([assignment]);
    expect((await router.route(request(), ctx)).model.id).toBe("glm-5.3-flash");
    ctx.sessionManager.getBranch.mockReturnValue([
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
      assistant("proof", MODEL_POOL.glm),
    ]);
    expect((await router.route(request(), ctx)).model.id).toBe("glm-5.3-flash");
  });

  it("skips absent credentials and refuses virtual or unapproved alternatives", async () => {
    const { ctx, router } = await boot();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      model(MODEL_POOL.deepseek),
      model(MODEL_POOL.glm, "pi-virtual"),
      model("other/outside"),
    ]);
    expect((await router.route(request(), ctx)).model.id).toBe("deepseek-v4.1-flash");
    ctx.modelRegistry.getAvailable.mockReturnValue([
      model(MODEL_POOL.glm, "pi-virtual"),
      model("other/outside"),
    ]);
    await expect(router.route(request(), ctx)).rejects.toThrow(/pool|available/i);
  });

  it("does not dispatch from a main session", async () => {
    const { pi, ctx, router } = await boot([], false);
    await expect(router.route(request(), ctx)).rejects.toThrow(/worker/i);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-route",
      expect.objectContaining({ role: "main", status: "error" }),
    );
  });

  it("does not retry a routing failure through an older successful model", async () => {
    const { ctx, router } = await boot();
    await expect(
      router.route(request({ reason: "retry", previous: { model: model(MODEL_POOL.sol) } }), ctx),
    ).rejects.toThrow(/dispatch|routing|physical/i);
  });

  it("does not recover a failed dispatch outside the approved physical pool", async () => {
    const failure = assistant("outside", "other/outside", "503 service unavailable");
    const { ctx, router } = await boot([failure]);
    await expect(
      router.route(
        request({
          reason: "retry",
          failed: {
            model: model("other/outside"),
            message: failure.message as ReturnType<typeof fauxAssistantMessage>,
          },
        }),
        ctx,
      ),
    ).rejects.toThrow(/approved|physical/i);
  });

  it("refuses cancelled routing", async () => {
    const { ctx, router } = await boot();
    const controller = new AbortController();
    controller.abort();
    await expect(router.route(request({ signal: controller.signal }), ctx)).rejects.toThrow(
      /cancel|abort/i,
    );
  });
});

describe("worker failure continuation boundary", () => {
  it("omits only the failed assistant and preserves raw history without another user prompt", async () => {
    const entries = [
      assignment,
      {
        type: "message",
        id: "completed-tool",
        message: { role: "toolResult", toolCallId: "done", content: "completed operation" },
      },
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
    ];
    const { pi, ctx, recover } = await boot(entries);
    const result = await recover(boundary(), ctx);
    expect(result).toMatchObject({ continue: true });
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { type: "context_edit", targetId: "quota", replacement: null },
        expect.objectContaining({
          type: "custom",
          customType: "virtual-models-worker-recovery",
          data: expect.objectContaining({
            policyVersion: "worker-auto-v1",
            from: MODEL_POOL.glm,
            to: null,
            candidates: expect.arrayContaining([MODEL_POOL.deepseek, MODEL_POOL.sol]),
            failureKind: "quota",
            decision: "select",
          }),
        }),
      ]),
    );
    expect(entries).toHaveLength(3);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it.each([
    "401 unauthorized",
    "401 unauthorized: quota limit metadata",
    "permission denied: subscription usage limit",
    "403 permission denied",
    "403 permission denied; 429 rate limit policy",
    "400 invalid request",
    "maximum context length exceeded",
    "tool sandbox initialization failed",
  ])("does not recover non-availability error %s", async (error) => {
    const { ctx, recover } = await boot([assistant("error", MODEL_POOL.glm, error)]);
    expect(await recover(boundary(), ctx)).toBeUndefined();
  });

  it.each(["aborted", "completed"] as const)("does not recover %s activity", async (outcome) => {
    const { ctx, recover } = await boot([
      assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
    ]);
    expect(await recover(boundary(outcome), ctx)).toBeUndefined();
  });

  it.each([MODEL_POOL.glm, "virtual-models/unregistered"])(
    "leaves selection %s unchanged",
    async (selected) => {
      const { ctx, recover } = await boot([
        assistant("quota", MODEL_POOL.glm, "weekly usage limit reached"),
      ]);
      ctx.model = model(selected);
      expect(await recover(boundary(), ctx)).toBeUndefined();
    },
  );

  it("does not recover in main sessions or after cancellation", async () => {
    const { ctx, recover } = await boot(
      [assistant("quota", MODEL_POOL.glm, "weekly usage limit reached")],
      false,
    );
    expect(await recover(boundary(), ctx)).toBeUndefined();
    const active = await boot([assistant("quota", MODEL_POOL.glm, "weekly usage limit reached")]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await active.recover(boundary(), { ...active.ctx, signal: controller.signal }),
    ).toBeUndefined();
  });

  it("stops when the approved pool is exhausted", async () => {
    const entries = Object.values(MODEL_POOL).map((spec, index) =>
      assistant(`quota-${index}`, spec, "weekly usage limit reached"),
    );
    const { ctx, router, recover } = await boot(entries);
    expect(await recover(boundary(), ctx)).toMatchObject({
      continue: false,
      entries: [
        expect.objectContaining({
          type: "custom",
          customType: "virtual-models-worker-recovery",
          data: expect.objectContaining({ decision: "exhausted" }),
        }),
      ],
    });
    await expect(router.route(request(), ctx)).rejects.toThrow(/pool|available/i);
  });

  it("does not reuse an older physical failure after a virtual routing error", async () => {
    const { ctx, recover } = await boot([
      assistant("old", MODEL_POOL.glm, "weekly usage limit reached"),
      assistant("routing", selection, "routing failed before physical dispatch"),
    ]);
    expect(await recover(boundary(), ctx)).toBeUndefined();
  });
});
