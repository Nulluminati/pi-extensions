import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ClassifierContext, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorker } from "../../extensions/workers/src/runner.ts";
import { streamPath } from "../../extensions/workers/src/store.ts";
import {
  DEFAULT_WORKER_EXTENSIONS,
  resolveWorkerExtensions,
} from "../../extensions/workers/src/worker-extensions.ts";

const root = resolve(import.meta.dirname, "../..");
const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const pool = [
  ["zai", "glm-5.3-flash"],
  ["opencode-go", "deepseek-v4.1-flash"],
  ["openai-codex", "gpt-6.1-sol"],
] as const;
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
  vi.stubEnv("PI_WORKER", "1");
  vi.stubEnv("PI_VIRTUAL_MODEL_TRACE", "");
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-worker-recovery-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function offlineSession(retry = true) {
  const dir = await directory();
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
  const providers: Array<{
    provider: unknown;
    state: { callCount: number };
    setResponses(steps: unknown[]): void;
  }> = pool.map(([provider, id]) =>
    ai.fauxProvider({
      provider,
      models: [{ id, reasoning: false, contextWindow: 500000 }],
      tokensPerSecond: 1000000,
    }),
  );
  for (const provider of providers) runtime.registerNativeProvider(provider.provider);
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
  let executions = 0;
  const manager = sdk.SessionManager.create(dir, dir);
  const { session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: true,
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
  const selected = runtime.getModel("virtual-models", "worker-auto-v1");
  expect(selected, "opt-in worker model must register in the real SDK").toBeDefined();
  await session.setModel(selected);
  return { ai, session, manager, runtime, selected, providers, executions: () => executions };
}

describe("real SDK worker recovery with offline providers", () => {
  it("continues a hard quota error without another user message or repeated completed operation", async () => {
    const { ai, session, manager, providers, executions } = await offlineSession();
    providers[0].setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall("complete_once", {})),
      ai.fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "GoUsageLimitError: weekly usage limit reached",
      }),
    ]);
    let replay: Message[] = [];
    providers[1].setResponses([
      (context: { messages: Message[] }) => {
        replay = context.messages;
        return ai.fauxAssistantMessage("recovered");
      },
    ]);
    await session.prompt("Find configuration. Complete the operation once, then finish.");
    expect(executions()).toBe(1);
    expect(providers.map((provider) => provider.state.callCount)).toEqual([2, 1, 0]);
    expect(session.getLastAssistantText()).toBe("recovered");
    expect(session.model.id).toBe("worker-auto-v1");
    expect(replay.filter((message) => message.role === "user")).toHaveLength(1);
    expect(replay.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(
      replay.some((message) => message.role === "assistant" && message.stopReason === "error"),
    ).toBe(false);
    const raw = manager.getBranch();
    const failure = raw.find(
      (entry: { type: string; message: { stopReason?: string } }) =>
        entry.type === "message" && entry.message.stopReason === "error",
    );
    expect(failure?.message.errorMessage).toContain("weekly usage limit");
    expect(raw).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "context_edit", targetId: failure.id, replacement: null }),
        expect.objectContaining({ type: "custom", customType: "virtual-models-worker-recovery" }),
      ]),
    );
  });

  it("uses Jev for initial and replacement choices without duplicate classification or repeated tools", async () => {
    const { ai, runtime, session, providers, executions } = await offlineSession(false);
    const calls: ClassifierContext[] = [];
    runtime.registerNativeProvider(
      ai.createProvider({
        id: "typesafe",
        auth: { apiKey: { name: "Offline Jev", resolve: async () => ({ auth: {} }) } },
        models: [
          {
            type: "classifier",
            id: "jev-latest",
            provider: "typesafe",
            name: "Offline Jev",
            api: "typesafe-system-one",
            input: ["text"],
          },
        ],
        classifiers: {
          "typesafe-system-one": {
            classify: async (_model: unknown, context: ClassifierContext) => {
              calls.push(context);
              const question = context.questions.route;
              if (question?.type !== "choice") throw new Error("Missing routing choice");
              const keys = Object.keys(question.criteria);
              const choice = keys.includes("glm") ? "glm" : "sol";
              return {
                api: "typesafe-system-one",
                provider: "typesafe",
                model: "jev-latest",
                timestamp: 1,
                stopReason: "stop",
                answers: {
                  route: {
                    type: "choice",
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      keys.map((key) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                },
                usage: { input: 12, output: 1, totalTokens: 13 },
              };
            },
          },
        },
      }),
    );
    await runtime.refresh({ allowNetwork: false });
    providers[0].setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall("complete_once", {})),
      ai.fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "weekly usage limit reached",
      }),
    ]);
    providers[2].setResponses([ai.fauxAssistantMessage("Jev recovered")]);
    await session.prompt("Implement a regression test. Complete the operation once, then finish.");
    expect(session.getLastAssistantText()).toBe("Jev recovered");
    expect(providers.map((provider) => provider.state.callCount)).toEqual([2, 0, 1]);
    expect(executions()).toBe(1);
    expect(calls).toHaveLength(2);
    const replacement = calls[1]?.questions.route;
    if (replacement?.type !== "choice") throw new Error("Missing replacement question");
    expect(Object.keys(replacement.criteria).sort()).toEqual(["deepseek", "sol"]);
  });

  it("keeps one transient retry on the same model before selecting an alternative", async () => {
    const { ai, session, providers } = await offlineSession();
    providers[0].setResponses(
      Array.from({ length: 2 }, () =>
        ai.fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 service unavailable",
        }),
      ),
    );
    providers[1].setResponses([ai.fauxAssistantMessage("recovered")]);
    await session.prompt("Find configuration");
    expect(providers.map((provider) => provider.state.callCount)).toEqual([2, 1, 0]);
    expect(session.getLastAssistantText()).toBe("recovered");
  });

  it("recovers quota errors when SDK retries are disabled", async () => {
    const { ai, session, providers } = await offlineSession(false);
    providers[0].setResponses([
      ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
    ]);
    providers[1].setResponses([ai.fauxAssistantMessage("recovered")]);
    await session.prompt("Find configuration");
    expect(providers.map((provider) => provider.state.callCount)).toEqual([1, 1, 0]);
    expect(session.getLastAssistantText()).toBe("recovered");
  });

  it("does not dispatch a fallback after the worker request is cancelled", async () => {
    const { ai, session, providers } = await offlineSession(false);
    let cancellation: Promise<void> | undefined;
    providers[0].setResponses([
      () => {
        cancellation = session.abort();
        return ai.fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "weekly usage limit reached",
        });
      },
    ]);
    await session.prompt("Find configuration");
    await cancellation;
    expect(providers.map((provider) => provider.state.callCount)).toEqual([1, 0, 0]);
  });

  it("does not claim recovery for direct requests outside the agent loop", async () => {
    const { ai, manager, runtime, selected, providers } = await offlineSession(false);
    providers[0].setResponses([
      ai.fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "weekly usage limit reached",
      }),
    ]);
    const result = await runtime
      .streamSimple(selected, {
        messages: [{ role: "user", content: "Find configuration", timestamp: 1 }],
      })
      .result();
    expect(result.stopReason).toBe("error");
    expect(providers.map((provider) => provider.state.callCount)).toEqual([1, 0, 0]);
    expect(
      manager
        .getBranch()
        .some(
          (entry: { type: string; message: { role: string } }) =>
            entry.type === "message" && entry.message.role === "assistant",
        ),
    ).toBe(false);
  });

  it.each([true, false])(
    "bounds persistent temporary failures with SDK retry enabled=%s",
    async (enabled) => {
      const { ai, session, providers } = await offlineSession(enabled);
      for (const provider of providers)
        provider.setResponses(
          Array.from({ length: 12 }, () =>
            ai.fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "503 service unavailable",
            }),
          ),
        );
      await session.prompt("Find configuration");
      expect(providers.map((provider) => provider.state.callCount)).toEqual([2, 2, 2]);
      expect(
        session.messages
          .filter((message: { role: string; stopReason?: string }) => message.role === "assistant")
          .at(-1)?.stopReason,
      ).toBe("error");
    },
  );

  it.each(["401 unauthorized", "maximum context length exceeded"])(
    "does not change providers for %s",
    async (errorMessage) => {
      const { ai, session, providers } = await offlineSession(false);
      providers[0].setResponses([
        ai.fauxAssistantMessage("", { stopReason: "error", errorMessage }),
      ]);
      await session.prompt("Find configuration");
      expect(providers.map((provider) => provider.state.callCount)).toEqual([1, 0, 0]);
    },
  );
});

