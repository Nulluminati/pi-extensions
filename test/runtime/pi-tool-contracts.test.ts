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
