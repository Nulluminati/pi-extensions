import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatWorkerLine, formatWorkerStatus } from "../../extensions/workers/src/format.ts";
import { startWorker } from "../../extensions/workers/src/runner.ts";
import { streamPath } from "../../extensions/workers/src/store.ts";
import {
  DEFAULT_WORKER_EXTENSIONS,
  resolveWorkerExtensions,
} from "../../extensions/workers/src/worker-extensions.ts";

const root = resolve(import.meta.dirname, "../..");
const endpoints = [
  ["synthetic", "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"],
  ["opencode-go", "deepseek-v4.1-flash"],
  ["zai", "glm-5.3-flash"],
  ["synthetic", "hf:zai-org/GLM-5.3-Flash"],
  ["opencode-go", "glm-5.3-flash"],
  ["openai-codex", "gpt-6.1-sol"],
];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  for (const name of [
    "TYPESAFE_API_KEY",
    "SYNTHETIC_API_KEY",
    "ZAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});

describe("actual worker provider priorities and physical-model visibility (offline)", () => {
  it.each([
    ["deepseek", "worker-auto-v1"],
    ["deepseek-first", "worker-auto-v1"],
    ["glm", "worker-auto-v1"],
    ["codex-quota", "worker-auto-v1"],
    ["codex-temporary", "worker-auto-v1"],
    ["deepseek", "deepseek-flash-fallback"],
    ["deepseek-first", "deepseek-flash-fallback"],
    ["glm", "glm-flash-fallback"],
  ])("enforces %s behavior with %s in one worker process", async (scenario, profile) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-worker-providers-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await copyFile(join(root, ".pi/sandbox.json"), join(dir, ".pi/sandbox.json"));
    await writeFile(join(dir, "probe.txt"), "one completed read");
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    );
    const releasePath = join(dir, "release");
    const callsPath = join(dir, "calls.jsonl");
    const choicesPath = join(dir, "choices.jsonl");
    const providerPath = join(dir, "offline-providers.ts");
    await writeFile(
      providerPath,
      `import {appendFileSync,existsSync,watch} from "node:fs";
import {createProvider,fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const scenario=${JSON.stringify(scenario)};
const family=scenario.startsWith("deepseek")?"deepseek":scenario;
const endpoints=${JSON.stringify(endpoints)};
const release=${JSON.stringify(releasePath)};
async function waitForDisplay(){if(existsSync(release))return;await new Promise(resolve=>{const watcher=watch(${JSON.stringify(dir)},()=>{if(existsSync(release)){watcher.close();resolve();}});if(existsSync(release)){watcher.close();resolve();}});}
export default async function(pi){
 const offlineApis=new Set();
 pi.registerProvider(createProvider({id:"typesafe",auth:{apiKey:{name:"Offline Jev",resolve:async()=>({auth:{}})}},models:[{type:"classifier",provider:"typesafe",id:"jev-latest",name:"Offline Jev",api:"typesafe-system-one",input:["text"]}],classifiers:{"typesafe-system-one":{classify:async(model,context)=>{const keys=Object.keys(context.questions.route.criteria);const choice=scenario.startsWith("codex")?"sol":family;appendFileSync(${JSON.stringify(choicesPath)},JSON.stringify({keys,choice})+"\\n");return{api:"typesafe-system-one",provider:"typesafe",model:model.id,timestamp:1,stopReason:"stop",answers:{route:{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,key===choice?1:0]))}}};}}}}));
 for(const provider of new Set(endpoints.map(([provider])=>provider))){
  const ids=endpoints.filter(([name])=>name===provider).map(([,id])=>id);
  const faux=fauxProvider({provider,models:ids.map(id=>({id,reasoning:false,contextWindow:500000})),tokensPerSecond:1000000});
  const steps=new Map();
  const respond=async(context,_options,_state,model)=>{
   const index=steps.get(model.id)||0;steps.set(model.id,index+1);
   appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({provider,model:model.id,pid:process.pid,userCount:context.messages.filter(message=>message.role==="user").length,toolResults:context.messages.filter(message=>message.role==="toolResult").length})+"\\n");
   const quota=()=>fauxAssistantMessage("",{stopReason:"error",errorMessage:"weekly usage limit reached"});
   if(scenario.startsWith("codex")){if(provider!=="openai-codex")throw Error("Codex replacement was dispatched");return scenario==="codex-temporary"?fauxAssistantMessage("",{stopReason:"error",errorMessage:"503 service unavailable"}):quota();}
   const primary=family==="deepseek"?provider==="synthetic"&&model.id.endsWith("1017"):provider==="zai";
   if(primary)return scenario==="deepseek-first"?quota():index===0?fauxAssistantMessage(fauxToolCall("read",{path:"probe.txt"})):quota();
   if(scenario==="glm"&&provider==="synthetic")return quota();
   const expected=family==="deepseek"?"deepseek-v4.1-flash":"glm-5.3-flash";
   if(provider!=="opencode-go"||model.id!==expected)throw Error("Wrong provider/model target");
   await waitForDisplay();
   return fauxAssistantMessage("PROVIDER_RESULT=done");
  };
  faux.setResponses(Array.from({length:12},()=>respond));offlineApis.add(faux.api);pi.registerProvider(faux.provider);
 }
 pi.on("before_agent_start",(_event,ctx)=>{const unsafe=ctx.modelRegistry.getAll().some(model=>endpoints.some(([provider,id])=>model.provider===provider&&model.id===id)&&!offlineApis.has(model.api));if(unsafe){ctx.abort();throw Error("Offline fixture refused a real chat provider");}});
}`,
    );
    execFileSync(process.execPath, ["--check", providerPath]);
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const config = join(dir, "worker-extensions.json");
    await writeFile(config, JSON.stringify([...DEFAULT_WORKER_EXTENSIONS, "virtual-models"]));
    vi.stubEnv("PI_WORKER_EXTENSIONS_CONFIG", config);
    vi.stubEnv("PI_WORKER_EXTENSIONS", "");
    const extensions = resolveWorkerExtensions(undefined, {
      extensionsRoot: join(root, "extensions"),
    });
    expect(extensions.at(-1)?.name).toBe("worker-sandbox");
    expect(extensions.some((entry) => entry.name === "workers")).toBe(false);
    const expected = scenario.startsWith("deepseek")
      ? "opencode-go/deepseek-v4.1-flash"
      : "opencode-go/glm-5.3-flash";
    let running: Awaited<ReturnType<typeof startWorker>> | undefined;
    let liveDisplay = false;
    const worker = await startWorker({
      cwd: dir,
      task: "Find configuration. Read probe.txt once. Return PROVIDER_RESULT=done.",
      model: `virtual-models/${profile}`,
      thinkingLevel: "high",
      name: "provider-priority",
      workerId: `w-providers-${scenario}`,
      timeoutMs: 60_000,
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
        onActivity: () => {
          if (running?.record.physicalModel === expected && running.record.status === "running") {
            liveDisplay = true;
            writeFileSync(releasePath, "displayed");
          }
        },
      },
      onRecord: async () => {},
    });
    running = worker;
    cleanups.push(() => worker.cancel());
    const record = await worker.done;
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const choiceText = await readFile(choicesPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const choices = choiceText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(new Set(calls.map((call) => call.pid)).size).toBe(1);
    expect(calls.every((call) => call.userCount === 1)).toBe(true);
    expect(choices).toHaveLength(profile === "worker-auto-v1" ? 1 : 0);
    if (profile === "worker-auto-v1")
      expect(choices[0].keys.sort()).toEqual(["deepseek", "glm", "sol"]);
    expect(record.model).toBe(`virtual-models/${profile}`);
    if (scenario.startsWith("codex")) {
      expect(record.status).toBe("failed");
      expect(record.physicalModel).toBe("openai-codex/gpt-6.1-sol");
      expect(calls).toHaveLength(scenario === "codex-quota" ? 1 : 2);
      expect(calls.every((call) => call.provider === "openai-codex")).toBe(true);
      expect(formatWorkerStatus(record)).toContain("Physical model: openai-codex/gpt-6.1-sol");
    } else {
      expect(record.status, record.error).toBe("completed");
      expect(record.outputText).toBe("PROVIDER_RESULT=done");
      expect(record.physicalModel).toBe(expected);
      expect(record.physicalThinkingLevel).toBe("off");
      expect(liveDisplay).toBe(true);
      expect(formatWorkerLine(record)).toContain("opencode-go");
      expect(formatWorkerStatus(record)).toContain(`Physical model: ${expected}`);
      expect(calls.map((call) => `${call.provider}/${call.model}`)).toEqual(
        scenario === "deepseek-first"
          ? ["synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", expected]
          : scenario === "deepseek"
            ? [
                "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
                "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
                expected,
              ]
            : [
                "zai/glm-5.3-flash",
                "zai/glm-5.3-flash",
                "synthetic/hf:zai-org/GLM-5.3-Flash",
                expected,
              ],
      );
      expect(calls.at(-1)?.toolResults).toBe(scenario === "deepseek-first" ? 0 : 1);
      const events = (await readFile(streamPath(dir, record.id), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) => event.type === "tool_execution_start" && event.toolName === "read",
        ),
      ).toHaveLength(scenario === "deepseek-first" ? 0 : 1);
    }
  });
});
