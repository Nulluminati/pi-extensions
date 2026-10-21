import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionVirtualModel, Model, ModelRouteRequest } from "pi";
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
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("opt-in automatic worker model policy", () => {
  it("registers without changing main or worker defaults", async () => {
    const { pi, router } = await boot();
    expect(router).toMatchObject({ provider: "virtual-models", id: "worker-auto-v1" });
    expect(pi.registerVirtualModel.mock.calls.map(([definition]) => definition.id)).toEqual([
      "rules-v1",
      "jev-v1",
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
            to: MODEL_POOL.deepseek,
            failureKind: "quota",
            decision: "switch",
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

  it.each([MODEL_POOL.glm, "virtual-models/rules-v1", "virtual-models/jev-v1"])(
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
