import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agentsExtension from "../../extensions/agents/agents.ts";
import { createWorkersWidget } from "../../extensions/agents/src/format.ts";
import {
  extractAssistantText,
  finalizeWorker,
  ingestStreamEvent,
  killPidTree,
} from "../../extensions/agents/src/runner.ts";
import {
  generateWorkerId,
  listRecordFiles,
  loadWorker,
  loadWorkersFromBranch,
  migrateLegacyRegistry,
  persistWorkerRecord,
  pruneWorkerArtifacts,
  streamPath,
  sweepWorkerArtifacts,
  updateRecordFile,
  WORKER_RECORD_ENTRY,
} from "../../extensions/agents/src/store.ts";
import type { WorkerRecord } from "../../extensions/agents/src/types.ts";
import {
  applyPatch,
  captureWorktreePatch,
  createWorktree,
  isGitRepo,
  removeWorktree,
} from "../../extensions/agents/src/worktree.ts";
import { withFileLock } from "../../lib/file-lock.ts";
import { cleanGitEnv, runGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";

// Call-through spy: real cross-process locking behavior stays active for
// every code path, while tests can assert who took which lock.
vi.mock("../../lib/file-lock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/file-lock.ts")>();
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) };
});

import { __resetWidgetStrip, STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const execFileAsync = promisify(execFile);
const gitOpts = (cwd: string) => ({ cwd, env: cleanGitEnv() });

// --- Fixtures ---

const SUCCESS_WORKER = `#!/bin/sh
cat <<'EOF'
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"The auth module uses JWT tokens."}]}}
EOF
exit 0
`;

const FAILING_WORKER = "#!/bin/sh\necho boom >&2\nexit 3\n";
const ACTIVE_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"tool_execution_start","toolName":"read","args":{"path":"src/auth.ts"}}'
printf '%s\n' '{"type":"tool_execution_end","toolName":"read","result":{"content":[{"type":"text","text":"jwt tokens"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading auth module."}]}}'
sleep 30
`;
const USAGE_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","usage":{"input":12000,"output":2000,"cacheRead":24000,"cacheWrite":100,"totalTokens":38100,"cost":{"total":0.041,"input":0.01,"output":0.02,"cacheRead":0.011,"cacheWrite":0.0}},"content":[{"type":"text","text":"done"}]}}'
exit 0
`;
const TAIL_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"tool_execution_start","toolName":"read","args":{"path":"src/auth.ts"}}'
printf '%s\n' '{"type":"tool_execution_end","toolName":"read","result":{"content":[{"type":"text","text":"jwt tokens"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading auth module."}]}}'
exit 0
`;
const SPOOL_CAP_WORKER = `#!/bin/sh
i=0
while [ $i -lt 4000 ]; do
  printf '%s\n' '{"type":"tool_execution_start","toolName":"read","args":{"path":"a-very-long-path-that-keeps-going-and-going-to-fill-the-spool-buffer-with-lots-of-bytes-per-line-padding-padding-padding-padding-padding"}}'
  i=$((i+1))
done
exit 0
`;
const NOISY_FAILING_WORKER =
  "#!/bin/sh\necho 'line one failure' >&2\necho 'line two failure' >&2\necho 'line three failure' >&2\nexit 3\n";
const SLOW_WORKER = "#!/bin/sh\nsleep 30\n";
const BLOCKER_REASON = "this VM has no node_modules and no parent checkout";
const BLOCKER_RUNNING_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"agents_blocker","at":123,"reason":"${BLOCKER_REASON}"}' >> "$PI_WORKER_STREAM"
sleep 30
`;
const BLOCKER_DONE_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"agents_blocker","at":123,"reason":"blocked briefly, worked around it"}' >> "$PI_WORKER_STREAM"
${SUCCESS_WORKER}`;

/**
 * A late messenger-write teardown race can hit the temp dir between rm's
 * readdir and rmdir; retry the transient codes instead of failing a green
 * test on teardown timing.
 */
async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const transient = code === "ENOTEMPTY" || code === "ENOENT" || code === "EBUSY";
      if (!transient || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function writeFixture(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

async function initGitRepo(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], gitOpts(cwd));
  await execFileAsync("git", ["config", "user.email", "test@example.com"], gitOpts(cwd));
  await execFileAsync("git", ["config", "user.name", "Test"], gitOpts(cwd));
  await writeFile(join(cwd, "README.md"), "# base\n");
  await execFileAsync("git", ["add", "."], gitOpts(cwd));
  await execFileAsync("git", ["commit", "-qm", "init"], gitOpts(cwd));
}

interface WakeMessageShape {
  customType: string;
  content: Array<{ type: string; text: string }>;
  display: boolean;
  details: Record<string, unknown>;
}

interface WakeOptionsShape {
  triggerTurn: boolean;
  deliverAs: string;
}

function findWakeCall(pi: DeepMocked<ExtensionAPI>): {
  message: WakeMessageShape;
  options: WakeOptionsShape;
} {
  for (const call of pi.sendMessage.mock.calls) {
    const [message, options] = call;
    if ((message as WakeMessageShape).customType === "agents:wake") {
      return {
        message: message as WakeMessageShape,
        options: options as WakeOptionsShape,
      };
    }
  }
  throw new Error("no agents:wake message was sent via pi.sendMessage");
}

/** The wake is emitted after the registry write, so poll rather than read once. */
async function waitForWake(pi: DeepMocked<ExtensionAPI>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = pi.sendMessage.mock.calls.some(
      ([message]) => (message as WakeMessageShape).customType === "agents:wake",
    );
    if (found) return;
    if (Date.now() > deadline) throw new Error("no agents:wake message within timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForRecord(
  dir: string,
  id: string,
  status: WorkerRecord["status"],
  timeoutMs = 15_000,
): Promise<WorkerRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await loadWorker(dir, id);
    if (record?.status === status) return record;
    if (Date.now() > deadline) {
      throw new Error(`worker ${id} did not reach ${status} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Seed a worker's artifact record file directly (no transcript): the
 *  pre-existing-state setup path for store-level and cross-session tests. */
async function seedRecord(dir: string, record: WorkerRecord): Promise<void> {
  await persistWorkerRecord(() => {}, dir, record);
}

/** Transcript entry shape the extension appends worker records under. */
function branchEntry(record: WorkerRecord): {
  type: string;
  customType: string;
  data: WorkerRecord;
} {
  return { type: "custom", customType: WORKER_RECORD_ENTRY, data: record };
}

// --- Suite ---

