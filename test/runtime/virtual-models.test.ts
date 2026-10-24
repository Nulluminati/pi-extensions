import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chains = {
  glm: ["zai/glm-5.3-flash", "synthetic/hf:zai-org/GLM-5.3-Flash", "opencode-go/glm-5.3-flash"],
  deepseek: [
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "opencode-go/deepseek-v4.1-flash",
  ],
} as const;
const endpoints = [...Object.values(chains).flat(), "openai-codex/gpt-6.1-sol"];
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  for (const name of [
    "TYPESAFE_API_KEY",
    "SYNTHETIC_API_KEY",
    "ZAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("PI_WORKER", "");
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});
async function offlineSession(
  family: keyof typeof chains,
  failure: "quota" | "temporary" | "exhausted",
  retry = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-family-fallback-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
  const { AuthStorage } = await import(pathToFileURL(join(dist, "core/auth-storage.js")).href);
  const runtime = await sdk.ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    modelsStorePath: join(dir, "models"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const chain: readonly string[] = chains[family];
  const calls: Array<{ spec: string; messages: Message[] }> = [];
  for (const provider of new Set(endpoints.map((spec) => spec.slice(0, spec.indexOf("/"))))) {
    const ids = endpoints
      .filter((spec) => spec.startsWith(`${provider}/`))
      .map((spec) => spec.slice(provider.length + 1));
    const faux = ai.fauxProvider({
      provider,
      models: ids.map((id) => ({ id, reasoning: false, contextWindow: 500000 })),
      tokensPerSecond: 1000000,
    });
    const steps = new Map<string, number>();
    const respond = (
      context: { messages: Message[] },
      _options: unknown,
      _state: unknown,
      model: { id: string },
    ) => {
      const spec = `${provider}/${model.id}`;
      if (!chain.includes(spec)) throw new Error(`Fixed-family routing escaped to ${spec}`);
      calls.push({ spec, messages: [...context.messages] });
      const step = steps.get(spec) ?? 0;
      steps.set(spec, step + 1);
      if (spec === chain[0] && step === 0)
        return ai.fauxAssistantMessage(ai.fauxToolCall("complete_once", {}));
      if (failure === "exhausted" || spec !== chain.at(-1))
        return ai.fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage:
            failure === "temporary" ? "503 service unavailable" : "weekly usage limit reached",
        });
      return ai.fauxAssistantMessage("FAMILY_RESULT=done");
    };
    faux.setResponses(Array.from({ length: 20 }, () => respond));
    runtime.registerNativeProvider(faux.provider);
  }
  let classifications = 0;
  runtime.registerNativeProvider(
    ai.createProvider({
      id: "typesafe",
      auth: { apiKey: { name: "Offline classifier trap", resolve: async () => ({ auth: {} }) } },
      models: [
        {
          type: "classifier",
          provider: "typesafe",
          id: "jev-latest",
          name: "Offline trap",
          api: "typesafe-system-one",
          input: ["text"],
        },
      ],
      classifiers: {
        "typesafe-system-one": {
          classify: async () => {
            classifications++;
            throw new Error("Fixed-family model called Jev");
          },
        },
      },
    }),
  );
  await runtime.refresh({ allowNetwork: false });
  const settings = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: retry, maxRetries: 8, baseDelayMs: 1, maxAgentDelayMs: 1 },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: [join(root, "extensions/virtual-models/virtual-models.ts")],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const manager = sdk.SessionManager.create(dir, dir);
  let executions = 0;
  const { session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: true,
    thinkingLevel: "high",
    customTools: [
      {
        name: "complete_once",
        label: "Complete once",
        description: "Record one completed operation",
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return {
            content: [{ type: "text", text: "operation completed" }],
            details: { executions },
          };
        },
      },
    ],
  });
  cleanups.push(() => session.dispose());
  await session.bindExtensions({});
  const id = `${family}-flash-fallback`;
  const selected = runtime.getModel("virtual-models", id);
  expect(selected, "Fixed-family profile must register in the actual SDK").toBeDefined();
  await session.setModel(selected);
  return {
    id,
    selected,
    session,
    manager,
    runtime,
    calls,
    chain,
    executions: () => executions,
    classifications: () => classifications,
  };
}

