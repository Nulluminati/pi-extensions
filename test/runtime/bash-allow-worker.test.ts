import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningWorker, startWorker } from "../../extensions/workers/src/runner.ts";
import { stderrLogPath, streamPath } from "../../extensions/workers/src/store.ts";
import type { WorkerEvents, WorkerRecord } from "../../extensions/workers/src/types.ts";

const CLI = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);
const AI_ENTRY = import.meta.resolve("@earendil-works/pi-ai");
let cwd: string;
let providerPath: string;
let running: RunningWorker | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-allow-worker-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  // A conflicting inherited list proves the child uses its startup flag.
  vi.stubEnv("PI_BASH_ALLOW", "touch:*");
  const wrapper = join(cwd, "pi-worker.mjs");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [${JSON.stringify(CLI)}, "--offline", "--no-skills", "--no-prompt-templates", "--no-themes", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`,
  );
  await chmod(wrapper, 0o755);
  vi.stubEnv("PI_WORKER_COMMAND", wrapper);
  providerPath = join(cwd, "scripted-provider.mjs");
  await writeFile(
    providerPath,
    `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(AI_ENTRY)};
export default async function (pi) {
  const faux = fauxProvider({ provider: "allow-test", api: "allow-test-api", models: [{ id: "scripted" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "touch denied" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf allowed" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  pi.registerProvider("allow-test", {
    api: "allow-test-api", baseUrl: "http://127.0.0.1:1", apiKey: "test-key",
    models: faux.models,
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
  });
}
`,
  );
});

afterEach(async () => {
  try {
    if (running?.record.status === "running") await running.cancel();
  } finally {
    running = undefined;
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function launch(list: string, loadGate = true) {
  const events: WorkerEvents = {
    wake: vi.fn(),
    notify: vi.fn(),
    onChange: vi.fn(),
    onActivity: vi.fn(),
  };
  const onRecord = vi.fn(async (_record: WorkerRecord) => undefined);
  running = await startWorker({
    cwd,
    task: "run the scripted commands",
    model: "allow-test/scripted",
    thinkingLevel: "off",
    name: "allow-test",
    timeoutMs: 20_000,
    workerId: "w-allow-test",
    extensionPaths: [
      providerPath,
      ...(loadGate ? [resolve("extensions/bash-allow/bash-allow.ts")] : []),
    ],
    bashAllow: list,
    events,
    onRecord,
  });
  const record = await running.done;
  const stderr = await readFile(stderrLogPath(cwd, record.id), "utf8");
  const stream = (await readFile(streamPath(cwd, record.id), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { record, stderr, stream, events, onRecord };
}

describe("bash-allow in a real Pi worker process", () => {
  it.each(["printf:*", ""])("enforces the exact startup flag %j", async (list) => {
    const { record, stderr, stream, events, onRecord } = await launch(list);
    expect(record.status, JSON.stringify(record)).toBe("completed");
    expect(record.outputText).toBe("done");
    expect(stderr).toBe("");
    const reason = list === "" ? "bash-allow could not read its list:" : "Allowed: printf:*";
    expect(stream.filter((event) => event.type === "tool_execution_end")).toMatchObject([
      {
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: expect.stringContaining(reason) }] },
      },
      {
        toolName: "bash",
        isError: list === "",
        result: {
          content: [
            { type: "text", text: list === "" ? expect.stringContaining(reason) : "allowed" },
          ],
        },
      },
    ]);
    expect(existsSync(join(cwd, "denied"))).toBe(false);
    expect(onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", outputText: "done" }),
    );
    expect(events.notify).not.toHaveBeenCalledWith("error", expect.any(String));
  });

  it("fails startup instead of dropping the flag when the worker gate is missing", async () => {
    const { record, stderr, stream } = await launch("", false);
    expect(record.status).toBe("failed");
    expect(stderr).toMatch(/Unknown option.*--bash-allow/);
    expect(stream.filter((event) => event.type === "tool_execution_end")).toEqual([]);
    expect(existsSync(join(cwd, "denied"))).toBe(false);
  });
});
