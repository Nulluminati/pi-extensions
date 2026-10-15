import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionEventMap } from "pi";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const GOAL_OBJECTIVE = "ship the snake game";

type StartupHandler = (
  event: ExtensionEventMap["before_agent_start"],
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => Promise<void> | void;

/** The part of a faux provider request these tests inspect. */
interface ModelRequest {
  messages: unknown[];
}

interface StartupRecord {
  messageType: string;
  customType?: string | undefined;
  idle: boolean;
}

function deferred<T = void>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}

function activeGoalEntry() {
  return {
    goal: {
      id: "goal-test",
      objective: GOAL_OBJECTIVE,
      status: "active",
      startTime: 0,
      elapsedMs: 0,
      iteration: 0,
      tokensUsed: 0,
      baselineTokens: 0,
    },
  };
}

function requestText(context: ModelRequest): string {
  return JSON.stringify(context.messages);
}

/**
 * Starts a real Pi session with an active goal and a probe extension. The faux
 * provider answers every model request, so the session needs no credentials
 * and makes no network requests.
 */
async function startSession(
  options: { onStartup?: StartupHandler; customTools?: { name: string }[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-startup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("PI_SMALL_MODEL", "");
  vi.stubEnv("PI_SMALL_MODEL_CONFIG", join(dir, "missing-small-model.json"));
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
  const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { AuthStorage } = await import(
    pathToFileURL(resolve(agentDist, "core/auth-storage.js")).href
  );

  const faux = ai.fauxProvider();
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const requests: ModelRequest[] = [];
  const reply = (text: string) => (context: ModelRequest) => {
    requests.push(structuredClone(context));
    return ai.fauxAssistantMessage(text);
  };
  faux.setResponses([reply("done"), reply("done again")]);

  const startups: StartupRecord[] = [];
  let agentStarts = 0;
  let settledRun = deferred<{ aborted: boolean }>();
  let probeApi: ExtensionAPI | undefined;
  const probe = (pi: ExtensionAPI) => {
    probeApi = pi;
    pi.on("before_agent_start", async (event, ctx) => {
      startups.push({
        messageType: event.messageType,
        customType: event.messageType === "custom" ? event.message.customType : undefined,
        idle: ctx.isIdle(),
      });
      await options.onStartup?.(event, ctx, pi);
    });
    pi.on("agent_start", () => {
      agentStarts += 1;
    });
    pi.on("agent_settled", (event) => {
      settledRun.resolve({ aborted: event.aborted });
    });
  };

  const sessionManager = sdk.SessionManager.inMemory(dir);
  sessionManager.appendCustomEntry("goal-state", activeGoalEntry());
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: [resolve("extensions/goal/goal.ts")],
    extensionFactories: [probe],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const pi = probeApi;
  if (!pi) throw new Error("probe extension did not load");
  const customTools = options.customTools ?? [];
  const { session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: customTools.map((tool) => tool.name),
    customTools,
  });
  await session.bindExtensions({});

  return {
    ai,
    faux,
    pi,
    session,
    requests,
    startups,
    agentStarts: () => agentStarts,
    /** Resolves with the next agent_settled event. */
    settled: async () => {
      const event = await settledRun.promise;
      settledRun = deferred();
      return event;
    },
    wake: (customType: string, text: string) =>
      pi.sendMessage(
        { customType, content: [{ type: "text", text }], display: false },
        { triggerTurn: true },
      ),
    dispose: () => {
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Pi 1.2.0 custom-message startup", () => {
  it("starts an idle run from a custom message with the goal reminder", async () => {
    const harness = await startSession();
    try {
      harness.wake("probe-wake", "wake up");
      expect(await harness.settled()).toEqual({ aborted: false });
      expect(harness.startups).toEqual([
        { messageType: "custom", customType: "probe-wake", idle: false },
      ]);
      expect(harness.requests).toHaveLength(1);
      expect(requestText(harness.requests[0])).toContain("wake up");
      expect(requestText(harness.requests[0])).toContain(GOAL_OBJECTIVE);
    } finally {
      harness.dispose();
    }
  });

  it("starts a user prompt run with the goal reminder", async () => {
    const harness = await startSession();
    try {
      await harness.session.prompt("hello");
      expect(harness.startups).toEqual([
        { messageType: "user", customType: undefined, idle: false },
      ]);
      expect(harness.requests).toHaveLength(1);
      expect(requestText(harness.requests[0])).toContain("hello");
      expect(requestText(harness.requests[0])).toContain(GOAL_OBJECTIVE);
    } finally {
      harness.dispose();
    }
  });

  it("queues a second wake sent during startup into the starting run", async () => {
    const gate = deferred();
    const entered = deferred();
    let sendError: unknown;
    let startupCount = 0;
    const harness = await startSession({
      onStartup: async (_event, _ctx, pi) => {
        startupCount += 1;
        if (startupCount > 1) return;
        try {
          pi.sendMessage(
            {
              customType: "probe-second-wake",
              content: [{ type: "text", text: "second wake" }],
              display: false,
            },
            { triggerTurn: true },
          );
        } catch (error) {
          sendError = error;
        }
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      harness.wake("probe-wake", "wake up");
      await entered.promise;
      expect(harness.session.isIdle).toBe(false);
      gate.resolve();
      expect(await harness.settled()).toEqual({ aborted: false });
      expect(sendError).toBeUndefined();
      expect(harness.agentStarts()).toBe(1);
      expect(harness.startups).toEqual([
        { messageType: "custom", customType: "probe-wake", idle: false },
      ]);
      const sent = harness.requests.map(requestText).join("\n");
      expect(sent).toContain("wake up");
      expect(sent).toContain("second wake");
    } finally {
      harness.dispose();
    }
  });

  it("aborts a run when cancellation is requested during startup", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "tool ran" }],
      details: {},
    }));
    const probeTool = {
      name: "probe_tool",
      label: "Probe tool",
      description: "Records that the model reached tool execution.",
      parameters: Type.Object({}),
      execute,
    };
    const harness = await startSession({
      customTools: [probeTool],
      onStartup: (_event, ctx) => {
        ctx.abort();
      },
    });
    try {
      harness.faux.setResponses([
        harness.ai.fauxAssistantMessage(harness.ai.fauxToolCall("probe_tool", {}), {
          stopReason: "toolUse",
        }),
        harness.ai.fauxAssistantMessage("continued after the tool"),
      ]);
      harness.wake("probe-wake", "wake up");
      expect(await harness.settled()).toEqual({ aborted: true });
      expect(harness.faux.state.callCount).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});