describe.each(["glm", "deepseek"] as const)("main-session %s fallback (offline SDK)", (family) => {
  it.each([
    ["quota", false],
    ["quota", true],
    ["temporary", false],
    ["temporary", true],
  ] as const)(
    "recovers %s with SDK retries=%s without duplicate tools or user messages",
    async (failure, retry) => {
      const { id, session, manager, calls, chain, executions, classifications } =
        await offlineSession(family, failure, retry);
      await session.prompt("Complete one operation and return FAMILY_RESULT=done.");
      expect(session.getLastAssistantText()).toBe("FAMILY_RESULT=done");
      expect(session.model.id).toBe(id);
      expect(executions()).toBe(1);
      expect(classifications()).toBe(0);
      const repeats = failure === "temporary" ? 2 : 1;
      expect(calls.map((call) => call.spec)).toEqual([
        chain[0],
        ...chain.slice(0, -1).flatMap((spec) => Array.from({ length: repeats }, () => spec)),
        chain.at(-1),
      ]);
      expect(
        calls.every(
          (call) => call.messages.filter((message) => message.role === "user").length === 1,
        ),
      ).toBe(true);
      const replay = calls.at(-1)?.messages ?? [];
      expect(replay.filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(
        replay.some((message) => message.role === "assistant" && message.stopReason === "error"),
      ).toBe(false);
      const raw = manager.getBranch();
      expect(raw.some((entry: { type: string }) => entry.type === "context_edit")).toBe(true);
      expect(
        raw.filter(
          (entry: { type: string; message?: { stopReason?: string } }) =>
            entry.type === "message" && entry.message?.stopReason === "error",
        ),
      ).toHaveLength((chain.length - 1) * repeats);
    },
  );

  it("stops when its family is exhausted despite other authenticated models", async () => {
    const { session, calls, chain, executions, classifications } = await offlineSession(
      family,
      "exhausted",
    );
    await session.prompt("Complete one operation.");
    const last = session.messages
      .filter((message: { role: string }) => message.role === "assistant")
      .at(-1);
    expect(last?.stopReason).toBe("error");
    expect(calls.map((call) => call.spec)).toEqual([chain[0], ...chain]);
    expect(executions()).toBe(1);
    expect(classifications()).toBe(0);
  });

  it("retains the alternate across user requests and restores branch-local state from disk", async () => {
    const { id, selected, session, manager, runtime, calls, chain, executions, classifications } =
      await offlineSession(family, "quota");
    await session.prompt("Complete one operation.");
    const initialCalls = calls.length;
    await session.prompt("Continue on the healthy provider.");
    expect(calls.slice(initialCalls).map((call) => call.spec)).toEqual([chain.at(-1)]);
    expect(executions()).toBe(1);
    expect(classifications()).toBe(0);
    const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { getVirtualModelState, getBranchSelection } = await import(
      pathToFileURL(join(dist, "core/virtual-models.js")).href
    );
    const path = manager.getSessionFile();
    if (!path) throw new Error("Missing persistent session file");
    const reopened = sdk.SessionManager.open(path);
    expect(
      getBranchSelection(reopened.getBranch(), (provider: string, model: string) =>
        runtime.getModel(provider, model),
      ),
    ).toEqual({ provider: "virtual-models", modelId: id });
    expect(getVirtualModelState(reopened.getBranch(), "virtual-models", id)).toMatchObject({
      policyVersion: id,
      modelSpec: chain.at(-1),
    });
    const tool = manager
      .getBranch()
      .find(
        (entry: { type: string; message?: { role?: string } }) =>
          entry.type === "message" && entry.message?.role === "toolResult",
      );
    if (!tool) throw new Error("Missing completed operation entry");
    manager.branch(tool.id);
    const state = getVirtualModelState(manager.getBranch(), "virtual-models", id);
    expect(state).toMatchObject({ modelSpec: chain[0] });
    manager.appendCompaction("preserved summary", tool.id, 100, {});
    expect(getVirtualModelState(manager.getBranch(), "virtual-models", id)).toEqual(state);
    const routed = await runtime.resolveModel(selected, [], {
      reason: "continuation",
      thinkingLevel: "high",
      state,
    });
    expect(`${routed.model.provider}/${routed.model.id}`).toBe(chain[0]);
    expect(routed.thinkingLevel).toBe("off");
  });
});
