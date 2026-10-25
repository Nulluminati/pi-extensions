import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bashAllowExtension from "../../extensions/bash-allow/bash-allow.ts";
import workersExtension from "../../extensions/workers/workers.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi, type MockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

let cwd: string;
let workers: MockPi;
let gate: MockPi;
let ctx: ReturnType<typeof createMockContext>;
let argsFile: string;
let bus: EventEmitter;

beforeEach(async () => {
  vi.resetAllMocks();
  cwd = await mkdtemp(join(tmpdir(), "workers-bash-allow-"));
  argsFile = join(cwd, "args.json");
  const script = join(cwd, "worker.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.WORKER_ARGS_CAPTURE, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "done"}]}}));
`,
  );
  await chmod(script, 0o755);
  vi.stubEnv("PI_WORKER_COMMAND", script);
  vi.stubEnv("WORKER_ARGS_CAPTURE", argsFile);
  vi.stubEnv("PI_WORKER_MODEL", "test/worker");
  vi.stubEnv("PI_WORKER_MODEL_THINKING", "off");
  vi.stubEnv("PI_WORKER_EXTENSIONS", undefined);
  vi.stubEnv("PI_WORKER_EXTENSIONS_CONFIG", join(cwd, "missing-config.json"));
  vi.stubEnv("PI_BASH_ALLOW", undefined);
  workers = createMockPi();
  gate = createMockPi();
  gate.getSettings.mockReturnValue({});
  ctx = createMockContext();
  ctx.cwd = cwd;
  bus = new EventEmitter();
  for (const pi of [workers, gate]) {
    pi.events.emit.mockImplementation((name, data) => {
      bus.emit(name, data);
    });
    pi.events.on.mockImplementation((name, listener) => {
      bus.on(name, listener);
      return () => {
        bus.off(name, listener);
      };
    });
  }
  // Worker factory loads first: inheritance must not depend on factory order.
  await workersExtension(workers);
  await bashAllowExtension(gate);
});

afterEach(async () => {
  try {
    await getEventHandler(workers, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    await getEventHandler(gate, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  }
});

describe("worker bash allow-list inheritance", () => {
  it.each([
    { flag: "pwd:*", env: "ls:*", expected: "pwd:*" },
    { flag: undefined, env: "pwd:*", expected: "pwd:*" },
    { flag: "", env: "pwd:*", expected: "" },
    { flag: "a,,b", env: "pwd:*", expected: "a,,b" },
    { flag: undefined, env: "", expected: "" },
    { flag: "@bad", env: undefined, expected: "@bad" },
    { flag: "-bad", env: undefined, expected: "-bad" },
    { flag: undefined, env: undefined, expected: undefined },
  ])(
    "passes the effective parent list without weakening it: %j",
    async ({ flag, env, expected }) => {
      vi.stubEnv("PI_BASH_ALLOW", env);
      gate.getFlag.mockReturnValue(flag);
      await getEventHandler(gate, "session_start")({ type: "session_start" }, ctx);
      const tool = workers.registerTool.mock.calls.find(
        ([definition]) => definition.name === "spawn_worker",
      )?.[0];
      if (!tool) throw new Error("spawn_worker not registered");
      const result = await tool.execute(
        "spawn-1",
        { task: "test inheritance", isolate: false, extensions: [], wait: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.worker.status).toBe("completed");
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("done") }]);
      expect(result.terminate).toBeUndefined();
      const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
      const flags = args.filter((arg) => arg.startsWith("--bash-allow"));
      expect(flags).toEqual(expected === undefined ? [] : [`--bash-allow=${expected}`]);
      const extensionPaths = args.filter((_arg, index) => args[index - 1] === "-e");
      expect(
        extensionPaths.filter((path) => path.endsWith("/bash-allow/bash-allow.ts")),
      ).toHaveLength(1);
      expect(
        extensionPaths.findIndex((path) => path.endsWith("/bash-allow/bash-allow.ts")),
      ).toBeLessThan(
        extensionPaths.findIndex((path) => path.endsWith("/approval-mode/approval-mode.ts")),
      );
      expect(extensionPaths.at(-1)).toMatch(/worker-sandbox\.ts$/);
    },
  );

  it("keeps inheritance active when a session restarts in the same extension instance", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "ls:*");
    gate.getFlag.mockReturnValue("pwd:*");
    await getEventHandler(gate, "session_start")({ type: "session_start" }, ctx);
    await getEventHandler(gate, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    gate.getFlag.mockReturnValue("echo:*");
    await getEventHandler(gate, "session_start")({ type: "session_start" }, ctx);
    const tool = workers.registerTool.mock.calls.find(
      ([definition]) => definition.name === "spawn_worker",
    )?.[0];
    if (!tool) throw new Error("spawn_worker not registered");
    await tool.execute(
      "spawn-1",
      { task: "test session restart", isolate: false, wait: true },
      undefined,
      undefined,
      ctx,
    );
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args).toContain("--bash-allow=echo:*");
  });

  it("inherits an environment list even when the parent gate is not loaded", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "pwd:*");
    bus.removeAllListeners("bash-allow:request");
    const tool = workers.registerTool.mock.calls.find(
      ([definition]) => definition.name === "spawn_worker",
    )?.[0];
    if (!tool) throw new Error("spawn_worker not registered");
    await tool.execute(
      "spawn-1",
      { task: "test fallback", isolate: false, wait: true },
      undefined,
      undefined,
      ctx,
    );
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args).toContain("--bash-allow=pwd:*");
    expect(args.some((arg) => arg.endsWith("/bash-allow/bash-allow.ts"))).toBe(true);
  });
});