describe("agents-extension", () => {
  let cwd: string;
  let fixtureDir: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const executeTool = async (
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const call = mockPi.registerTool.mock.calls.find((c) => c[0].name === name);
    if (!call) throw new Error(`tool ${name} not registered`);
    return call[0].execute("call-1", params as never, signal, undefined, mockCtx);
  };

  const getEventHandler = (eventType: string) => {
    for (const call of mockPi.on.mock.calls) {
      if (call[0] === eventType) return call[1];
    }
    throw new Error(`handler for ${eventType} not found`);
  };

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    __resetWidgetStrip();
    cwd = await mkdtemp(join(tmpdir(), "agents-test-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "agents-fixture-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    // Default test configuration: most tests delegate, so a worker model
    // must resolve. The unconfigured-error test clears it again.
    setEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
    setEnv("PI_WORKER_MODEL_THINKING", undefined);
    setEnv("PI_MAX_WORKERS", undefined);
    setEnv("PI_WORKER_TIMEOUT_S", undefined);
    await agentsExtension(mockPi);
  });

  afterEach(async () => {
    // Shut down any running workers before restoring env.
    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(cwd);
    await removeTempDir(fixtureDir);
  });

  it("registers delegate and workers tools without a per-call model override", () => {
    const definitions = mockPi.registerTool.mock.calls.map((c) => c[0]);
    const delegate = definitions.find((definition) => definition.name === "delegate");
    expect(delegate).toBeDefined();
    expect(delegate?.parameters.properties).not.toHaveProperty("model");
    expect(definitions.some((definition) => definition.name === "workers")).toBe(true);
  });

  it("delegate throws on an empty task", async () => {
    await expect(executeTool("delegate", { task: "   " })).rejects.toThrow(
      /delegate requires task/,
    );
  });

  it("delegate from a planning session forces read-only Gondolin workers without worktrees", async () => {
    await initGitRepo(cwd);
    const argsFile = join(fixtureDir, "readonly-args.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "readonly-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_WORKER_EXTENSIONS", undefined);
    // Parent is planning: a plan-state entry with mode "plan".
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      {
        type: "custom",
        customType: "plan-state",
        data: { state: { mode: "plan", plan: null, toolsBeforePlan: undefined } },
      },
    ]);

    const result = await executeTool("delegate", { task: "research", wait: true });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).toContain("--worker-readonly");
    expect(args).toContain("--gondolin");
    expect(args.some((arg) => arg.includes("gondolin.ts"))).toBe(true);
    expect(result.details.worker.worktree).toBeUndefined();
    const planPathIndex = args.indexOf("-e", args.indexOf("-e") + 1);
    const planPaths = args.filter((arg) => arg.includes("plan.ts"));
    expect(planPaths.length).toBeGreaterThanOrEqual(1);
    void planPathIndex;
  });

  it("delegate enforces the environment worker model when a caller supplies another model", async () => {
    const argsFile = join(fixtureDir, "model-args.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "model-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_WORKER_MODEL_THINKING", "xhigh");

    const result = await executeTool("delegate", {
      task: "say hi",
      model: "synthetic/hf:zai-org/GLM-5.3-Flash",
      isolate: false,
      wait: true,
    });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    const modelIndex = args.indexOf("--model");
    const thinkingIndex = args.indexOf("--thinking");
    expect(args[modelIndex + 1]).toBe("opencode-go/glm-5.3-flash");
    expect(args[thinkingIndex + 1]).toBe("xhigh");
    expect(result.details.worker.model).toBe("opencode-go/glm-5.3-flash");
    expect(result.details.worker.thinkingLevel).toBe("xhigh");
  });

  it("delegate enforces the saved worker model when a caller supplies another model", async () => {
    const argsFile = join(fixtureDir, "saved-model-args.txt");
    const configPath = join(fixtureDir, "worker-model.json");
    const fixture = await writeFixture(
      fixtureDir,
      "saved-model-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    await writeFile(
      configPath,
      `${JSON.stringify({
        provider: "synthetic",
        model: "configured-worker",
        thinkingLevel: "low",
      })}\n`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_WORKER_MODEL", undefined);
    setEnv("PI_WORKER_MODEL_CONFIG", configPath);

    const result = await executeTool("delegate", {
      task: "say hi",
      model: "opencode-go/different-model",
      isolate: false,
      wait: true,
    });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    const modelIndex = args.indexOf("--model");
    const thinkingIndex = args.indexOf("--thinking");
    expect(args[modelIndex + 1]).toBe("synthetic/configured-worker");
    expect(args[thinkingIndex + 1]).toBe("low");
    expect(result.details.worker.model).toBe("synthetic/configured-worker");
    expect(result.details.worker.thinkingLevel).toBe("low");
  });

  it("delegate enforces messenger, Gondolin, and --gondolin when extensions are empty", async () => {
    const argsFile = join(fixtureDir, "mandatory-args.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "mandatory-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("delegate", {
      task: "say hi",
      extensions: [],
      isolate: false,
      wait: true,
    });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).toContain("--gondolin");
    expect(args.some((arg) => arg.includes("messenger.ts"))).toBe(true);
    expect(args.some((arg) => arg.includes("gondolin.ts"))).toBe(true);
  });

  it("delegate spawns workers with the resolved extension paths and --gondolin", async () => {
    const argsFile = join(fixtureDir, "captured-args.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "args-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_WORKER_EXTENSIONS", undefined);

    await executeTool("delegate", { task: "say hi", isolate: false, wait: true });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).toContain("--gondolin");
    const messengerIndex = args.indexOf("-e");
    expect(messengerIndex).toBeGreaterThanOrEqual(0);
    expect(args[messengerIndex + 1]).toContain("messenger.ts");
    expect(args.some((arg) => arg.includes("code-search"))).toBe(true);
  });

  it("delegate rejects forbidden worker extensions outright", async () => {
    setEnv("PI_WORKER_COMMAND", join(fixtureDir, "unused.sh"));

    await expect(
      executeTool("delegate", { task: "anything", isolate: false, extensions: ["agents"] }),
    ).rejects.toThrow(/forbidden/);
  });

  it("delegate throws when isolate=true outside a git repo", async () => {
    // cwd is a plain temp directory, not a git repository.
    await expect(executeTool("delegate", { task: "t", isolate: true })).rejects.toThrow(
      /isolate=true requires a git repository/,
    );
  });

  it("delegate returns the report when terminal persistence fails", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    // Transcript entry writes fail at the worst moment: the terminal save.
    // done must still settle and the wake must still fire, or wait=true
    // hangs forever and the fire-and-forget cleanup never runs.
    mockPi.appendEntry.mockImplementation(() => {
      throw new Error("ENOSPC: transcript write failed");
    });

    const result = await executeTool("delegate", {
      task: "Summarize the auth module",
      isolate: false,
      wait: true,
    });

    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toContain("JWT tokens");
    await waitForWake(mockPi);
  });

  it("workers cancel settles when terminal persistence fails", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    mockPi.appendEntry.mockImplementation(() => {
      throw new Error("ENOSPC: transcript write failed");
    });

    const started = await executeTool("delegate", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.details.worker.status).toBe("cancelled");
  });

  it("delegate fails with a descriptive error when no worker model is configured", async () => {
    setEnv("PI_WORKER_MODEL", undefined);
    // No worker-model.json config exists in the temp cwd's agent dir.
    await expect(
      executeTool("delegate", { task: "anything", isolate: false, model: undefined }),
    ).rejects.toThrow(/worker model is not configured/i);
  });

  it("delegate runs a worker and returns its report when wait=true", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", {
      task: "Summarize the auth module",
      isolate: false,
      wait: true,
    });

    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toContain("JWT tokens");
    // The record is persisted both as a transcript entry (ownership) and as
    // the worker's artifact record file (janitor metadata).
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      WORKER_RECORD_ENTRY,
      expect.objectContaining({ outputText: expect.stringContaining("JWT tokens") }),
    );
    const stored = await loadWorker(cwd, result.details.worker.id as string);
    expect(stored?.outputText).toContain("JWT tokens");
  });

  it("delegate sets PI_MESSENGER_NAME so workers are addressable by their worker name", async () => {
    const envFile = join(fixtureDir, "captured-name.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "env-worker.sh",
      `#!/bin/sh
printf '%s' "$PI_MESSENGER_NAME" > '${envFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("delegate", {
      task: "say hi",
      isolate: false,
      wait: true,
      name: "addressable",
    });

    expect(await readFile(envFile, "utf8")).toBe("addressable");
  });

  it("delegate marks failed workers with stderr detail", async () => {
    const fixture = await writeFixture(fixtureDir, "fail-worker.sh", FAILING_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", { task: "do it", isolate: false, wait: true });
    expect(result.details.worker.status).toBe("failed");
    expect(result.details.worker.error).toContain("boom");
  });

  it("wakes the parent with ids and status words only when a worker fails", async () => {
    const fixture = await writeFixture(fixtureDir, "noisy-fail-worker.sh", NOISY_FAILING_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "do it", isolate: false });
    const id = started.details.workerId as string;

    await waitForRecord(cwd, id, "failed");
    await waitForWake(mockPi);
    const wake = findWakeCall(mockPi);

    expect(wake.message.details).toMatchObject({ source: "agents", trusted: true });
    expect(wake.options.triggerTurn).toBe(true);
    const text = wake.message.content[0].text;
    expect(text).toContain("failed");
    expect(text).toContain(`id=${id}`);
    // Trusted-channel contract: stderr content never enters the wake.
    expect(text).not.toContain("line one failure");
  });

  it("marks a worker failed when it exits without producing a report", async () => {
    const fixture = await writeFixture(fixtureDir, "silent-worker.sh", "#!/bin/sh\nexit 0\n");
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", { task: "silent", isolate: false, wait: true });

    expect(result.details.worker.status).toBe("failed");
    expect(result.details.worker.error).toMatch(/report/i);
    expect(result.details.worker.outputText).toBeUndefined();
  });

  it("reassembles a worker report split across stdout chunks", async () => {
    // Two writes with a pause between: Node receives the JSON line in two
    // separate data events, neither of which parses on its own.
    const fixture = await writeFixture(
      fixtureDir,
      "split-worker.sh",
      `#!/bin/sh
printf '%s' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"split '
sleep 0.3
printf '%s\n' 'report"}]}}'
exit 0
`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", { task: "split", isolate: false, wait: true });

    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toBe("split report");
  });

  it("captures a final report line without a trailing newline", async () => {
    const report =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no newline"}]}}';
    const fixture = await writeFixture(
      fixtureDir,
      "no-newline-worker.sh",
      `#!/bin/sh\nprintf '%s' '${report}'\nexit 0\n`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", { task: "tail", isolate: false, wait: true });

    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toBe("no newline");
  });

  it("captures a timed-out isolated worker's patch after the process stops", async () => {
    await initGitRepo(cwd);
    // The trap runs after SIGTERM reaches the shell (i.e. after the worker is
    // stopped); its file only appears in the patch when capture happens after
    // the child has fully exited.
    const fixture = await writeFixture(
      fixtureDir,
      "trap-worker.sh",
      `#!/bin/sh
trap 'echo late > late.txt' TERM
sleep 30
`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("delegate", {
      task: "slow write",
      isolate: true,
      wait: true,
      timeout_seconds: 1,
    });

    expect(result.details.worker.status).toBe("timeout");
    expect(result.details.worker.patchPath).toBeTruthy();
    const patch = await readFile(result.details.worker.patchPath as string, "utf8");
    expect(patch).toContain("late.txt");
  });

  it("enforces the worker concurrency limit", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_MAX_WORKERS", "1");

    const first = await executeTool("delegate", { task: "one", isolate: false });
    expect(first.details.workerId).toBeDefined();

    await expect(executeTool("delegate", { task: "two", isolate: false })).rejects.toThrow(
      /limit reached/,
    );
  });

  it("delegate rejects duplicate running worker names", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("delegate", { task: "one", isolate: false, name: "scout" });
    await expect(
      executeTool("delegate", { task: "two", isolate: false, name: "scout" }),
    ).rejects.toThrow(/already running/);
  });

  it("workers status reads a finished worker's report", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "look", isolate: false, wait: true });
    const id = started.details.worker.id as string;

    const status = await executeTool("workers", { action: "status", id });
    expect(status.content[0].text).toContain("JWT tokens");
  });

  it("workers status throws for an unknown id", async () => {
    await expect(executeTool("workers", { action: "status", id: "w-nope" })).rejects.toThrow(
      /Unknown worker/,
    );
  });

  it("workers throws on an unknown action", async () => {
    const id = generateWorkerId();
    await seedRecord(cwd, {
      id,
      name: "known",
      task: "t",
      model: "m",
      cwd,
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });

    await expect(executeTool("workers", { action: "explode", id })).rejects.toThrow(
      /Unknown workers action/,
    );
  });

  it("persistWorkerRecord ignores a stale running snapshot for a terminal record", async () => {
    const appendEntry = vi.fn();
    await persistWorkerRecord(appendEntry, cwd, {
      id: "w-done",
      name: "done",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
      outputText: "the report",
    });

    // A late-arriving initial snapshot (parent bookkeeping) must not clobber
    // the terminal record the runner already wrote — neither on disk nor in
    // the transcript.
    const persisted = await persistWorkerRecord(appendEntry, cwd, {
      id: "w-done",
      name: "done",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });

    expect(persisted).toBe(false);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const record = await loadWorker(cwd, "w-done");
    expect(record?.status).toBe("completed");
    expect(record?.outputText).toBe("the report");
  });

  it("concurrent initial-save and completion-save keep the terminal record", async () => {
    const appendEntry = vi.fn();
    const running = persistWorkerRecord(appendEntry, cwd, {
      id: "w-race",
      name: "race",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });
    await persistWorkerRecord(appendEntry, cwd, {
      id: "w-race",
      name: "race",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
      outputText: "final report",
    });
    await running;

    const record = await loadWorker(cwd, "w-race");
    expect(record?.status).toBe("completed");
    expect(record?.outputText).toBe("final report");
  });

  it("session_start salvage-finalizes an own stuck worker that finished while away", async () => {
    const id = generateWorkerId();
    // Restored by pi -r as running; the worker pid is dead but its raw
    // spool holds a final report: status must be completed, not failed.
    const record = makeWorkerRecord({
      id,
      name: "ghost",
      pid: 999_999_999,
      status: "running",
      startedAt: Date.now() - 5_000,
      streamFormat: "raw",
    });
    mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, `${id}.jsonl`),
      `{"type":"agents_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"salvaged report"}]}}\n`,
      "utf8",
    );

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const stored = await loadWorker(cwd, id);
    expect(stored?.status).toBe("completed");
    expect(stored?.outputText).toContain("salvaged report");
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      WORKER_RECORD_ENTRY,
      expect.objectContaining({ id, status: "completed" }),
    );
    // The owner is woken: the report arrived after the session died.
    const wake = findWakeCall(mockPi);
    expect(wake.message.content[0].text).toContain(id);
  });

  it("session_start marks an own stuck worker failed when its spool has no report", async () => {
    const id = generateWorkerId();
    const record = makeWorkerRecord({
      id,
      name: "ghost",
      pid: 999_999_999,
      status: "running",
      startedAt: Date.now() - 5_000,
      streamFormat: "raw",
    });
    mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const stored = await loadWorker(cwd, id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toMatch(/report/i);
  });

  it("session_start keeps worker state out of git status and migrates the legacy registry", async () => {
    await initGitRepo(cwd);
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers"), { recursive: true });
    await writeFile(join(cwd, CONFIG_DIR_NAME, "workers", "registry.json"), "{}\n");

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(`${projectStateRelative("workers")}/`);
    expect(exclude.split("\n")).toContain(`${projectStateRelative("worktrees")}/`);
    expect(await runGit(cwd, ["status", "--porcelain"])).toBe("");
    // The shared registry is gone after the one-time migration.
    await expect(
      stat(join(cwd, CONFIG_DIR_NAME, "workers", "registry.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("session_shutdown cancels running workers", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("cancelled");
  });

  it("onChange and onActivity do not publish after session_shutdown", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("delegate", { task: "long", isolate: false });
    const stateEmitCount = () =>
      mockPi.events.emit.mock.calls.filter(([event]) => event === "agents:state").length;

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );
    const emitsAfterShutdown = stateEmitCount();
    const widgetCallsAfterShutdown = mockCtx.ui.setWidget.mock.calls.length;

    // The cancel path fires onChange from the runner; a pending 500ms activity
    // refresh would land within this window if shutdown did not gate it.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(stateEmitCount()).toBe(emitsAfterShutdown);
    expect(mockCtx.ui.setWidget.mock.calls.length).toBe(widgetCallsAfterShutdown);
  });

  it("workers cancel stops a running worker", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.content[0].text).toContain("cancelled");
    expect(cancelled.details.worker.status).toBe("cancelled");
    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("cancelled");
  });

  it("workers collect applies an isolated worker's patch and cleans up, keeping the stream", async () => {
    await initGitRepo(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", {
      task: "add feature file",
      isolate: true,
      wait: true,
    });
    const worker = started.details.worker;
    expect(worker.status).toBe("completed");
    expect(worker.patchPath).toBeTruthy();
    const id = worker.id as string;

    // The worker didn't change anything; write a change into the worktree to
    // simulate its edits, then re-capture before collecting.
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(worker.worktree as string, "FEATURE.md"), "feature\n");
    const { captureWorktreePatch } = await import("../../extensions/agents/src/worktree.ts");
    await captureWorktreePatch(worker.worktree as string, worker.patchPath as string);

    const collected = await executeTool("workers", { action: "collect", id });
    expect(collected.content[0].text).toContain("Applied patch");
    expect(await readFile(join(cwd, "FEATURE.md"), "utf8")).toBe("feature\n");
    // Worktree cleaned up.
    const { existsSync } = await import("node:fs");
    expect(existsSync(worker.worktree as string)).toBe(false);
    // But the stream spool survives the cleanup: post-mortem tails stay
    // available until the 24h prune reaps them.
    await expect(executeTool("workers", { action: "tail", id })).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("■ finished completed") }],
    });
    const record = await loadWorker(cwd, id);
    expect(record?.collectedAt).toBeDefined();
  });

  it("workers collect keeps the worktree when the patch file is missing", async () => {
    await initGitRepo(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    await rm(worker.patchPath as string, { force: true });

    await expect(
      executeTool("workers", { action: "collect", id: worker.id, apply: false }),
    ).rejects.toThrow(/missing/i);

    const { existsSync } = await import("node:fs");
    expect(existsSync(worker.worktree as string)).toBe(true);
  });

  it("workers collect refuses to apply twice", async () => {
    await initGitRepo(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(worker.worktree as string, "X.md"), "x\n");
    const { captureWorktreePatch } = await import("../../extensions/agents/src/worktree.ts");
    await captureWorktreePatch(worker.worktree as string, worker.patchPath as string);

    await executeTool("workers", { action: "collect", id: worker.id });
    await expect(executeTool("workers", { action: "collect", id: worker.id })).rejects.toThrow(
      /already collected/,
    );
  });

  it("workers collect with apply=false leaves the patch unapplied", async () => {
    await initGitRepo(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(worker.worktree as string, "UNAPPLIED.md"), "unapplied\n");
    const { captureWorktreePatch } = await import("../../extensions/agents/src/worktree.ts");
    await captureWorktreePatch(worker.worktree as string, worker.patchPath as string);

    const collected = await executeTool("workers", {
      action: "collect",
      id: worker.id,
      apply: false,
    });

    expect(collected.content[0].text).toContain("Patch left unapplied");
    expect(existsSync(join(cwd, "UNAPPLIED.md"))).toBe(false);
    const record = await loadWorker(cwd, worker.id as string);
    expect(record?.collectedAt).toBeDefined();
  });

  it("workers collect surfaces the patch path when git apply fails", async () => {
    await initGitRepo(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    const patchPath = worker.patchPath as string;
    const { writeFile: wf } = await import("node:fs/promises");
    // Corrupt the patch so `git apply` rejects it.
    await wf(patchPath, "not a valid git patch\n");

    const error = await executeTool("workers", { action: "collect", id: worker.id }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Patch apply failed");
    expect((error as Error).message).toContain(patchPath);
  });

  describe("widget", () => {
    function renderLastWidget(width = 80): string[] {
      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      const factory = lastCall[1] as
        | ((tui: unknown, theme: unknown) => { render(w: number): string[] })
        | undefined;
      if (typeof factory !== "function") {
        throw new Error(`expected a widget factory, got ${String(factory)}`);
      }
      return factory(undefined, mockCtx.ui.theme).render(width);
    }

    it("shows running workers in a framed widget while they run", async () => {
      const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      await executeTool("delegate", { task: "t", isolate: false, name: "scout" });

      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      expect(lastCall[0]).toBe(STRIP_KEY_ABOVE);
      const text = renderLastWidget().join("\n");
      expect(text).toContain("Workers");
      expect(text).toContain("1 running");
      expect(text).toContain('"scout" running');

      await getEventHandler("session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        mockCtx,
      );
      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
    });

    it("clears the widget when no workers are running", async () => {
      await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
      // With nothing registered the strip never publishes at all; the only
      // valid strip calls are clears.
      const stripCalls = mockCtx.ui.setWidget.mock.calls.filter(([key]) => key === STRIP_KEY_ABOVE);
      expect(stripCalls.every(([, content]) => content === undefined)).toBe(true);
    });
  });

  // --- Live worker activity ---

  describe("workers live activity", () => {
    it("tracks live tool activity on the running record and spools the stream", async () => {
      const fixture = await writeFixture(fixtureDir, "active-worker.sh", ACTIVE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", { task: "read auth", isolate: false });
      const id = started.details.workerId as string;

      // The spool projection captures the tool lifecycle and assistant text
      // while the worker is still running. (The activity snapshot itself is
      // intentionally in-memory only — the widget reads the live record.)
      await vi.waitFor(async () => {
        const raw = await readFile(streamPath(cwd, id), "utf8").catch(() => "");
        expect(raw).toContain('"type":"tool_execution_start"');
        expect(raw).toContain('"type":"tool_execution_end"');
        expect(raw).toContain("Reading auth module");
      });

      await executeTool("workers", { action: "cancel", id });
    });

    it("shows live activity in the workers widget line", async () => {
      const fixture = await writeFixture(fixtureDir, "active-widget.sh", ACTIVE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      // Short name: the frame line is width-truncated, and a uuid-long id
      // would push the activity segment past the truncation point.
      const started = await executeTool("delegate", {
        task: "t",
        isolate: false,
        name: "scout",
      });
      const id = started.details.workerId as string;

      await vi.waitFor(async () => {
        const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
        const factory = lastCall[1] as
          | ((tui: unknown, theme: unknown) => { render(w: number): string[] })
          | undefined;
        if (typeof factory !== "function") throw new Error("no widget factory");
        const component = factory(undefined, mockCtx.ui.theme);
        const text = component.render(160).join("\n");
        expect(text).toContain("▸ read src/auth.ts");
      });
      await executeTool("workers", { action: "cancel", id });
    });

    it("workers tail reads the bounded stream after completion", async () => {
      const fixture = await writeFixture(fixtureDir, "tail-worker.sh", TAIL_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", {
        task: "t",
        isolate: false,
        wait: true,
      });
      const id = (started.details.worker as WorkerRecord).id;

      const tail = await executeTool("workers", { action: "tail", id });
      const text = tail.content[0].text as string;
      expect(text).toContain("▸ read src/auth.ts");
      expect(text).toContain("✓ read");
      expect(text).toContain("✎ Reading auth module");
      expect(text).toContain("■ finished completed");
    });

    it("rolls up worker usage and publishes it on agents:state", async () => {
      const fixture = await writeFixture(fixtureDir, "usage-worker.sh", USAGE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", {
        task: "t",
        isolate: false,
        wait: true,
      });
      const worker = started.details.worker as WorkerRecord;
      // Per-message usage accumulates on the record and survives the terminal save.
      expect(worker.usage).toMatchObject({
        inputTokens: 12000,
        outputTokens: 2000,
        cacheReadTokens: 24000,
        cacheWriteTokens: 100,
        costUsd: 0.041,
      });

      const stored = await loadWorker(cwd, worker.id);
      expect(stored?.usage?.costUsd).toBeCloseTo(0.041);

      // The status payload aggregates across all records on the next publish.
      await executeTool("workers", { action: "list" });
      const stateEvents = mockPi.events.emit.mock.calls.filter(
        ([event]) => event === "agents:state",
      );
      const payload = stateEvents.at(-1)?.[1] as { running: number; workerCostUsd: number };
      expect(payload.workerCostUsd).toBeCloseTo(0.041);
    });

    it("tail reads stay bounded however much the child wrote", async () => {
      const fixture = await writeFixture(fixtureDir, "spool-cap.sh", SPOOL_CAP_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", {
        task: "t",
        isolate: false,
        wait: true,
        timeout_seconds: 30,
      });
      const worker = started.details.worker as WorkerRecord;
      // The child owns its spool: it may grow well past the display window.
      const raw = await readFile(streamPath(cwd, worker.id), "utf8");
      expect(Buffer.byteLength(raw)).toBeGreaterThan(512 * 1024);

      // The tail display stays bounded regardless.
      const tail = await executeTool("workers", { action: "tail", id: worker.id, lines: 40 });
      const text = tail.content[0].text as string;
      expect(text.split("\n")).toHaveLength(41); // 40 entries + omission note
    });
  });

  describe("worker blocker reporting", () => {
    it("records a reported blocker on the running record and shows it in workers status", async () => {
      const fixture = await writeFixture(fixtureDir, "blocker-worker.sh", BLOCKER_RUNNING_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", { task: "stuck task", isolate: false });
      const id = started.details.workerId as string;

      // The spool poller ingests the marker into the live record.
      await vi.waitFor(async () => {
        const status = await executeTool("workers", { action: "status", id });
        const worker = status.details.worker as WorkerRecord;
        expect(worker.blocker).toMatchObject({ reason: BLOCKER_REASON, at: 123 });
        expect(status.content[0].text).toContain(`Blocker: ${BLOCKER_REASON}`);
      });

      // Reporting a blocker does not kill the worker; the parent decides.
      const status = await executeTool("workers", { action: "status", id });
      expect((status.details.worker as WorkerRecord).status).toBe("running");

      await executeTool("workers", { action: "cancel", id });
    });

    it("wakes the parent once with ids and status words only (no worker prose)", async () => {
      const fixture = await writeFixture(fixtureDir, "blocker-wake.sh", BLOCKER_RUNNING_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", { task: "stuck task", isolate: false });
      const id = started.details.workerId as string;

      await waitForWake(mockPi);
      const wakes = mockPi.sendMessage.mock.calls.filter(
        ([message]) => (message as WakeMessageShape).customType === "agents:wake",
      );
      expect(wakes).toHaveLength(1);
      const [message, options] = wakes[0] as unknown as [WakeMessageShape, WakeOptionsShape];
      expect(message.details).toMatchObject({ source: "agents", trusted: true });
      expect(options.triggerTurn).toBe(true);
      const text = message.content[0].text;
      expect(text).toContain("reported a blocker");
      expect(text).toContain(`id=${id}`);
      // Trusted-channel contract: the reason text stays behind the pull
      // boundary and is only readable via the workers tool.
      expect(text).not.toContain("node_modules");
      expect(text).not.toContain("no parent checkout");

      await executeTool("workers", { action: "cancel", id });
    });

    it("keeps the blocker on the final record when the worker finishes", async () => {
      const fixture = await writeFixture(fixtureDir, "blocker-done.sh", BLOCKER_DONE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const result = await executeTool("delegate", { task: "t", isolate: false, wait: true });

      const worker = result.details.worker as WorkerRecord;
      expect(worker.status).toBe("completed");
      expect(worker.blocker).toMatchObject({
        reason: "blocked briefly, worked around it",
        at: 123,
      });
      const stored = await loadWorker(cwd, worker.id);
      expect(stored?.blocker?.reason).toBe("blocked briefly, worked around it");
    });

    it("workers tail renders the blocker marker", async () => {
      const fixture = await writeFixture(fixtureDir, "blocker-tail.sh", BLOCKER_DONE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("delegate", {
        task: "t",
        isolate: false,
        wait: true,
      });
      const id = (started.details.worker as WorkerRecord).id;

      const tail = await executeTool("workers", { action: "tail", id });
      expect(tail.content[0].text).toContain("⚠ blocker blocked briefly, worked around it");
    });
  });
  it("workers remove deletes a finished worker's record and artifacts", async () => {
    const finished = makeWorkerRecord({
      id: "w-done",
      name: "done",
      pid: process.pid,
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    await seedRecord(cwd, finished);
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "patches"), { recursive: true });
    const patchFile = join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-done.diff");
    await writeFile(patchFile, "diff", "utf8");

    const result = await executeTool("workers", { action: "remove", id: "w-done" });
    expect(result.content[0].text).toContain("removed");
    expect(await loadWorker(cwd, "w-done")).toBeUndefined();
    await expect(stat(patchFile)).rejects.toMatchObject({ code: "ENOENT" });

    // Running and unknown ids are refused.
    await seedRecord(cwd, makeWorkerRecord({ id: "w-live", name: "live", pid: process.pid }));
    await expect(executeTool("workers", { action: "remove", id: "w-live" })).rejects.toThrow(
      /still running/,
    );
    await expect(executeTool("workers", { action: "remove", id: "w-ghost" })).rejects.toThrow(
      /Unknown worker/,
    );
  });

  it("workers remove discards a finished worker's worktree and branch", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-wt");
    const patchFile = join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-wt.diff");
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "patches"), { recursive: true });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(wt.path, "W.md"), "w\n");
    await captureWorktreePatch(wt.path, patchFile);
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-wt",
        name: "wt",
        status: "cancelled",
        worktree: wt.path,
        branch: wt.branch,
        patchPath: patchFile,
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const result = await executeTool("workers", { action: "remove", id: "w-wt" });

    expect(result.content[0].text).toContain("Worktree and branch discarded");
    expect(existsSync(wt.path)).toBe(false);
    await expect(runGit(cwd, ["rev-parse", "--verify", "agents/w-wt"])).rejects.toThrow();
    expect(await loadWorker(cwd, "w-wt")).toBeUndefined();
  });

  it("workers remove keeps the worktree when the patch file is missing", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-keep");
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-keep",
        name: "keep",
        status: "completed",
        worktree: wt.path,
        branch: wt.branch,
        patchPath: join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-keep.diff"),
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    await expect(executeTool("workers", { action: "remove", id: "w-keep" })).rejects.toThrow(
      /patch/i,
    );
    expect(existsSync(wt.path)).toBe(true);
    expect(await loadWorker(cwd, "w-keep")).toBeDefined();
  });

  it("workers remove discards an unowned leftover worktree", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-lost");
    // No record file: the record was pruned or lost; the worktree remains.

    const result = await executeTool("workers", { action: "remove", id: "w-lost" });

    expect(result.content[0].text).toContain("worktree");
    expect(existsSync(wt.path)).toBe(false);
    await expect(runGit(cwd, ["rev-parse", "--verify", "agents/w-lost"])).rejects.toThrow();
  });

  it("session_start prunes records past the retention window", async () => {
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-ancient",
        name: "ancient",
        pid: process.pid,
        status: "failed",
        startedAt: Date.now() - 8 * 24 * 60 * 60_000,
        endedAt: Date.now() - 8 * 24 * 60 * 60_000,
      }),
    );
    await seedRecord(cwd, makeWorkerRecord({ id: "w-keep", name: "keep", pid: process.pid }));

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    expect(await loadWorker(cwd, "w-ancient")).toBeUndefined();
    expect((await loadWorker(cwd, "w-keep"))?.status).toBe("running");
  });

  it("the workers tool schema exposes the remove action", () => {
    const definition = mockPi.registerTool.mock.calls.find((c) => c[0].name === "workers")?.[0];
    expect(definition?.parameters.properties.action.enum).toContain("remove");
  });
});