describe("actual worker process recovery with mandatory safety extensions", () => {
  it.each([
    ["quota", "worker-auto-v1"],
    ["exhausted", "worker-auto-v1"],
    ["quota", "glm-flash-fallback"],
  ])("preserves process, sandbox and terminal status for %s with %s", async (scenario, profile) => {
    const dir = await directory();
    const forbidden = await directory();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await copyFile(join(root, ".pi/sandbox.json"), join(dir, ".pi/sandbox.json"));
    const policy = JSON.parse(await readFile(join(dir, ".pi/sandbox.json"), "utf8"));
    policy.filesystem.denyRead.push(forbidden);
    await writeFile(join(dir, ".pi/sandbox.json"), JSON.stringify(policy));
    await writeFile(join(dir, "probe.txt"), "completed-read");
    const privatePath = join(forbidden, "private.txt");
    await writeFile(privatePath, "private-data-must-stay-hidden");
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    );
    const approvals: unknown[] = [];
    const deniedCommand =
      'node -e \'require("node:fs").writeFileSync("denied.txt","must-not-run")\'';
    const callsPath = join(dir, "calls.jsonl");
    const providerPath = join(dir, "providers.ts");
    const classifierPath = join(dir, "classifier.jsonl");
    await writeFile(
      providerPath,
      `import {appendFileSync} from "node:fs";
import {createProvider,fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default async function(pi){
 const offlineApis=new Set();
 pi.registerProvider(createProvider({id:"typesafe",auth:{apiKey:{name:"Offline classifier",resolve:async()=>({auth:{}})}},models:[{type:"classifier",provider:"typesafe",id:"jev-latest",name:"Offline approval classifier",api:"typesafe-system-one",input:["text"]}],classifiers:{"typesafe-system-one":{classify:async(model,context)=>{appendFileSync(${JSON.stringify(classifierPath)},JSON.stringify({provider:model.provider,questions:Object.keys(context.questions).sort()})+"\\n");if(context.questions.route){const keys=Object.keys(context.questions.route.criteria);const choice=keys.includes("glm")?"glm":keys.includes("deepseek")?"deepseek":"sol";return{provider:"typesafe",model:model.id,api:"typesafe-system-one",timestamp:Date.now(),stopReason:"stop",answers:{route:{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,key===choice?1:0]))}}};}return{provider:"typesafe",model:model.id,api:"typesafe-system-one",timestamp:Date.now(),stopReason:"stop",answers:{harm:{type:"bool",probability:1},secrets:{type:"bool",probability:0},externalChange:{type:"bool",probability:0}}};}}}}));
 for(const [provider,id] of ${JSON.stringify(pool.map(([provider, id]) => (provider === "opencode-go" && profile !== "worker-auto-v1" ? [provider, "glm-5.3-flash"] : [provider, id])))}){
  const faux=fauxProvider({provider,models:[{id,reasoning:false,contextWindow:500000}],tokensPerSecond:1000000});
  const note=(context)=>appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({provider,pid:process.pid,userMessages:context.messages.filter(m=>m.role==="user").length,toolResults:context.messages.filter(m=>m.role==="toolResult").length,failedAssistant:context.messages.some(m=>m.role==="assistant"&&m.stopReason==="error")})+"\\n");
  const quota=(context)=>{note(context);return fauxAssistantMessage("",{stopReason:"error",errorMessage:"weekly usage limit reached"});};
  if(${JSON.stringify(scenario)}==="exhausted")faux.setResponses([quota]);
  else if(provider==="zai")faux.setResponses([(context)=>{note(context);return fauxAssistantMessage(fauxToolCall("read",{path:"probe.txt"}));},quota]);
  else if(provider==="opencode-go")faux.setResponses([(context)=>{note(context);return fauxAssistantMessage(fauxToolCall("read",{path:${JSON.stringify(privatePath)}}));},(context)=>{note(context);return fauxAssistantMessage(fauxToolCall("bash",{command:${JSON.stringify(deniedCommand)}}));},(context)=>{note(context);return fauxAssistantMessage("WORKER_RESULT=done");}]);
  else faux.setResponses([quota]);
  offlineApis.add(faux.api);pi.registerProvider(faux.provider);
 }
 const placeholder=fauxProvider({provider:"synthetic",models:[{id:"offline-unroutable",reasoning:false,contextWindow:500000}],tokensPerSecond:1000000});offlineApis.add(placeholder.api);pi.registerProvider(placeholder.provider);
 pi.on("before_agent_start",(_event,ctx)=>{const providers=new Set(["zai","opencode-go","synthetic","openai-codex"]);const unsafe=ctx.modelRegistry.getAll().some(model=>providers.has(model.provider)&&!offlineApis.has(model.api));if(unsafe){ctx.abort();throw Error("Offline fixture refused a real chat provider");}});
}`,
    );
    execFileSync(process.execPath, ["--check", providerPath]);
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("PI_OFFLINE", "1");
    const config = join(dir, "worker-extensions.json");
    await writeFile(config, JSON.stringify([...DEFAULT_WORKER_EXTENSIONS, "virtual-models"]));
    vi.stubEnv("PI_WORKER_EXTENSIONS_CONFIG", config);
    vi.stubEnv("PI_WORKER_EXTENSIONS", "");
    const extensions = resolveWorkerExtensions(undefined, {
      extensionsRoot: join(root, "extensions"),
    });
    expect(extensions.at(-1)?.name).toBe("worker-sandbox");
    expect(extensions.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["messenger", "worker-blocker", "approval-mode", "virtual-models"]),
    );
    expect(extensions.some((entry) => entry.name === "workers")).toBe(false);
    const id = `w-recovery-${scenario}`;
    const worker = await startWorker({
      cwd: dir,
      task: "Find configuration. Read probe.txt once. Return WORKER_RESULT=done.",
      model: `virtual-models/${profile}`,
      thinkingLevel: "high",
      name: "worker-recovery",
      workerId: id,
      timeoutMs: 20000,
      readOnly: true,
      sandbox: true,
      extensionPaths: [
        ...extensions.slice(0, -1).map((entry) => entry.path),
        providerPath,
        ...extensions.slice(-1).map((entry) => entry.path),
      ],
      events: {
        wake: () => {},
        notify: () => {},
        onChange: () => {},
        onActivity: () => {},
        requestApproval: async (_worker, request) => {
          approvals.push(request);
          return request.kind === "mode" ? { enabled: true } : { approved: false };
        },
      },
      onRecord: async () => {},
    });
    cleanups.push(() => worker.cancel());
    const record = await worker.done;
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(calls.map((call) => call.pid)).size).toBe(1);
    expect(calls.every((call) => call.userMessages === 1 && !call.failedAssistant)).toBe(true);
    const events = (await readFile(streamPath(dir, id), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const assistants = events.filter(
      (event) => event.type === "message_end" && event.message.role === "assistant",
    );
    expect(assistants.every((event) => event.message.api !== "pi-virtual")).toBe(true);
    if (scenario === "exhausted") {
      expect(record.status).toBe("failed");
      expect(record.error).toContain("weekly usage limit");
      expect(calls.map((call) => call.provider)).toEqual(["zai", "opencode-go", "openai-codex"]);
    } else {
      expect(record.status, record.error).toBe("completed");
      expect(record.error).toBeUndefined();
      expect(record.outputText).toBe("WORKER_RESULT=done");
      expect(calls.map((call) => call.provider)).toEqual([
        "zai",
        "zai",
        "opencode-go",
        "opencode-go",
        "opencode-go",
      ]);
      expect(calls[2].toolResults).toBe(1);
      const completed = events.filter(
        (event) =>
          event.type === "tool_execution_start" &&
          event.toolName === "read" &&
          event.args.path === "probe.txt",
      );
      expect(completed).toHaveLength(1);
      const results = events.filter(
        (event) => event.type === "message_end" && event.message.role === "toolResult",
      );
      expect(results[0].message.isError).toBe(false);
      expect(JSON.stringify(results[0].message.content)).toContain("completed-read");
      expect(results[1].message.isError).toBe(true);
      expect(JSON.stringify(results[1].message.content)).not.toContain(
        "private-data-must-stay-hidden",
      );
      expect(approvals).toContainEqual({ kind: "mode" });
      expect(approvals).toContainEqual(
        expect.objectContaining({ kind: "approval", command: deniedCommand, decision: "reject" }),
      );
      const classifiers = (await readFile(classifierPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(classifiers).toEqual([
        ...(profile === "worker-auto-v1"
          ? [
              { provider: "typesafe", questions: ["route"] },
              { provider: "typesafe", questions: ["route"] },
            ]
          : []),
        { provider: "typesafe", questions: ["externalChange", "harm", "secrets"] },
      ]);
      expect(results[2].message.toolName).toBe("bash");
      expect(results[2].message.isError).toBe(true);
      expect(JSON.stringify(results[2].message.content)).toContain("Approval Mode blocked");
      await expect(readFile(join(dir, "denied.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(
      events.some(
        (event) =>
          event.type === "entry_appended" &&
          event.entry.customType ===
            (profile === "worker-auto-v1"
              ? "virtual-models-worker-recovery"
              : "virtual-models-provider-recovery"),
      ),
    ).toBe(true);
  });
});
