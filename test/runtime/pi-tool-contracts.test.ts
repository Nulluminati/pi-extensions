import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

async function load(name: string) {
  const { loadExtensions } = await import(
    pathToFileURL(resolve(agentDist, "core/extensions/loader.js")).href
  );
  const result = await loadExtensions([resolve("extensions", name, `${name}.ts`)], process.cwd());
  expect(result.errors).toEqual([]);
  expect(result.extensions).toHaveLength(1);
  return result.extensions[0];
}

afterEach(() => vi.unstubAllEnvs());

describe("real Pi tool contracts", () => {
  it("retains built-in prompt metadata on every sandbox tool override", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const extension = await load("worker-sandbox");
    for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      const tool = extension.tools.get(name)?.definition;
      expect(tool, name).toBeDefined();
      expect(tool.promptSnippet, name).toBeTypeOf("string");
      expect(tool.promptSnippet.length, name).toBeGreaterThan(0);
    }
  });

  it("keeps ask_user outside the real codemode callable-tool list", async () => {
    const extension = await load("ask-user");
    const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { AuthStorage } = await import(
      pathToFileURL(resolve(agentDist, "core/auth-storage.js")).href
    );
    const registered = extension.tools.get("ask_user");
    expect(registered.definition.exposure).toBe("model-only");
    const cwd = mkdtempSync(join(tmpdir(), "pi-runtime-"));
    try {
      const settingsManager = sdk.SettingsManager.inMemory();
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const modelRuntime = await sdk.ModelRuntime.create({
        credentials: AuthStorage.inMemory(),
        modelsPath: null,
        modelsStorePath: join(cwd, "models-store"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const model = modelRuntime.getModels()[0];
      expect(model).toBeDefined();
      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime,
        model,
        settingsManager,
        resourceLoader,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        tools: ["ask_user"],
        customTools: [registered.definition],
      });
      try {
        expect(session.getActiveToolNames()).toContain("ask_user");
        expect(session.getCallableToolNames()).not.toContain("ask_user");
        expect(session.extensionRunner.createToolContext().tools).toEqual([]);
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid web_fetch URLs as errors in the real agent tool pipeline", async () => {
    const extension = await load("web-search");
    const { wrapRegisteredTool } = await import(
      pathToFileURL(resolve(agentDist, "core/extensions/wrapper.js")).href
    );
    const agentCoreManifest = createRequire(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).resolve("@earendil-works/pi-agent-core/package.json");
    const { runToolCall } = await import(
      pathToFileURL(resolve(dirname(agentCoreManifest), "dist/index.js")).href
    );
    const tool = wrapRegisteredTool(extension.tools.get("web_fetch"), {
      createToolContext: () => ({ hasUI: false, mode: "json" }),
    });
    const tools = [tool];
    const outcome = await runToolCall(
      {
        type: "toolCall",
        id: "invalid-url",
        name: "web_fetch",
        arguments: { url: "mailto:test@example.com" },
      },
      {
        tools,
        context: { messages: [], tools },
        assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.result.details.isError).toBe(true);
  });
});

const GOAL_DISCOVERY = "/goal:new <objective>";
const WEB_FETCH_RULE = "fetch it directly";
const PROBE_RULE = "Probe extension rule.";

/** The system messages of one faux provider request. */
interface SystemMessage {
  role: "system";
}

/**
 * Starts a real Pi session with web-search, goal, and a probe extension that
 * adds its own guideline. The faux provider records every request, so no
 * credentials or network access are needed.
 */
async function startGuidanceSession(options: { activeGoal?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-guidance-"));
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
  const requests: Array<{ messages: Array<{ role: string }> }> = [];
  const reply = (context: { messages: Array<{ role: string }> }) => {
    requests.push(structuredClone(context));
    return ai.fauxAssistantMessage("done");
  };
  faux.setResponses([reply, reply, reply]);

  // biome-ignore lint/suspicious/noExplicitAny: probe receives the untyped Pi API
  const probe = (pi: any) => {
    pi.on(
      "before_agent_start",
      (event: { systemPromptOptions: { promptGuidelines: string[] } }) => {
        event.systemPromptOptions.promptGuidelines.push(PROBE_RULE);
      },
    );
  };
  const sessionManager = sdk.SessionManager.inMemory(dir);
  if (options.activeGoal) {
    sessionManager.appendCustomEntry("goal-state", {
      goal: {
        id: "goal-test",
        objective: "ship the snake game",
        status: "active",
        startTime: 0,
        elapsedMs: 0,
        iteration: 0,
        tokensUsed: 0,
        baselineTokens: 0,
      },
    });
  }
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: [
      resolve("extensions/web-search/web-search.ts"),
      resolve("extensions/goal/goal.ts"),
    ],
    extensionFactories: [probe],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  await session.bindExtensions({});
  return {
    session,
    requests,
    systemText: (index: number) =>
      requests[index].messages
        .filter((message): message is SystemMessage => message.role === "system")
        .map((message) => ai.getSystemMessageText(message))
        .join("\n"),
    dispose: () => {
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("real Pi prompt guidance delivery", () => {
  it("renders active tool guidance, goal discovery, and other guidelines once each", async () => {
    const harness = await startGuidanceSession();
    try {
      await harness.session.prompt("hello");
      const text = harness.systemText(0);
      expect(occurrences(text, WEB_FETCH_RULE)).toBe(1);
      expect(occurrences(text, GOAL_DISCOVERY)).toBe(1);
      expect(occurrences(text, PROBE_RULE)).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("drops guidance for inactive tools but keeps goal discovery", async () => {
    const harness = await startGuidanceSession();
    try {
      harness.session.setActiveToolsByName(["read", "bash"]);
      await harness.session.prompt("hello");
      const text = harness.systemText(0);
      expect(text).not.toContain(WEB_FETCH_RULE);
      expect(occurrences(text, GOAL_DISCOVERY)).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("keeps the rules section stable across runs and goal states", async () => {
    const idle = await startGuidanceSession();
    const active = await startGuidanceSession({ activeGoal: true });
    try {
      await idle.session.prompt("first");
      await idle.session.prompt("second");
      await active.session.prompt("first");
      // A second run with an unchanged prompt sends no system patch.
      const secondRunSystemMessages = idle.requests[1].messages.filter(
        (message) => message.role === "system",
      );
      expect(secondRunSystemMessages).toHaveLength(1);
      expect(idle.systemText(1)).toBe(idle.systemText(0));
      const rules = (text: string) => text.match(/<rules>[\s\S]*?<\/rules>/)?.[0];
      expect(rules(active.systemText(0))).toBeDefined();
      expect(rules(active.systemText(0))).toBe(rules(idle.systemText(0)));
      expect(active.systemText(0)).not.toContain("ship the snake game");
    } finally {
      idle.dispose();
      active.dispose();
    }
  });
});