describe("agents-units", () => {
  it("extractAssistantText keeps the last assistant text", () => {
    let text = "";
    text = extractAssistantText("not json", text);
    expect(text).toBe("");
    text = extractAssistantText(
      '{"type":"message_end","message":{"role":"user","content":"hi"}}',
      text,
    );
    expect(text).toBe("");
    text = extractAssistantText(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
      text,
    );
    expect(text).toBe("first");
    text = extractAssistantText(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"h"},{"type":"text","text":"second"}]}}',
      text,
    );
    expect(text).toBe("second");
  });

  it("ingestStreamEvent records blocker markers on the record", () => {
    const record = makeWorkerRecord();

    expect(
      ingestStreamEvent('{"type":"agents_blocker","at":5,"reason":"a real blocker"}', record),
    ).toBe("blocker");
    expect(record.blocker).toEqual({ reason: "a real blocker", at: 5 });

    // Non-marker and corrupt lines are ignored.
    expect(
      ingestStreamEvent(
        '{"type":"tool_execution_start","toolName":"read","args":{"path":"a"}}',
        record,
      ),
    ).toBeUndefined();
    expect(ingestStreamEvent("not json", record)).toBeUndefined();

    // Reasons are re-sanitized defensively and the last report wins.
    ingestStreamEvent('{"type":"agents_blocker","at":6,"reason":"line1\\nline2"}', record);
    expect(record.blocker).toEqual({ reason: "line1 line2", at: 6 });
    ingestStreamEvent('{"type":"agents_blocker","at":7,"reason":"the final answer"}', record);
    expect(record.blocker).toEqual({ reason: "the final answer", at: 7 });
  });

  it("isGitRepo detects git and non-git directories", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "agents-git-"));
    const plainDir = await mkdtemp(join(tmpdir(), "agents-plain-"));
    try {
      await initGitRepo(gitDir);
      expect(await isGitRepo(gitDir)).toBe(true);
      expect(await isGitRepo(plainDir)).toBe(false);
    } finally {
      await rm(gitDir, { recursive: true, force: true });
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  it("createWorkersWidget caps the panel at five workers with an overflow line", () => {
    const workers = Array.from({ length: 7 }, (_, i) =>
      makeWorkerRecord({ id: `w-${i + 1}`, name: `w-${i + 1}` }),
    );
    const factory = createWorkersWidget(() => workers);
    const text = factory(undefined, { fg: (_color: string, t: string) => t })
      .render(80)
      .join("\n");
    expect(text).toContain("Workers");
    expect(text).toContain("7 running");
    expect(text).toContain("w-5");
    expect(text).not.toContain("w-6");
    expect(text).toContain("↓ 2 more");
  });

  it("worktree lifecycle: create, capture patch, apply, remove", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-wt-"));
    try {
      await initGitRepo(repo);
      const wt = await createWorktree(repo, "w-test");
      expect(await isGitRepo(wt.path)).toBe(true);

      await mkdir(join(wt.path, "src"), { recursive: true });
      await writeFile(join(wt.path, "src", "new.ts"), "export {};\n");
      const patchPath = join(repo, "patch.diff");
      await captureWorktreePatch(wt.path, patchPath);
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain("src/new.ts");

      await applyPatch(repo, patchPath);
      expect(await readFile(join(repo, "src", "new.ts"), "utf8")).toBe("export {};\n");

      await removeWorktree(repo, "w-test");
      const { existsSync } = await import("node:fs");
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("captureWorktreePatch captures committed and uncommitted changes since the worktree base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-wt-committed-"));
    try {
      await initGitRepo(repo);
      const wt = await createWorktree(repo, "w-committed");

      // The worker commits one change on its branch...
      await writeFile(join(wt.path, "committed.ts"), "export const committed = true;\n");
      await execFileAsync("git", ["add", "."], gitOpts(wt.path));
      await execFileAsync("git", ["commit", "-qm", "worker commit"], gitOpts(wt.path));
      // ...and leaves another uncommitted.
      await writeFile(join(wt.path, "uncommitted.ts"), "export const uncommitted = true;\n");

      const patchPath = join(repo, "committed.patch.diff");
      await captureWorktreePatch(wt.path, patchPath);
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain("committed.ts");
      expect(patch).toContain("uncommitted.ts");

      await applyPatch(repo, patchPath);
      expect(await readFile(join(repo, "committed.ts"), "utf8")).toBe(
        "export const committed = true;\n",
      );
      expect(await readFile(join(repo, "uncommitted.ts"), "utf8")).toBe(
        "export const uncommitted = true;\n",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree refuses a dirty tree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-dirty-"));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, "README.md"), "# changed\n");
      await expect(createWorktree(repo, "w-dirty")).rejects.toThrow(/dirty tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree ignores untracked config-dir state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-dirty-state-"));
    try {
      await initGitRepo(repo);
      // Messenger/missions/workers write here in repos that do not gitignore it.
      await mkdir(join(repo, CONFIG_DIR_NAME, "messenger", "inbox"), { recursive: true });
      await writeFile(join(repo, CONFIG_DIR_NAME, "messenger", "inbox", "peer.jsonl"), "{}\n");

      await expect(createWorktree(repo, "w-state")).resolves.toEqual({
        path: expect.stringContaining("w-state"),
        branch: "agents/w-state",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree still refuses untracked work files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-dirty-src-"));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, "scratch.ts"), "export {};\n");
      await expect(createWorktree(repo, "w-src")).rejects.toThrow(/dirty tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree refuses tracked modifications under the config dir", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agents-dirty-tracked-"));
    try {
      await mkdir(join(repo, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(join(repo, CONFIG_DIR_NAME, "committed.json"), "{}\n");
      await initGitRepo(repo);
      await writeFile(join(repo, CONFIG_DIR_NAME, "committed.json"), '{"changed":true}\n');

      // A HEAD-based worktree would miss the edit, so this must still refuse.
      await expect(createWorktree(repo, "w-tracked")).rejects.toThrow(/dirty tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("agents-worker store (session-scoped)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agents-store-"));
    vi.mocked(withFileLock).mockClear();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("loadWorkersFromBranch keeps the last entry per worker id", () => {
    const first = makeWorkerRecord({ id: "w-a", name: "a", status: "running" });
    const second = makeWorkerRecord({
      id: "w-a",
      name: "a",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    });
    const other = makeWorkerRecord({ id: "w-b", name: "b", status: "failed" });

    const workers = loadWorkersFromBranch([
      branchEntry(first),
      { type: "custom", customType: "other-entry", data: {} },
      { type: "message", role: "user" },
      branchEntry(other),
      branchEntry(second),
    ]);

    expect(workers.size).toBe(2);
    expect(workers.get("w-a")?.status).toBe("completed");
    expect(workers.get("w-b")?.status).toBe("failed");
  });

  it("loadWorkersFromBranch skips corrupt entries", () => {
    const workers = loadWorkersFromBranch([
      { type: "custom", customType: WORKER_RECORD_ENTRY, data: { id: "no status" } },
      { type: "custom", customType: WORKER_RECORD_ENTRY, data: null },
    ]);
    expect(workers.size).toBe(0);
  });

  it("updateRecordFile read-modify-writes under the per-record lock", async () => {
    await seedRecord(cwd, makeWorkerRecord({ id: "w-x", name: "x", status: "completed" }));

    const updated = await updateRecordFile(cwd, "w-x", (record) => ({
      ...record,
      collectedAt: 1234,
    }));

    expect(updated.collectedAt).toBe(1234);
    expect((await loadWorker(cwd, "w-x"))?.collectedAt).toBe(1234);
    expect(withFileLock).toHaveBeenCalledWith(
      expect.stringMatching(/records\/w-x\.lock$/),
      expect.any(Function),
    );
  });

  it("updateRecordFile throws for an unknown worker", async () => {
    await expect(updateRecordFile(cwd, "w-nope", (r) => r)).rejects.toThrow(/No artifact record/);
  });

  it("listRecordFiles skips corrupt record files", async () => {
    const dir = join(cwd, CONFIG_DIR_NAME, "workers", "records");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "w-bad.json"), "{not json", "utf8");
    await seedRecord(cwd, makeWorkerRecord({ id: "w-good", name: "good" }));

    const records = await listRecordFiles(cwd);
    expect(records.map((r) => r.id)).toEqual(["w-good"]);
  });

  it("sweepWorkerArtifacts classifies foreign-live, orphan, and own records", async () => {
    const foreignLive = makeWorkerRecord({
      id: "w-foreign",
      name: "foreign",
      parentPid: process.pid,
      status: "running",
    });
    const orphan = makeWorkerRecord({
      id: "w-orphan",
      name: "orphan",
      parentPid: 999_999_999,
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    const legacy = makeWorkerRecord({ id: "w-legacy", name: "legacy", status: "failed" });
    await seedRecord(cwd, foreignLive);
    await seedRecord(cwd, orphan);
    await seedRecord(cwd, legacy);

    // A live orphan: running, worker process alive, parent session dead.
    const liveOrphan = makeWorkerRecord({
      id: "w-live-orphan",
      name: "live-orphan",
      parentPid: 999_999_999,
      pid: process.pid,
      status: "running",
    });
    await seedRecord(cwd, liveOrphan);

    // "mine" contains the session's own ids; the rest classify by parent
    // and worker pids.
    const sweep = await sweepWorkerArtifacts(cwd, new Set(["w-mine"]));

    expect(sweep.foreignLive.map((r) => r.id)).toEqual(["w-foreign"]);
    expect(sweep.terminalOrphans.map((r) => r.id).sort()).toEqual(["w-legacy", "w-orphan"]);
    expect(sweep.liveOrphans.map((r) => r.id)).toEqual(["w-live-orphan"]);
  });

  it("sweepWorkerArtifacts treats a live parent as a live session even for finished workers", async () => {
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-theirs",
        name: "theirs",
        parentPid: process.pid,
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const sweep = await sweepWorkerArtifacts(cwd, new Set());
    expect(sweep.foreignLive.map((r) => r.id)).toEqual(["w-theirs"]);
    expect(sweep.terminalOrphans).toHaveLength(0);
  });

  it("migrateLegacyRegistry imports registry records as parentless artifacts", async () => {
    const dir = join(cwd, CONFIG_DIR_NAME, "workers");
    await mkdir(dir, { recursive: true });
    const legacy = makeWorkerRecord({ id: "w-old", name: "old", status: "completed" });
    await writeFile(
      join(dir, "registry.json"),
      JSON.stringify({ workers: { "w-old": legacy } }),
      "utf8",
    );

    expect(await migrateLegacyRegistry(cwd)).toBe(true);

    const imported = await loadWorker(cwd, "w-old");
    expect(imported?.id).toBe("w-old");
    await expect(stat(join(dir, "registry.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrateLegacyRegistry survives a corrupt registry file", async () => {
    const dir = join(cwd, CONFIG_DIR_NAME, "workers");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "registry.json"), "{not json", "utf8");

    expect(await migrateLegacyRegistry(cwd)).toBe(true);
    await expect(stat(join(dir, "registry.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrateLegacyRegistry is a no-op without a legacy registry", async () => {
    expect(await migrateLegacyRegistry(cwd)).toBe(false);
  });

  it("pruneWorkerArtifacts removes past-retention terminal artifacts, never running ones", async () => {
    const now = Date.now();
    const old = makeWorkerRecord({
      id: "w-old",
      name: "old",
      status: "completed",
      startedAt: now - 8 * 24 * 60 * 60_000,
      endedAt: now - 8 * 24 * 60 * 60_000,
    });
    const recent = makeWorkerRecord({
      id: "w-recent",
      name: "recent",
      status: "completed",
      startedAt: now - 1 * 24 * 60 * 60_000,
      endedAt: now - 1 * 24 * 60 * 60_000,
    });
    const live = makeWorkerRecord({ id: "w-live", name: "live", pid: process.pid });
    await seedRecord(cwd, old);
    await seedRecord(cwd, recent);
    await seedRecord(cwd, live);
    // Artifacts for the old record: its stream spool and a captured patch.
    const streamFile = streamPath(cwd, "w-old");
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "streams"), { recursive: true });
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "patches"), { recursive: true });
    await writeFile(streamFile, '{"at":1}\n', "utf8");
    const patchFile = join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-old.diff");
    await writeFile(patchFile, "diff", "utf8");
    await writeFile(streamPath(cwd, "w-recent"), '{"at":2}\n', "utf8");

    const pruned = await pruneWorkerArtifacts(cwd);

    expect(pruned).toContain("w-old");
    expect(pruned).not.toContain("w-recent");
    expect(pruned).not.toContain("w-live");
    expect(await loadWorker(cwd, "w-old")).toBeUndefined();
    expect(await loadWorker(cwd, "w-recent")).toBeDefined();
    expect(await loadWorker(cwd, "w-live")).toBeDefined();
    await expect(stat(streamFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(patchFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(streamPath(cwd, "w-recent"))).resolves.toBeTruthy();
  });
  it("pruneWorkerArtifacts removes past-retention worktrees and branches", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-old");
    const now = Date.now();
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-old",
        name: "old",
        status: "failed",
        worktree: wt.path,
        branch: wt.branch,
        startedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      }),
    );
    await seedRecord(cwd, makeWorkerRecord({ id: "w-live", name: "live", pid: process.pid }));

    const pruned = await pruneWorkerArtifacts(cwd);

    expect(pruned).toContain("w-old");
    expect(existsSync(wt.path)).toBe(false);
    await expect(runGit(cwd, ["rev-parse", "--verify", "agents/w-old"])).rejects.toThrow();
    expect(await loadWorker(cwd, "w-live")).toBeDefined();
  });

  it("sweepWorkerArtifacts reports worktree dirs with no record file as unowned", async () => {
    await initGitRepo(cwd);
    await createWorktree(cwd, "w-unowned");
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-orphan",
        name: "orphan",
        parentPid: 999_999_999,
        status: "failed",
        worktree: join(cwd, CONFIG_DIR_NAME, "worktrees", "w-orphan"),
        branch: "agents/w-orphan",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const sweep = await sweepWorkerArtifacts(cwd, new Set());

    expect(sweep.terminalOrphans.map((r) => r.id)).toEqual(["w-orphan"]);
    expect(sweep.unownedWorktrees).toEqual(["w-unowned"]);
  });

  it("finalizeWorker infers completed from a raw spool and captures the patch", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-salvage");
    await writeFile(join(wt.path, "SALVAGED.md"), "salvaged\n", "utf8");
    const record = makeWorkerRecord({
      id: "w-salvage",
      name: "salvage",
      status: "running",
      worktree: wt.path,
      branch: wt.branch,
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-salvage.jsonl"),
      '{"type":"agents_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"the salvaged report"}]}}\n',
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toContain("the salvaged report");
    expect(finalized.patchPath).toBeDefined();
    // The end marker lands in the spool so later readers see terminal state.
    const spool = await readFile(join(spoolDir, "w-salvage.jsonl"), "utf8");
    expect(spool).toContain('"type":"agents_end"');
    // Idempotent: re-finalizing a terminal record changes nothing.
    const again = await finalizeWorker({ cwd, record: finalized });
    expect(again.status).toBe("completed");
    expect(again.endedAt).toBe(finalized.endedAt);
  });

  it("finalizeWorker fails with stderr detail when no report was produced", async () => {
    const record = makeWorkerRecord({
      id: "w-quiet",
      name: "quiet",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(join(spoolDir, "w-quiet.stderr.log"), "boom went the worker\n", "utf8");

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("boom went the worker");
  });

  it("finalizeWorker honors an explicit end marker over inference", async () => {
    const record = makeWorkerRecord({
      id: "w-marked",
      name: "marked",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-marked.jsonl"),
      '{"type":"agents_end","at":2,"status":"timeout","error":"worker exceeded 30s timeout"}\n',
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("timeout");
    expect(finalized.error).toContain("30s timeout");
  });

  it("finalizeWorker recovers a reported blocker from the spool", async () => {
    const record = makeWorkerRecord({
      id: "w-blocked",
      name: "blocked",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-blocked.jsonl"),
      '{"type":"agents_blocker","at":9,"reason":"stuck on missing credentials"}\n{"type":"agents_end","at":10,"status":"timeout","error":"worker exceeded 30s timeout"}\n',
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    // The adoption/timeout path still surfaces why the worker got stuck.
    expect(finalized.status).toBe("timeout");
    expect(finalized.blocker).toEqual({ reason: "stuck on missing credentials", at: 9 });
  });
});

describe("agents-worker session scoping", () => {
  let cwd: string;
  let fixtureDir: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const executeTool = async (
    name: string,
    params: Record<string, unknown>,
    sessionBranch: unknown[] = [],
  ) => {
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionBranch);
    const call = mockPi.registerTool.mock.calls.find((c) => c[0].name === name);
    if (!call) throw new Error(`tool ${name} not registered`);
    return call[0].execute("call-1", params as never, undefined, undefined, mockCtx);
  };

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    __resetWidgetStrip();
    cwd = await mkdtemp(join(tmpdir(), "agents-scope-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "agents-scope-fixture-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    setEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
    setEnv("PI_MAX_WORKERS", "1");
    await agentsExtension(mockPi);
  });

  afterEach(async () => {
    await getEventHandlerFrom(mockPi, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(cwd);
    await removeTempDir(fixtureDir);
  });

  it("workers list (default scope mine) hides another session's live workers", async () => {
    // A worker running under another live session: parent pid alive.
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-theirs",
        name: "theirs",
        parentPid: process.pid,
        status: "running",
      }),
    );

    const result = await executeTool("workers", { action: "list" });
    const text = result.content[0].text as string;
    expect(text).toContain("No workers yet");
    expect(text).not.toContain("theirs");
  });

  it("workers list scope=orphans shows ended sessions' leftovers, tagged", async () => {
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-orphan",
        name: "abandoned",
        parentPid: 999_999_999,
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outputText: "orphan report",
      }),
    );

    const result = await executeTool("workers", { action: "list", scope: "orphans" });
    const text = result.content[0].text as string;
    expect(text).toContain("[orphan]");
    expect(text).toContain("abandoned");
    // Orphans remain actionable: status reads their report.
    const status = await executeTool("workers", { action: "status", id: "w-orphan" });
    expect(status.content[0].text).toContain("orphan report");
  });

  it("workers list scope=all tags workers of other live sessions", async () => {
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-theirs",
        name: "theirs",
        parentPid: process.pid,
        status: "running",
      }),
    );

    const result = await executeTool("workers", { action: "list", scope: "all" });
    const text = result.content[0].text as string;
    expect(text).toContain("[other session]");
    expect(text).toContain("theirs");
  });

  it("the per-session worker cap ignores other sessions' live workers", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    // Another session is already at the (per-session) cap.
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-theirs",
        name: "theirs",
        parentPid: process.pid,
        status: "running",
      }),
    );

    // Cap is 1 for THIS session; the foreign running worker must not consume it.
    const started = await executeTool("delegate", { task: "t", isolate: false });
    expect(started.details.workerId).toBeDefined();
    await executeTool("workers", { action: "cancel", id: started.details.workerId as string });
  });

  it("a delegate persists the worker child pid on the record", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    try {
      const stored = await loadWorker(cwd, id);
      expect(typeof stored?.pid).toBe("number");
      expect(stored?.pid).toBeGreaterThan(0);
      // The pid is live: it is the spawned child itself, not a placeholder.
      expect(killSync(stored?.pid ?? 0)).toBe(true);
    } finally {
      await executeTool("workers", { action: "cancel", id });
    }
  });

  it("a delegate records the owning session on the worker", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "t", isolate: false, wait: true });
    // wait=true returns the full record, not the started-response shape.
    const id = started.details.worker.id as string;

    const stored = await loadWorker(cwd, id);
    expect(stored?.parentPid).toBe(process.pid);
    expect(stored?.parentSessionId).toBe("test-session");
  });

  it("collect on an orphan updates its artifact record, not this session's transcript", async () => {
    await initGitRepo(cwd);
    // An ended session left a completed isolated worker with a patch.
    const patchFile = join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-orphan.diff");
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "patches"), { recursive: true });
    await writeFile(patchFile, "diff", "utf8");
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-orphan",
        name: "abandoned",
        parentPid: 999_999_999,
        status: "completed",
        patchPath: patchFile,
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const collected = await executeTool("workers", {
      action: "collect",
      id: "w-orphan",
      apply: false,
    });
    expect(collected.content[0].text).toContain("Patch left unapplied");
    const stored = await loadWorker(cwd, "w-orphan");
    expect(stored?.collectedAt).toBeDefined();
    // No transcript entry: this session never owned the worker.
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("session_start warns only about workers still running from ended sessions", async () => {
    // Terminal leftovers are silent (drained by retention, listed on demand)…
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-orphan",
        name: "abandoned",
        parentPid: 999_999_999,
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );
    // …a stuck running record with a dead worker pid is finalized silently…
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-stuck",
        name: "stuck",
        parentPid: 999_999_999,
        pid: 999_999_999,
        status: "running",
        streamFormat: "raw",
        startedAt: Date.now(),
      }),
    );
    // …and a live orphan is the one thing worth a warning.
    const sleeper = execFile("sleep", ["30"]);
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-live",
        name: "live-orphan",
        parentPid: 999_999_999,
        pid: sleeper.pid ?? 0,
        status: "running",
        streamFormat: "raw",
        startedAt: Date.now(),
      }),
    );

    try {
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      const notifications = mockCtx.ui.notify.mock.calls.map((call) => call[0] as string);
      expect(notifications.some((text) => text.includes("still running"))).toBe(true);
      expect(notifications.some((text) => text.includes("live-orphan"))).toBe(true);
      // The stuck record was finalized silently (no report in its spool).
      expect((await loadWorker(cwd, "w-stuck"))?.status).toBe("failed");
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("session_start stays silent about terminal leftovers and their worktrees", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-orphan-wt");
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-orphan-wt",
        name: "abandoned",
        parentPid: 999_999_999,
        status: "failed",
        worktree: wt.path,
        branch: wt.branch,
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );
    // An unowned worktree with no record at all.
    await createWorktree(cwd, "w-unowned");

    await getEventHandlerFrom(mockPi, "session_start")(
      { type: "session_start", reason: "startup" },
      mockCtx,
    );

    // Terminal leftovers (with or without worktrees) never warn; they are
    // discoverable via scope=orphans and drained by retention/remove.
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("workers cancel kills a live orphaned worker and finalizes its record", async () => {
    // An ended session left a worker running; this session never owned it.
    const sleeper = execFile("sleep", ["30"]);
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-runaway",
        name: "runaway",
        parentPid: 999_999_999,
        pid: sleeper.pid ?? 0,
        status: "running",
        streamFormat: "raw",
        startedAt: Date.now(),
      }),
    );

    try {
      expect(sleeper.pid !== undefined && killSync(sleeper.pid)).toBe(true);
      const result = await executeTool("workers", { action: "cancel", id: "w-runaway" });
      expect(result.content[0].text).toContain("orphaned worker");
      const stored = await loadWorker(cwd, "w-runaway");
      expect(stored?.status).toBe("cancelled");
      // No transcript entry: this session never owned the worker.
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("an adopted worker is finalized and wakes the resumed session when it exits", async () => {
    // pi -c restored a running worker whose child exits on its own shortly
    // after the session starts: the adopter must finalize and wake.
    const shortSleeper = execFile("sleep", ["0.4"]);
    const record = makeWorkerRecord({
      id: "w-adopted",
      name: "adopted",
      pid: shortSleeper.pid ?? 0,
      status: "running",
      streamFormat: "raw",
      startedAt: Date.now(),
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-adopted.jsonl"),
      '{"type":"agents_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"adopted report"}]}}\n',
      "utf8",
    );

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      await vi.waitFor(
        async () => {
          const stored = await loadWorker(cwd, "w-adopted");
          expect(stored?.status).toBe("completed");
          expect(stored?.outputText).toContain("adopted report");
        },
        { timeout: 8_000 },
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        WORKER_RECORD_ENTRY,
        expect.objectContaining({ id: "w-adopted", status: "completed" }),
      );
      const wake = findWakeCall(mockPi);
      expect(wake.message.content[0].text).toContain("w-adopted");
    } finally {
      if (shortSleeper.pid !== undefined) await killPidTree(shortSleeper.pid);
    }
  });

  it("resumed sessions see their own workers via the transcript branch", async () => {
    const record = makeWorkerRecord({
      id: "w-mine",
      name: "mine",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
      outputText: "resumed report",
    });

    // pi -r restores the branch, entries included.
    const result = await executeTool("workers", { action: "list" }, [branchEntry(record)]);
    const text = result.content[0].text as string;
    expect(text).toContain("mine");
    expect(text).not.toContain("[orphan]");
  });
});

// --- Helpers ---

/** True when the pid is alive right now (test-side liveness probe). */
function killSync(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getEventHandlerFrom(mockPi: DeepMocked<ExtensionAPI>, eventType: string) {
  for (const call of mockPi.on.mock.calls) {
    if (call[0] === eventType) return call[1];
  }
  throw new Error(`Handler for ${eventType} not found`);
}

function makeWorkerRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: "w-1",
    name: "w-1",
    task: "t",
    model: "test-model",
    cwd: "/tmp",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}
