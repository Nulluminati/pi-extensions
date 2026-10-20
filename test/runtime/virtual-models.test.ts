import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorker } from "../../extensions/workers/src/runner.ts";
import { streamPath } from "../../extensions/workers/src/store.ts";
import {
  DEFAULT_WORKER_EXTENSIONS,
  resolveWorkerExtensions,
} from "../../extensions/workers/src/worker-extensions.ts";
import { resolveWorkerModelSpec } from "../../lib/worker-model.ts";

const root = resolve(import.meta.dirname, "../..");
const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-virtual-runtime-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("real Pi virtual model integration (offline providers)", () => {
  it("retains virtual selection and branch-local route state through persistent session restoration", async () => {
    const dir = await directory();
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
    vi.stubEnv("PI_WORKER", "");
    const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
    const { AuthStorage } = await import(
      pathToFileURL(join(agentDist, "core/auth-storage.js")).href
    );
    const { getVirtualModelState, getBranchSelection } = await import(
      pathToFileURL(join(agentDist, "core/virtual-models.js")).href
    );
    const runtime = await sdk.ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      modelsStorePath: join(dir, "store"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    for (const [provider, id] of [
      ["openai-codex", "gpt-6.1-sol"],
      ["opencode-go", "deepseek-v4.1-flash"],
      ["zai", "glm-5.3-flash"],
    ]) {
      const faux = ai.fauxProvider({
        provider,
        models: [{ id, reasoning: false, contextWindow: 500000 }],
        tokensPerSecond: 1000000,
      });
      faux.setResponses(Array.from({ length: 5 }, () => ai.fauxAssistantMessage("done")));
      runtime.registerNativeProvider(faux.provider);
    }
    await runtime.refresh({ allowNetwork: false });
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [join(root, "extensions/virtual-models/virtual-models.ts")],
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const manager = sdk.SessionManager.create(dir, dir);
    const { session } = await sdk.createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      thinkingLevel: "medium",
      noTools: true,
    });
    await session.bindExtensions({});
    await session.setModel(runtime.getModel("virtual-models", "rules-v1"));
    try {
      await session.prompt("Find the configuration");
      expect(session.model.id).toBe("rules-v1");
      expect(
        session.messages
          .filter(
            (message: { role: string; errorMessage?: string }) => message.role === "assistant",
          )
          .at(-1)?.errorMessage,
      ).toBeUndefined();
      expect(
        session.messages
          .filter((message: { role: string; model?: string }) => message.role === "assistant")
          .at(-1)?.model,
      ).toBe("glm-5.3-flash");
      const leafA = manager.getLeafId();
      expect(leafA).toBeTruthy();
      await session.prompt("Find an optimal schedule");
      expect(
        session.messages
          .filter((message: { role: string; model?: string }) => message.role === "assistant")
          .at(-1)?.model,
      ).toBe("gpt-6.1-sol");
      const path = manager.getSessionFile();
      expect(path).toBeTruthy();
      const reopened = sdk.SessionManager.open(path);
      expect(
        getBranchSelection(reopened.getBranch(), (provider: string, id: string) =>
          runtime.getModel(provider, id),
        ),
      ).toEqual({ provider: "virtual-models", modelId: "rules-v1" });
      expect(
        getVirtualModelState(reopened.getBranch(), "virtual-models", "rules-v1"),
      ).toMatchObject({ modelSpec: "openai-codex/gpt-6.1-sol" });
      reopened.branch(leafA);
      const stateA = getVirtualModelState(reopened.getBranch(), "virtual-models", "rules-v1");
      expect(stateA).toMatchObject({ modelSpec: "zai/glm-5.3-flash" });
      reopened.appendCompaction("preserved summary", leafA, 100, {});
      expect(getVirtualModelState(reopened.getBranch(), "virtual-models", "rules-v1")).toEqual(
        stateA,
      );
      const routed = await runtime.resolveModel(
        runtime.getModel("virtual-models", "rules-v1"),
        [],
        { reason: "continuation", thinkingLevel: "medium", state: stateA },
      );
      expect(routed.model.id).toBe("glm-5.3-flash");
      expect(routed.thinkingLevel).toBe("off");
      expect(routed.state).toBe(stateA);
    } finally {
      session.dispose();
    }
  });

  it.each(["rules-v1", "jev-v1"])(
    "registers and dispatches %s through the real worker runner without weakening mandatory extensions",
    async (id) => {
      const dir = await directory();
      await mkdir(join(dir, ".pi"), { recursive: true });
      await copyFile(join(root, ".pi/sandbox.json"), join(dir, ".pi/sandbox.json"));
      await writeFile(join(dir, "probe.txt"), "sandbox-probe");
      const forbiddenDirectory = await directory();
      const forbiddenPath = join(forbiddenDirectory, "private.txt");
      await writeFile(forbiddenPath, "must-not-read");
      const policyPath = join(dir, ".pi/sandbox.json");
      const policy = JSON.parse(await readFile(policyPath, "utf8"));
      policy.filesystem.denyRead.push(forbiddenDirectory);
      await writeFile(policyPath, JSON.stringify(policy));
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
      );
      const providerPath = join(dir, "offline-provider.ts");
      await writeFile(
        providerPath,
        `import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};\nexport default async function(pi){for(const [provider,id] of [["zai","glm-5.3-flash"],["openai-codex","gpt-6.1-sol"]]){const faux=fauxProvider({provider,models:[{id,reasoning:false,contextWindow:500000}],tokensPerSecond:1000000});faux.setResponses([fauxAssistantMessage(fauxToolCall("read",{path:"probe.txt"}),{stopReason:"toolUse"}),fauxAssistantMessage(fauxToolCall("read",{path:${JSON.stringify(forbiddenPath)}}),{stopReason:"toolUse"}),fauxAssistantMessage("VIRTUAL_RESULT={\\"ok\\":true}")]);pi.registerProvider(faux.provider);}}`,
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", dir);
      vi.stubEnv("PI_OFFLINE", "1");
      vi.stubEnv("PI_WORKER_MODEL", `virtual-models/${id}`);
      vi.stubEnv("PI_WORKER_MODEL_THINKING", "high");
      vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", join(dir, "trace"));
      const config = join(dir, "worker-extensions.json");
      await writeFile(config, JSON.stringify([...DEFAULT_WORKER_EXTENSIONS, "virtual-models"]));
      vi.stubEnv("PI_WORKER_EXTENSIONS_CONFIG", config);
      vi.stubEnv("PI_WORKER_EXTENSIONS", "");
      const extensions = resolveWorkerExtensions(undefined, {
        extensionsRoot: join(root, "extensions"),
      });
      expect(extensions.at(-1)?.name).toBe("worker-sandbox");
      expect(extensions.map((entry) => entry.name)).toEqual(
        expect.arrayContaining([
          "messenger",
          "worker-blocker",
          "approval-mode",
          "synthetic",
          "neuralwatt",
          "virtual-models",
        ]),
      );
      expect(extensions.some((entry) => entry.name === "workers")).toBe(false);
      const selection = await resolveWorkerModelSpec();
      const worker = await startWorker({
        cwd: dir,
        task: 'Find configuration. Return VIRTUAL_RESULT={"ok":true}.',
        model: selection.model,
        thinkingLevel: selection.thinkingLevel,
        name: "virtual-runtime",
        workerId: `w-runtime-${id}`,
        timeoutMs: 20000,
        readOnly: true,
        sandbox: true,
        extensionPaths: [providerPath, ...extensions.map((entry) => entry.path)],
        events: { wake: () => {}, notify: () => {}, onChange: () => {}, onActivity: () => {} },
        onRecord: async () => {},
      });
      cleanups.push(() => worker.cancel());
      const record = await worker.done;
      expect(record.error).toBeUndefined();
      expect(record.status).toBe("completed");
      expect(record.model).toBe(`virtual-models/${id}`);
      expect(record.outputText).toBe('VIRTUAL_RESULT={"ok":true}');
      const events = (await readFile(streamPath(dir, `w-runtime-${id}`), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const assistant = events.find(
        (event) => event.type === "message_end" && event.message.role === "assistant",
      );
      expect(assistant?.message.model).toBe(id === "rules-v1" ? "glm-5.3-flash" : "gpt-6.1-sol");
      expect(assistant?.message.api).not.toBe("pi-virtual");
      const readResult = events.find(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "toolResult" &&
          event.message.toolName === "read",
      );
      expect(readResult?.message.isError, JSON.stringify(readResult?.message.content)).toBe(false);
      expect(JSON.stringify(readResult?.message.content)).toContain("sandbox-probe");
      const blockedRead = events.filter(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "toolResult" &&
          event.message.toolName === "read",
      )[1];
      expect(blockedRead?.message.isError).toBe(true);
      expect(JSON.stringify(blockedRead?.message.content)).not.toContain("must-not-read");
    },
  );
});
