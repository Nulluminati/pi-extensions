import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionVirtualModel, Model, ModelRouteRequest } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/virtual-models/virtual-models.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const targets = {
  "glm-flash-fallback-v1": [
    "zai/glm-5.3-flash",
    "synthetic/hf:zai-org/GLM-5.3-Flash",
    "opencode-go/glm-5.3-flash",
  ],
  "deepseek-flash-fallback-v1": [
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "opencode-go/deepseek-v4.1-flash",
  ],
} as const;
type Profile = keyof typeof targets;
const profiles = Object.keys(targets) as Profile[];
const specs = [...Object.values(targets).flat(), "openai-codex/gpt-6.1-sol"];
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
function assistant(id: string, spec: string, error?: string) {
  const physical = model(spec);
  return {
    type: "message",
    id,
    message: {
      ...fauxAssistantMessage(error ? "" : "completed"),
      provider: physical.provider,
      model: physical.id,
      stopReason: error ? ("error" as const) : ("stop" as const),
      ...(error ? { errorMessage: error } : {}),
    },
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
async function boot(
  profile: Profile = "glm-flash-fallback-v1",
  worker = false,
  entries: unknown[] = [],
) {
  vi.stubEnv("PI_WORKER", worker ? "1" : "");
  const pi = createMockPi();
  const ctx = createMockContext();
  const virtual = model(`virtual-models/${profile}`, "pi-virtual");
  ctx.model = virtual;
  const pool = specs.map((spec) => model(spec));
  ctx.modelRegistry.getAvailable.mockReturnValue(pool);
  ctx.modelRegistry.find.mockImplementation((provider, id) =>
    pool.find((item) => item.provider === provider && item.id === id),
  );
  ctx.modelRegistry.classify.mockRejectedValue(
    new Error("Fixed-family profiles must not call Jev"),
  );
  ctx.sessionManager.getBranch.mockReturnValue(entries);
  await extension(pi);
  const router = pi.registerVirtualModel.mock.calls
    .map(([definition]) => definition)
    .find((definition) => definition.id === profile) as ExtensionVirtualModel | undefined;
  const recover = pi.on.mock.calls.find(([name]) => name === "agent_before_settle")?.[1];
  if (!recover) throw new Error("Missing recovery handler");
  function route(overrides: Partial<ModelRouteRequest> = {}) {
    if (!router) throw new Error(`Missing fixed-family router: ${profile}`);
    return router.route(
      {
        model: virtual,
        thinkingLevel: "medium",
        reason: "user",
        messages: [
          { role: "user", content: "Review architecture and security constraints", timestamp: 1 },
        ],
        ...overrides,
      },
      ctx,
    );
  }
  return { pi, ctx, pool, route, recover };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("fixed-family fallback virtual models", () => {
  it("registers both families and worker-auto without retaining pilot routers or changing defaults", async () => {
    const { pi } = await boot();
    expect(pi.registerVirtualModel.mock.calls.map(([definition]) => definition.id)).toEqual([
      "glm-flash-fallback-v1",
      "deepseek-flash-fallback-v1",
      "worker-auto-v1",
    ]);
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  describe.each(profiles)("%s", (profile) => {
    const chain = targets[profile];
    const primary = chain[0];
    const alternate = chain[1];
    const state = (modelSpec: string) => ({ policyVersion: profile, modelSpec });

    it.each([false, true])(
      "uses the preferred provider with no classifier (worker=%s)",
      async (worker) => {
        const { route, ctx, pi } = await boot(profile, worker);
        const result = await route();
        expect(`${result.model.provider}/${result.model.id}`).toBe(primary);
        expect(result.thinkingLevel).toBe("high");
        expect(result.state).toEqual(state(primary));
        expect(ctx.modelRegistry.findOfType).not.toHaveBeenCalled();
        expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
        expect(pi.appendEntry).toHaveBeenCalledWith(
          "virtual-models-route",
          expect.objectContaining({
            selected: `virtual-models/${profile}`,
            dispatched: primary,
            role: worker ? "worker" : "main",
            effectiveThinking: "high",
          }),
        );
      },
    );

    it("skips absent credentials and virtual destinations in provider order", async () => {
      const { route, ctx, pool } = await boot(profile);
      ctx.modelRegistry.getAvailable.mockReturnValue([
        model(primary, "pi-virtual"),
        ...pool.filter((item) => `${item.provider}/${item.id}` !== primary),
      ]);
      const result = await route();
      expect(`${result.model.provider}/${result.model.id}`).toBe(alternate);
    });

    it.each(["continuation", "user", "direct"] as const)(
      "retains a healthy alternate for %s requests",
      async (reason) => {
        const { route, ctx } = await boot(profile);
        const result = await route({ reason, state: state(alternate) });
        expect(`${result.model.provider}/${result.model.id}`).toBe(alternate);
        expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
      },
    );

    it("ignores another profile's restored state and physical previous model", async () => {
      const { route } = await boot(profile);
      const result = await route({
        reason: "continuation",
        state: { policyVersion: "other", modelSpec: "openai-codex/gpt-6.1-sol" },
        previous: { model: model("openai-codex/gpt-6.1-sol") },
      });
      expect(`${result.model.provider}/${result.model.id}`).toBe(primary);
    });

    it.each([false, true])(
      "recovers quota in the same family and omits only the failed response (worker=%s)",
      async (worker) => {
        const failure = assistant("quota", primary, "weekly usage limit reached");
        const { route, ctx, recover } = await boot(profile, worker, [failure]);
        const recovery = await recover(boundary(), ctx);
        expect(recovery).toMatchObject({
          continue: true,
          entries: expect.arrayContaining([
            { type: "context_edit", targetId: "quota", replacement: null },
            expect.objectContaining({
              type: "custom",
              data: expect.objectContaining({
                policyVersion: profile,
                from: primary,
                to: alternate,
              }),
            }),
          ]),
        });
        const result = await route({ reason: "user", state: state(primary) });
        expect(`${result.model.provider}/${result.model.id}`).toBe(alternate);
        expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
      },
    );

    it("retries one temporary failure and switches after the second consecutive failure", async () => {
      const first = assistant("first", primary, "503 service unavailable");
      const { route, ctx, recover } = await boot(profile, false, [first]);
      expect(await recover(boundary(), ctx)).toMatchObject({ continue: true });
      expect((await route({ reason: "continuation", state: state(primary) })).model).toMatchObject(
        model(primary),
      );
      ctx.sessionManager.getBranch.mockReturnValue([
        first,
        assistant("second", primary, "503 service unavailable"),
      ]);
      expect(await recover(boundary(), ctx)).toMatchObject({ continue: true });
      const result = await route({ reason: "continuation", state: state(primary) });
      expect(`${result.model.provider}/${result.model.id}`).toBe(alternate);
    });

    it("exhausts the complete provider chain without switching family or invoking Jev", async () => {
      const failures = chain.map((spec, index) =>
        assistant(`quota-${index}`, spec, "weekly usage limit reached"),
      );
      const { route, ctx, recover } = await boot(profile, false, failures);
      expect(await recover(boundary(), ctx)).toMatchObject({ continue: false });
      await expect(
        route({ reason: "continuation", state: state(chain[chain.length - 1] ?? primary) }),
      ).rejects.toThrow(/exhausted|credentials/);
      expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    });

    it.each([
      "401 unauthorized",
      "403 permission denied",
      "unexpected certificate parsing error",
      "maximum context length is 100 tokens",
    ])("does not recover %s", async (error) => {
      const { ctx, recover } = await boot(profile, false, [assistant("failed", primary, error)]);
      expect(await recover(boundary(), ctx)).toBeUndefined();
    });

    it.each(["aborted", "completed"] as const)("does not recover %s outcomes", async (outcome) => {
      const { ctx, recover } = await boot(profile, false, [
        assistant("failed", primary, "weekly usage limit reached"),
      ]);
      expect(await recover(boundary(outcome), ctx)).toBeUndefined();
    });

    it("stops cancellation before dispatch or recovery", async () => {
      const { route, ctx, recover } = await boot(profile, false, [
        assistant("quota", primary, "weekly usage limit reached"),
      ]);
      const controller = new AbortController();
      controller.abort();
      await expect(route({ signal: controller.signal })).rejects.toThrow(/cancelled/);
      expect(await recover(boundary(), { ...ctx, signal: controller.signal })).toBeUndefined();
    });

    it("does not retry an unrecorded or unsupported failure", async () => {
      const { route } = await boot(profile);
      await expect(route({ reason: "retry" })).rejects.toThrow(/recorded failed physical dispatch/);
    });
  });

  it("does not collect provider usage or loadouts without tracing or a virtual selection", async () => {
    const { pi, ctx } = await boot();
    ctx.model = undefined;
    const usage = pi.on.mock.calls.find(([name]) => name === "provider_stream_event")?.[1];
    const startup = pi.on.mock.calls.find(([name]) => name === "session_start")?.[1];
    if (!usage || !startup) throw new Error("Missing measurement handler");
    await usage(
      {
        type: "provider_stream_event",
        provider: "zai",
        api: "openai-completions",
        model: "glm-5.3-flash",
        data: { usage: { total_tokens: 10 } },
      },
      ctx,
    );
    await startup({ type: "session_start", reason: "startup" }, ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("records the effective loadout without tool descriptions or credentials", async () => {
    const { pi, ctx } = await boot();
    pi.getActiveTools.mockReturnValue(["read", "bash"]);
    pi.getAllTools.mockReturnValue([]);
    const startup = pi.on.mock.calls.find(([name]) => name === "session_start")?.[1];
    if (!startup) throw new Error("Missing startup handler");
    await startup({ type: "session_start", reason: "startup" }, ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "virtual-models-loadout",
      expect.objectContaining({ activeTools: ["bash", "read"], role: "main" }),
    );
  });
});
