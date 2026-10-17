import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerLimits,
  planDelegate,
  startDelegatedWorker,
  type WorkerSessionState,
} from "../../extensions/workers/src/delegate.ts";
import {
  createWorkersWidget,
  formatRawStreamEntries,
  formatWorkersStatus,
} from "../../extensions/workers/src/format.ts";
import {
  abortReason,
  runSetupHook,
  SetupHookCancelled,
} from "../../extensions/workers/src/provision/hook.ts";
import {
  armAdoptedTimeout,
  assistantTextFromContent,
  extractAssistantOwnText,
  extractAssistantSettlement,
  extractAssistantText,
  finalizeWorker,
  ingestStreamEvent,
  killPidTree,
  readSpoolLines,
  STREAM_TAIL_BYTES,
  startWorker,
} from "../../extensions/workers/src/runner.ts";
import {
  createWorkerPersistence,
  generateWorkerId,
  listRecordFiles,
  loadWorker,
  loadWorkersFromBranch,
  migrateLegacyRegistry,
  patchPath,
  pruneStreams,
  pruneWorkerArtifacts,
  recordPath,
  removeWorkerRecord,
  stderrLogPath,
  streamPath,
  sweepWorkerArtifacts,
  updateRecordFile,
  WORKER_RECORD_ENTRY,
  WORKER_REMOVED_ENTRY,
  WORKER_RETENTION_MS,
  writeRecordFile,
} from "../../extensions/workers/src/store.ts";
import type { WorkerEvents, WorkerRecord } from "../../extensions/workers/src/types.ts";
import { resolveWorkerExtensions } from "../../extensions/workers/src/worker-extensions.ts";
import {
  applyPatch,
  captureWorktreePatch,
  createWorktree,
  DirtyWorktreeError,
  discardWorktree,
  isGitRepo,
  removeWorktree,
  worktreeBranch,
  worktreePath,
} from "../../extensions/workers/src/worktree.ts";
import workersExtension from "../../extensions/workers/workers.ts";
import { withFileLock } from "../../lib/file-lock.ts";
import { cleanGitEnv, runGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { isProcessAlive } from "../../lib/presence-shards.ts";

// Call-through spy: real cross-process locking behavior stays active for
// every code path, while tests can assert who took which lock.
vi.mock("../../lib/file-lock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/file-lock.ts")>();
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) };
});

// Provisioning stack: the setup hook and sandbox client are faked (tests
// never boot a sandbox); git stays a call-through spy so provision tests can
// fake a repository per test.
vi.mock("../../extensions/workers/src/provision/hook.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../extensions/workers/src/provision/hook.ts")>();
  return {
    ...actual,
    runSetupHook: vi.fn(async (worktree: string) => ({
      exitCode: 0,
      detail: "ok",
      ms: 1_000,
      logPath: `${worktree}/.worktreehook.log`,
    })),
  };
});
vi.mock("../../lib/git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/git.ts")>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
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
/** Runs the success report only after the release file appears, so a test
 *  controls completion timing instead of racing the parent's publish. */
const GATED_SUCCESS_WORKER = `#!/bin/sh
while [ ! -f "$GATED_WORKER_RELEASE" ]; do sleep 0.05; done
${SUCCESS_WORKER}`;
const BLOCKER_REASON = "this VM has no node_modules and no parent checkout";
const BLOCKER_RUNNING_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"workers_blocker","at":123,"reason":"${BLOCKER_REASON}"}' >> "$PI_WORKER_STREAM"
sleep 30
`;
const BLOCKER_DONE_WORKER = `#!/bin/sh
printf '%s\n' '{"type":"workers_blocker","at":123,"reason":"blocked briefly, worked around it"}' >> "$PI_WORKER_STREAM"
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

/** Setup files so isolated spawns clear the v2 preflight ladder. */
async function writeProvisionConfig(cwd: string): Promise<void> {
  await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  await writeFile(
    join(cwd, CONFIG_DIR_NAME, "sandbox.json"),
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
    }),
    "utf8",
  );
  await writeFile(join(cwd, CONFIG_DIR_NAME, "provision-worktree"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(cwd, CONFIG_DIR_NAME, "provision-worktree"), 0o755);
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
    if ((message as WakeMessageShape).customType === "workers:wake") {
      return {
        message: message as WakeMessageShape,
        options: options as WakeOptionsShape,
      };
    }
  }
  throw new Error("no workers:wake message was sent via pi.sendMessage");
}

/** The wake is emitted after the registry write, so poll rather than read once. */
async function waitForWake(pi: DeepMocked<ExtensionAPI>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = pi.sendMessage.mock.calls.some(
      ([message]) => (message as WakeMessageShape).customType === "workers:wake",
    );
    if (found) return;
    if (Date.now() > deadline) throw new Error("no workers:wake message within timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Sleep until a record's persisted deadline has passed, plus a margin: a
 *  "past the deadline" negative check must cover however long the test
 *  setup actually took on a loaded machine. */
async function waitPastDeadline(deadlineAt: number, marginMs = 300): Promise<void> {
  const remaining = deadlineAt - Date.now();
  await new Promise((resolve) => setTimeout(resolve, Math.max(marginMs, remaining) + marginMs));
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
  await createWorkerPersistence().persistWorkerRecord(() => {}, dir, record);
}

/** Transcript entry shape the extension appends worker records under. */
function branchEntry(record: WorkerRecord): {
  type: string;
  customType: string;
  data: WorkerRecord;
} {
  return { type: "custom", customType: WORKER_RECORD_ENTRY, data: record };
}

/** Transcript entry shape the extension appends on worker removal. */
function removedEntry(id: string): { type: string; customType: string; data: { id: string } } {
  return { type: "custom", customType: WORKER_REMOVED_ENTRY, data: { id } };
}

// --- Suite ---

describe("workers-extension", () => {
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
    cwd = await mkdtemp(join(tmpdir(), "workers-test-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "workers-fixture-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    // Default test configuration: most tests spawn workers, so a worker model
    // must resolve. The unconfigured-error test clears it again.
    setEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
    setEnv("PI_WORKER_MODEL_THINKING", undefined);
    setEnv("PI_MAX_WORKERS", undefined);
    setEnv("PI_WORKER_TIMEOUT_S", undefined);
    await workersExtension(mockPi);
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

  it("registers spawn_worker and workers tools without a per-call model override", () => {
    const definitions = mockPi.registerTool.mock.calls.map((c) => c[0]);
    const spawnTool = definitions.find((definition) => definition.name === "spawn_worker");
    expect(spawnTool).toBeDefined();
    expect(spawnTool?.parameters.properties).not.toHaveProperty("model");
    expect(definitions.some((definition) => definition.name === "workers")).toBe(true);
  });

  it("spawn_worker promptGuidelines keep investigation read-only and review in the parent", () => {
    const spawnTool = mockPi.registerTool.mock.calls.find((c) => c[0].name === "spawn_worker")?.[0];
    const guidelines = (spawnTool?.promptGuidelines ?? []).join("\n");
    expect(guidelines).toMatch(/read_only workers for investigation/);
    expect(guidelines).toMatch(/design decisions/);
    expect(guidelines).toMatch(/verify/i);
    expect(guidelines).not.toMatch(/approv/i);
  });

  it("spawn_worker promptGuidelines state the worker slot lifecycle", () => {
    const spawnTool = mockPi.registerTool.mock.calls.find((c) => c[0].name === "spawn_worker")?.[0];
    const guidelines = (spawnTool?.promptGuidelines ?? []).join(" ");
    expect(guidelines).toContain("slot");
    expect(guidelines).toContain("terminal state");
    expect(guidelines).toContain("cancel");
    expect(guidelines).toContain("remove");
    expect(guidelines).toContain("spawn_worker again");
  });

  it("spawn_worker throws on an empty task", async () => {
    await expect(executeTool("spawn_worker", { task: "   " })).rejects.toThrow(
      /spawn_worker requires task/,
    );
  });

  it("spawn_worker read_only starts an investigation worker without a worktree", async () => {
    await initGitRepo(cwd);
    const argsFile = join(fixtureDir, "readonly-args.txt");
    const rootFile = join(fixtureDir, "readonly-messenger-root.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "readonly-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
printf '%s' "$PI_MESSENGER_PROJECT_ROOT" > '${rootFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_WORKER_EXTENSIONS", undefined);
    const result = await executeTool("spawn_worker", {
      task: "research",
      read_only: true,
      wait: true,
    });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).toContain("--worker-readonly");
    expect(args).not.toContain("--gondolin");
    expect(args.some((arg) => arg.includes("worker-sandbox.ts"))).toBe(true);
    expect(result.details.worker.worktree).toBeUndefined();
    expect(await readFile(rootFile, "utf8")).toBe(cwd);
    const gatePaths = args.filter((arg) => arg.includes("approval-mode.ts"));
    expect(gatePaths).toHaveLength(1);
  });

  it("relays worker mode and approval requests without putting them in the output spool", async () => {
    const fixture = await writeFixture(
      fixtureDir,
      "approval-worker.mjs",
      `#!/usr/bin/env node
import { Socket } from 'node:net';
const channel = new Socket({ fd: Number(process.env.PI_WORKER_APPROVAL_FD), readable: true, writable: true });
let buffer = '';
channel.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const reply = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (reply.id === 'mode') {
      if (reply.reply.enabled !== false) process.exit(2);
      channel.write(JSON.stringify({ id: 'approve', request: { kind: 'approval', command: 'npm test', cwd: process.cwd(), toolName: 'bash', decision: 'uncertain', reason: 'Risk is uncertain' } }) + '\\n');
    } else {
      if (reply.reply.approved !== true) process.exit(3);
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'approved once' }] } }));
      channel.end();
    }
  }
});
channel.write(JSON.stringify({ id: 'mode', request: { kind: 'mode' } }) + '\\n');
`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    mockPi.events.emit.mockImplementation((name, data) => {
      if (name !== "approval-mode:worker-request") return;
      const event = data as {
        request: { kind: string };
        respond(reply: { enabled: boolean } | { approved: boolean }): void;
      };
      event.respond(event.request.kind === "mode" ? { enabled: false } : { approved: true });
    });
    const result = await executeTool("spawn_worker", {
      task: "research",
      read_only: true,
      wait: true,
    });
    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toBe("approved once");
    expect(mockPi.events.emit).toHaveBeenCalledWith(
      "approval-mode:worker-request",
      expect.objectContaining({
        worker: expect.objectContaining({ id: result.details.worker.id, cwd }),
        request: { kind: "mode" },
        signal: expect.any(AbortSignal),
        respond: expect.any(Function),
      }),
    );
    expect(mockPi.events.emit).toHaveBeenCalledWith(
      "approval-mode:worker-request",
      expect.objectContaining({
        request: expect.objectContaining({ kind: "approval", command: "npm test" }),
      }),
    );
    const spool = await readFile(streamPath(cwd, result.details.worker.id), "utf8");
    expect(spool).not.toContain('"kind":"approval"');
    expect(spool).toContain("approved once");
  });

  it("rejects a read_only worker that also requests an isolated write worktree", async () => {
    await expect(
      executeTool("spawn_worker", { task: "research", read_only: true, isolate: true }),
    ).rejects.toThrow(/read_only=true/);
  });

  it("spawn_worker enforces the environment worker model when a caller supplies another model", async () => {
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

    const result = await executeTool("spawn_worker", {
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

  it("spawn_worker enforces the saved worker model when a caller supplies another model", async () => {
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

    const result = await executeTool("spawn_worker", {
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

  it("spawn_worker enforces messenger and worker-sandbox when extensions are empty", async () => {
    const argsFile = join(fixtureDir, "mandatory-args.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "mandatory-worker.sh",
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("spawn_worker", {
      task: "say hi",
      extensions: [],
      isolate: false,
      wait: true,
    });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args.some((arg) => arg.includes("messenger.ts"))).toBe(true);
    expect(args.some((arg) => arg.includes("worker-sandbox.ts"))).toBe(true);
  });

  it("spawn_worker spawns workers with the resolved extension paths and worker-sandbox", async () => {
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

    await executeTool("spawn_worker", { task: "say hi", isolate: false, wait: true });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).not.toContain("--gondolin");
    const messengerIndex = args.indexOf("-e");
    expect(messengerIndex).toBeGreaterThanOrEqual(0);
    expect(args[messengerIndex + 1]).toContain("messenger.ts");
    expect(args.some((arg) => arg.includes("worker-sandbox.ts"))).toBe(true);
    expect(args.some((arg) => arg.includes("code-search"))).toBe(true);
  });

  it("spawn_worker rejects forbidden worker extensions outright", async () => {
    setEnv("PI_WORKER_COMMAND", join(fixtureDir, "unused.sh"));

    await expect(
      executeTool("spawn_worker", { task: "anything", isolate: false, extensions: ["workers"] }),
    ).rejects.toThrow(/forbidden/);
  });

  it("spawn_worker throws when isolate=true outside a git repo", async () => {
    // cwd is a plain temp directory, not a git repository.
    await expect(executeTool("spawn_worker", { task: "t", isolate: true })).rejects.toThrow(
      /isolate=true requires a git repository/,
    );
  });

  it("spawn_worker returns the report when terminal persistence fails", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    // Transcript entry writes fail at the worst moment: the terminal save.
    // done must still settle and the wake must still fire, or wait=true
    // hangs forever and the fire-and-forget cleanup never runs.
    mockPi.appendEntry.mockImplementation(() => {
      throw new Error("ENOSPC: transcript write failed");
    });

    const result = await executeTool("spawn_worker", {
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

    const started = await executeTool("spawn_worker", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.details.worker.status).toBe("cancelled");
  });

  it("workers cancel records cancellation instead of a timeout", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    const started = await executeTool("spawn_worker", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.content[0].text).toContain("cancelled");
    expect(cancelled.details.worker.status).toBe("cancelled");
    expect(cancelled.details.worker.error).toBe("cancelled by user");
    const saved = await loadWorker(cwd, id);
    expect(saved?.status).toBe("cancelled");
    expect(saved?.error).toBe("cancelled by user");
    expect(mockCtx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      "warning",
    );
  });

  it("spawn_worker fails with a descriptive error when no worker model is configured", async () => {
    setEnv("PI_WORKER_MODEL", undefined);
    // No worker-model.json config exists in the temp cwd's agent dir.
    await expect(
      executeTool("spawn_worker", { task: "anything", isolate: false, model: undefined }),
    ).rejects.toThrow(/worker model is not configured/i);
  });

  it("spawn_worker runs a worker and returns its report when wait=true", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("spawn_worker", {
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

  it("spawn_worker sets PI_MESSENGER_NAME so workers are addressable by their worker name", async () => {
    const envFile = join(fixtureDir, "captured-name.txt");
    const fixture = await writeFixture(
      fixtureDir,
      "env-worker.sh",
      `#!/bin/sh
printf '%s' "$PI_MESSENGER_NAME" > '${envFile}'
${SUCCESS_WORKER}`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("spawn_worker", {
      task: "say hi",
      isolate: false,
      wait: true,
      name: "addressable",
    });

    expect(await readFile(envFile, "utf8")).toBe("addressable");
  });

  it("spawn_worker marks failed workers with stderr detail", async () => {
    const fixture = await writeFixture(fixtureDir, "fail-worker.sh", FAILING_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("spawn_worker", { task: "do it", isolate: false, wait: true });
    expect(result.details.worker.status).toBe("failed");
    expect(result.details.worker.error).toContain("boom");
  });

  it("wakes the parent with ids and status words only when a worker fails", async () => {
    const fixture = await writeFixture(fixtureDir, "noisy-fail-worker.sh", NOISY_FAILING_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "do it", isolate: false });
    const id = started.details.workerId as string;

    await waitForRecord(cwd, id, "failed");
    await waitForWake(mockPi);
    const wake = findWakeCall(mockPi);

    expect(wake.message.details).toMatchObject({ source: "workers", trusted: true });
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

    const result = await executeTool("spawn_worker", {
      task: "silent",
      isolate: false,
      wait: true,
    });

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

    const result = await executeTool("spawn_worker", { task: "split", isolate: false, wait: true });

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

    const result = await executeTool("spawn_worker", { task: "tail", isolate: false, wait: true });

    expect(result.details.worker.status).toBe("completed");
    expect(result.details.worker.outputText).toBe("no newline");
  });

  it("captures a timed-out isolated worker's patch after the process stops", async () => {
    await initGitRepo(cwd);
    await writeProvisionConfig(cwd);
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

    const result = await executeTool("spawn_worker", {
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

  it("a timed-out worker keeps the timeout reason in its record and response", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("spawn_worker", {
      task: "long",
      isolate: false,
      wait: true,
      timeout_seconds: 1,
    });

    expect(result.details.worker.status).toBe("timeout");
    expect(result.details.worker.error).toContain("worker exceeded 1s timeout");
    const record = await loadWorker(cwd, result.details.worker.id as string);
    expect(record?.status).toBe("timeout");
    expect(record?.error).toContain("worker exceeded 1s timeout");
  });

  it("a spawned worker's record persists its hard-timeout deadline", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const result = await executeTool("spawn_worker", {
      task: "quick",
      isolate: false,
      wait: true,
      timeout_seconds: 5,
    });

    const record = await loadWorker(cwd, result.details.worker.id as string);
    // The deadline is the exact spawn-time bound (startedAt + timeout), so
    // an adopter can re-arm the remaining time once the parent is gone.
    expect(record?.status).toBe("completed");
    expect(record?.deadlineAt).toBe((record?.startedAt ?? 0) + 5_000);
  });

  it("enforces the worker concurrency limit", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    setEnv("PI_MAX_WORKERS", "1");

    const first = await executeTool("spawn_worker", { task: "one", isolate: false });
    expect(first.details.workerId).toBeDefined();

    await expect(executeTool("spawn_worker", { task: "two", isolate: false })).rejects.toThrow(
      /limit reached/,
    );
  });

  it("spawn_worker rejects duplicate running worker names", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    await executeTool("spawn_worker", { task: "one", isolate: false, name: "scout" });
    await expect(
      executeTool("spawn_worker", { task: "two", isolate: false, name: "scout" }),
    ).rejects.toThrow(/already running/);
  });

  it("assertWorkerLimits treats case-variant names as taken on a folding volume", () => {
    const state: WorkerSessionState = {
      running: new Map(),
      branchWorkers: new Map(),
      reserved: new Map(),
    };

    // APFS folds case: "Fix" must not run beside a live "fix", or both
    // write the same presence shard and clobber each other.
    expect(() => assertWorkerLimits(state, "Fix", 4, ["fix"], true)).toThrow(/already running/);
    expect(() => assertWorkerLimits(state, "fix", 4, [], true)).not.toThrow();

    // A case-sensitive volume keeps the names distinct.
    expect(() => assertWorkerLimits(state, "Fix", 4, ["fix"], false)).not.toThrow();
  });

  it("workers status reads a finished worker's report", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "look", isolate: false, wait: true });
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
    const persistence = createWorkerPersistence();
    const appendEntry = vi.fn();
    await persistence.persistWorkerRecord(appendEntry, cwd, {
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
    const persisted = await persistence.persistWorkerRecord(appendEntry, cwd, {
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
    const persistence = createWorkerPersistence();
    const appendEntry = vi.fn();
    const running = persistence.persistWorkerRecord(appendEntry, cwd, {
      id: "w-race",
      name: "race",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });
    await persistence.persistWorkerRecord(appendEntry, cwd, {
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
      `{"type":"workers_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"salvaged report"}]}}\n`,
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
    const scratch = `${CONFIG_DIR_NAME}/provision-tmp-Ab12Cd34/npm-cache/blob`;
    const scratchFile = `${CONFIG_DIR_NAME}/provision-tmp-Ef56Gh78`;
    await mkdir(join(cwd, CONFIG_DIR_NAME, "provision-tmp-Ab12Cd34", "npm-cache"), {
      recursive: true,
    });
    await writeFile(join(cwd, scratch), "cached package\n");
    await writeFile(join(cwd, scratchFile), "temporary credentials\n");

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(`${projectStateRelative("workers")}/`);
    expect(exclude.split("\n")).toContain(`${projectStateRelative("worktrees")}/`);
    expect(exclude.split("\n")).toContain(projectStateRelative("provision-tmp-*"));
    expect(await runGit(cwd, ["check-ignore", "-v", scratch])).toContain("provision-tmp-*");
    expect(await runGit(cwd, ["check-ignore", "-v", scratchFile])).toContain("provision-tmp-*");
    expect(await runGit(cwd, ["status", "--porcelain"])).toBe("");
    const wt = await createWorktree(cwd, "w-exclude-scratch");
    await mkdir(join(wt.path, CONFIG_DIR_NAME, "provision-tmp-Ab12Cd34", "npm-cache"), {
      recursive: true,
    });
    await writeFile(join(wt.path, scratch), "cached package\n");
    await writeFile(join(wt.path, scratchFile), "temporary credentials\n");
    expect(await runGit(wt.path, ["check-ignore", "-v", scratch])).toContain("provision-tmp-*");
    expect(await runGit(wt.path, ["check-ignore", "-v", scratchFile])).toContain("provision-tmp-*");
    expect(await runGit(wt.path, ["status", "--porcelain"])).toBe("");
    // The shared registry is gone after the one-time migration.
    await expect(
      stat(join(cwd, CONFIG_DIR_NAME, "workers", "registry.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("session_shutdown cancels running workers", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "long", isolate: false });
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

    await executeTool("spawn_worker", { task: "long", isolate: false });
    const stateEmitCount = () =>
      mockPi.events.emit.mock.calls.filter(([event]) => event === "workers:state").length;

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

    const started = await executeTool("spawn_worker", { task: "long", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.content[0].text).toContain("cancelled");
    expect(cancelled.details.worker.status).toBe("cancelled");
    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("cancelled");
  });

  it("workers cancel on a terminal worker reports the free slot and redirects to remove", async () => {
    // The observed failure mode: cancel called repeatedly on an already-dead
    // worker because the response did not name the action that helps.
    await seedRecord(cwd, makeWorkerRecord({ id: "w-timed", name: "timed", status: "timeout" }));

    const result = await executeTool("workers", { action: "cancel", id: "w-timed" });
    expect(result.content[0].text).toContain("is already timeout");
    expect(result.content[0].text).toContain("slot is free");
    expect(result.content[0].text).toContain("action=remove");
    expect(result.content[0].text).toContain("spawn_worker to start a new worker");
  });

  it("workers remove rejects traversal before touching another worker's worktree", async () => {
    const victim = join(cwd, CONFIG_DIR_NAME, "worktrees", "w-victim");
    await mkdir(victim, { recursive: true });
    vi.mocked(runGit).mockClear();

    await expect(
      executeTool("workers", { action: "remove", id: "w-decoy/../w-victim" }),
    ).rejects.toThrow(/Invalid worker id/);
    expect(existsSync(victim)).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
    await expect(executeTool("workers", { action: "status", id: "w-victim\n" })).rejects.toThrow(
      /Invalid worker id/,
    );
  });

  it("a worker whose binary is missing persists and notifies the spawn error", async () => {
    setEnv("PI_WORKER_COMMAND", join(fixtureDir, "missing-binary.sh"));

    const result = await executeTool("spawn_worker", {
      task: "doomed",
      isolate: false,
      wait: true,
    });

    expect(result.details.worker.status).toBe("failed");
    expect(result.details.worker.error).toContain("ENOENT");
    const id = result.details.worker.id as string;
    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("ENOENT");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ENOENT"), "error");
  });

  it("a failed spawn settles completion without a cancel request", async () => {
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(join(streams, ".."), { recursive: true });
    await writeFile(streams, "not a directory", "utf8");
    const events = testEvents();
    const onRecord = vi.fn((record: WorkerRecord) => writeRecordFile(cwd, record));
    const running = await startWorker({
      cwd,
      task: "doomed",
      model: "test-model",
      thinkingLevel: "medium",
      name: "doomed",
      timeoutMs: 60_000,
      workerId: "w-failed-spawn",
      extensionPaths: [],
      events,
      onRecord,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        running.done,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("failed spawn did not settle")), 1_000);
        }),
      ]);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("EEXIST");
      expect((await loadWorker(cwd, result.id))?.status).toBe("failed");
      expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
      expect(events.notify).toHaveBeenCalledWith("error", expect.stringContaining("EEXIST"));
    } finally {
      if (timer) clearTimeout(timer);
      await running.cancel();
    }
  });

  it("a failed spawn releases its worker slot without cancellation", async () => {
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(join(streams, ".."), { recursive: true });
    await writeFile(streams, "not a directory", "utf8");
    setEnv("PI_MAX_WORKERS", "1");

    const first = await executeTool("spawn_worker", { task: "doomed", isolate: false });
    const failed = await waitForRecord(cwd, first.details.workerId as string, "failed", 2_000);
    expect(failed.error).toContain("EEXIST");
    await rm(streams, { force: true });
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const next = await executeTool("spawn_worker", { task: "works", isolate: false, wait: true });
    expect(next.details.worker.status).toBe("completed");
  });

  it.each(["failed", "completed"] as const)(
    "cancel waits for a %s worker's terminal record write",
    async (status) => {
      if (status === "failed") {
        const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
        await mkdir(join(streams, ".."), { recursive: true });
        await writeFile(streams, "not a directory", "utf8");
      } else {
        setEnv(
          "PI_WORKER_COMMAND",
          await writeFixture(fixtureDir, "persist-worker.sh", SUCCESS_WORKER),
        );
      }
      let releaseWrite: () => void = () => {};
      const writeAllowed = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let signalWriteStarted: () => void = () => {};
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      const onRecord = vi.fn(async (record: WorkerRecord) => {
        signalWriteStarted();
        await writeAllowed;
        await writeRecordFile(cwd, record);
      });
      const events = testEvents();
      const running = await startWorker({
        cwd,
        task: "persist before cleanup",
        model: "test-model",
        thinkingLevel: "medium",
        name: "persist-before-cleanup",
        timeoutMs: 60_000,
        workerId: `w-${status}-persist`,
        extensionPaths: [],
        events,
        onRecord,
      });
      await writeStarted;
      expect(running.record.status).toBe(status);
      const cancelled = vi.fn();
      const cancellation = running.cancel().then(() => cancelled());
      try {
        await Promise.resolve();
        expect(cancelled).not.toHaveBeenCalled();
        expect(await loadWorker(cwd, running.record.id)).toBeUndefined();
      } finally {
        releaseWrite();
        await Promise.all([cancellation, running.done]);
      }
      expect(cancelled).toHaveBeenCalledWith();
      expect(onRecord).toHaveBeenCalledTimes(1);
      expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ status }));
      expect((await loadWorker(cwd, running.record.id))?.status).toBe(status);
    },
  );

  it("workers cancel reports a worker whose spawn never produced a child", async () => {
    // The streams path as a regular file fails the runner's spool mkdir before
    // spawn. Completion marks the record failed; cancellation must preserve it.
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(join(streams, ".."), { recursive: true });
    await writeFile(streams, "not a directory", "utf8");

    const started = await executeTool("spawn_worker", { task: "doomed", isolate: false });
    const id = started.details.workerId as string;

    const cancelled = await executeTool("workers", { action: "cancel", id });
    expect(cancelled.details.worker.status).toBe("failed");
    expect(cancelled.details.worker.error).toContain("EEXIST");
    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("EEXIST");
  });

  it("drains a large worker spool without allocating the whole burst", async () => {
    const fixture = await writeFixture(
      fixtureDir,
      "large-spool-worker.sh",
      `#!/bin/sh\nnode -e 'process.stdout.write("x".repeat(${STREAM_TAIL_BYTES * 4}) + "\\n")'\nprintf '\\n%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"complete"}]}}'\n`,
    );
    setEnv("PI_WORKER_COMMAND", fixture);
    const alloc = vi.spyOn(Buffer, "alloc");
    try {
      const result = await executeTool("spawn_worker", {
        task: "large spool",
        isolate: false,
        wait: true,
      });
      expect((result.details.worker as WorkerRecord).status).toBe("completed");
      expect(alloc.mock.calls.some(([size]) => size > STREAM_TAIL_BYTES)).toBe(false);
    } finally {
      alloc.mockRestore();
    }
  });

  it("startWorker rejects an already-aborted signal without spawning a child", async () => {
    const spawnMarker = join(fixtureDir, "preaborted-spawn-marker");
    setEnv(
      "PI_WORKER_COMMAND",
      await writeFixture(
        fixtureDir,
        "preaborted-spawn-marker.sh",
        `#!/bin/sh\ntouch '${spawnMarker}'\nexit 0\n`,
      ),
    );
    const events = testEvents();
    const controller = new AbortController();
    controller.abort();

    await expect(
      startWorker({
        cwd,
        task: "never starts",
        model: "test-model",
        thinkingLevel: "medium",
        name: "preaborted",
        timeoutMs: 60_000,
        workerId: "w-preaborted",
        extensionPaths: [],
        signal: controller.signal,
        events,
        onRecord: async () => {},
      }),
    ).rejects.toThrow(SetupHookCancelled);

    expect(existsSync(spawnMarker)).toBe(false);
    expect(existsSync(streamPath(cwd, "w-preaborted"))).toBe(false);
    expect(events.wake).not.toHaveBeenCalled();
    expect(events.notify).not.toHaveBeenCalled();
  });

  it("session_shutdown preserves a failed-spawn record and cancels a live worker", async () => {
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(join(streams, ".."), { recursive: true });
    await writeFile(streams, "not a directory", "utf8");
    const doomed = await executeTool("spawn_worker", { task: "doomed", isolate: false });
    const doomedId = doomed.details.workerId as string;

    // Restore the streams dir so the second worker spawns normally.
    await rm(streams, { force: true });
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);
    const live = await executeTool("spawn_worker", { task: "long", isolate: false });
    const liveId = live.details.workerId as string;

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    const doomedRecord = await loadWorker(cwd, doomedId);
    expect(doomedRecord?.status).toBe("failed");
    expect(doomedRecord?.error).toContain("EEXIST");
    const liveRecord = await loadWorker(cwd, liveId);
    expect(liveRecord?.status).toBe("cancelled");
  });

  it("workers collect applies an isolated worker's patch and cleans up, keeping the stream", async () => {
    await initGitRepo(cwd);
    await writeProvisionConfig(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", {
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
    const { captureWorktreePatch } = await import("../../extensions/workers/src/worktree.ts");
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
    await writeProvisionConfig(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
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
    await writeProvisionConfig(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(worker.worktree as string, "X.md"), "x\n");
    const { captureWorktreePatch } = await import("../../extensions/workers/src/worktree.ts");
    await captureWorktreePatch(worker.worktree as string, worker.patchPath as string);

    await executeTool("workers", { action: "collect", id: worker.id });
    await expect(executeTool("workers", { action: "collect", id: worker.id })).rejects.toThrow(
      /already collected/,
    );
  });

  it("workers collect with apply=false leaves the patch unapplied", async () => {
    await initGitRepo(cwd);
    await writeProvisionConfig(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
    const worker = started.details.worker;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(worker.worktree as string, "UNAPPLIED.md"), "unapplied\n");
    const { captureWorktreePatch } = await import("../../extensions/workers/src/worktree.ts");
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
    await writeProvisionConfig(cwd);
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
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

  it("workers collect skips git apply on an empty patch and reports nothing to apply", async () => {
    // The read-only-worker case: a captured patch with zero bytes. `git apply`
    // rejects it ("No valid patches in input"), so the skip must happen before
    // any git invocation. Seeded record without a worktree keeps git out.
    vi.mocked(runGit).mockClear();
    const patchPath = join(cwd, "w-empty.patch");
    await writeFile(patchPath, "");
    await seedRecord(
      cwd,
      makeWorkerRecord({ id: "w-empty", name: "reader", status: "completed", patchPath }),
    );

    const collected = await executeTool("workers", { action: "collect", id: "w-empty" });

    expect(collected.content[0].text).toBe(
      "No changes in worker reader's patch; nothing to apply.",
    );
    expect(vi.mocked(runGit).mock.calls.some((call) => call[1][0] === "apply")).toBe(false);
    const record = await loadWorker(cwd, "w-empty");
    expect(record?.collectedAt).toBeDefined();
  });

  it("workers collect on a whitespace-only patch applies nothing and cleans up", async () => {
    vi.mocked(runGit).mockClear();
    const patchPath = join(cwd, "w-blank.patch");
    await writeFile(patchPath, "\n\n");
    await seedRecord(
      cwd,
      makeWorkerRecord({ id: "w-blank", name: "blank", status: "completed", patchPath }),
    );

    const collected = await executeTool("workers", {
      action: "collect",
      id: "w-blank",
      cleanup: false,
    });

    expect(collected.content[0].text).toBe("No changes in worker blank's patch; nothing to apply.");
    expect(vi.mocked(runGit).mock.calls.some((call) => call[1][0] === "apply")).toBe(false);
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

      await executeTool("spawn_worker", { task: "t", isolate: false, name: "scout" });

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

    it("clears the widget when a fire-and-forget worker completes, without shutdown", async () => {
      // A gated worker: the running state is stable until the test releases
      // it, so neither assertion races the child's exit (an instantly-
      // exiting worker can complete before the spawn path's publish, and
      // then the strip is legitimately never published at all).
      const release = join(fixtureDir, "release-gate");
      setEnv("GATED_WORKER_RELEASE", release);
      const fixture = await writeFixture(fixtureDir, "gated-worker.sh", GATED_SUCCESS_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", {
        task: "t",
        isolate: false,
        name: "quick",
      });
      const id = started.details.workerId as string;
      // The widget is up while the worker runs (frozen-snapshot risk: rows
      // mutate in place, so a stale entry would show "completed" under a
      // "1 running" header).
      expect(renderLastWidget().join("\n")).toContain('"quick" running');

      // Release the worker; it completes and the fire-and-forget done
      // handler must republish: last strip call is the clear, with no
      // session_shutdown in between.
      await writeFile(release, "go\n");
      await waitForRecord(cwd, id, "completed");
      await vi.waitFor(() => {
        expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
      });
    });
  });

  // --- Status-line fallback (default footer when the status bar is off) ---

  describe("status line fallback", () => {
    it("sets a formatted status line while workers run and clears it when none run", async () => {
      const fixture = await writeFixture(fixtureDir, "slow-status-worker.sh", SLOW_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      await executeTool("spawn_worker", { task: "t", isolate: false, name: "scout" });

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
        "workers",
        expect.stringContaining("Workers: 1 running"),
      );

      await getEventHandler("session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        mockCtx,
      );
      expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("workers", undefined);
    });

    it("formats the status line from running count and rolled-up worker cost", () => {
      const theme = { fg: (_color: string, text: string) => text };
      expect(formatWorkersStatus(theme, 2, 0.041)).toBe("⚙ Workers: 2 running · $0.04");
      // Sub-cent spends stay visible instead of rounding to $0.00.
      expect(formatWorkersStatus(theme, 1, 0.004)).toBe("⚙ Workers: 1 running · $<0.01");
      // Nothing running: the fallback is cleared, like the widget.
      expect(formatWorkersStatus(theme, 0, 1.5)).toBeUndefined();
    });
  });

  // --- Live worker activity ---

  describe("workers live activity", () => {
    it("tracks live tool activity on the running record and spools the stream", async () => {
      const fixture = await writeFixture(fixtureDir, "active-worker.sh", ACTIVE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", { task: "read auth", isolate: false });
      const id = started.details.workerId as string;

      // The spool projection captures the tool lifecycle and assistant text
      // while the worker is still running. (The activity snapshot itself is
      // intentionally in-memory only — the widget reads the live record.)
      await vi.waitFor(
        async () => {
          const raw = await readFile(streamPath(cwd, id), "utf8").catch(() => "");
          expect(raw).toContain('"type":"tool_execution_start"');
          expect(raw).toContain('"type":"tool_execution_end"');
          expect(raw).toContain("Reading auth module");
        },
        { timeout: 10_000 },
      );

      await executeTool("workers", { action: "cancel", id });
    });

    it("shows live activity in the workers widget line", async () => {
      const fixture = await writeFixture(fixtureDir, "active-widget.sh", ACTIVE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      // Short name: the frame line is width-truncated, and a uuid-long id
      // would push the activity segment past the truncation point.
      const started = await executeTool("spawn_worker", {
        task: "t",
        isolate: false,
        name: "scout",
      });
      const id = started.details.workerId as string;

      await vi.waitFor(
        async () => {
          const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
          const factory = lastCall[1] as
            | ((tui: unknown, theme: unknown) => { render(w: number): string[] })
            | undefined;
          if (typeof factory !== "function") throw new Error("no widget factory");
          const component = factory(undefined, mockCtx.ui.theme);
          const text = component.render(160).join("\n");
          expect(text).toContain("▸ read src/auth.ts");
        },
        { timeout: 10_000 },
      );
      await executeTool("workers", { action: "cancel", id });
    });

    it("workers tail reads the bounded stream after completion", async () => {
      const fixture = await writeFixture(fixtureDir, "tail-worker.sh", TAIL_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", {
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

    it("workers tail keeps missing-stream wording for ENOENT but surfaces real spool read failures", async () => {
      // Legacy (parent-projected) records carry no streamFormat; tail reads
      // their spool whole, and a missing spool has its own wording.
      const missing = makeWorkerRecord({
        id: "w-tailgone",
        name: "gone",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
      });
      await seedRecord(cwd, missing);
      await expect(executeTool("workers", { action: "tail", id: missing.id })).rejects.toThrow(
        /No stream captured for worker w-tailgone/,
      );

      // A spool that exists but cannot be read must surface the underlying
      // read error, not masquerade as a missing stream.
      const blocked = makeWorkerRecord({
        id: "w-tailbad",
        name: "bad",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
      });
      await seedRecord(cwd, blocked);
      await mkdir(streamPath(cwd, blocked.id), { recursive: true });
      await expect(
        executeTool("workers", { action: "tail", id: blocked.id }),
      ).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("rolls up worker usage and publishes it on workers:state", async () => {
      const fixture = await writeFixture(fixtureDir, "usage-worker.sh", USAGE_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", {
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
        ([event]) => event === "workers:state",
      );
      const payload = stateEvents.at(-1)?.[1] as { running: number; workerCostUsd: number };
      expect(payload.workerCostUsd).toBeCloseTo(0.041);
    });

    it("tail reads stay bounded however much the child wrote", async () => {
      const fixture = await writeFixture(fixtureDir, "spool-cap.sh", SPOOL_CAP_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", {
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

      const started = await executeTool("spawn_worker", { task: "stuck task", isolate: false });
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

      const started = await executeTool("spawn_worker", { task: "stuck task", isolate: false });
      const id = started.details.workerId as string;

      await waitForWake(mockPi);
      const wakes = mockPi.sendMessage.mock.calls.filter(
        ([message]) => (message as WakeMessageShape).customType === "workers:wake",
      );
      expect(wakes).toHaveLength(1);
      const [message, options] = wakes[0] as unknown as [WakeMessageShape, WakeOptionsShape];
      expect(message.details).toMatchObject({ source: "workers", trusted: true });
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

      const result = await executeTool("spawn_worker", { task: "t", isolate: false, wait: true });

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

      const started = await executeTool("spawn_worker", {
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

  it("a second extension instance persists terminal saves after the first removed the same id", async () => {
    // Two Pi instances in one process share the module registry; the
    // persistence queues and removal tombstones must not be shared state.
    const id = "w-reload";

    // Instance one owns the worker and removes it.
    const removed = makeWorkerRecord({
      id,
      name: "reload",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    });
    await seedRecord(cwd, removed);
    mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(removed)]);
    await executeTool("workers", { action: "remove", id });
    expect(await loadWorker(cwd, id)).toBeUndefined();

    // Instance two (fresh extension instance, same project cwd) restores the
    // same id as running-from-transcript and salvage-finalizes it: its
    // persistence state is its own, so the terminal save must land.
    const running = makeWorkerRecord({
      id,
      name: "reload",
      pid: 999_999_999,
      status: "running",
      startedAt: Date.now(),
      streamFormat: "raw",
    });
    await seedRecord(cwd, running);
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, `${id}.jsonl`),
      `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"salvaged report"}]}}\n`,
      "utf8",
    );
    const mockPi2 = createMockPi() as DeepMocked<ExtensionAPI>;
    const mockCtx2 = createMockContext();
    (mockCtx2 as { cwd: string }).cwd = cwd;
    mockCtx2.sessionManager.getBranch = vi.fn(() => [branchEntry(running)]);
    await workersExtension(mockPi2);
    const startHandler = mockPi2.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    if (!startHandler) throw new Error("handler for session_start not found");
    await startHandler({ type: "session_start", reason: "startup" }, mockCtx2);

    expect(await loadWorker(cwd, id)).toMatchObject({
      status: "completed",
      outputText: expect.stringContaining("salvaged report"),
    });
    expect(mockPi2.appendEntry).toHaveBeenCalledWith(
      WORKER_RECORD_ENTRY,
      expect.objectContaining({ id, status: "completed" }),
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
    await expect(runGit(cwd, ["rev-parse", "--verify", "workers/w-wt"])).rejects.toThrow();
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
    await expect(runGit(cwd, ["rev-parse", "--verify", "workers/w-lost"])).rejects.toThrow();
  });

  it("workers remove tombstones a transcript-owned worker so it stays absent after reload", async () => {
    await initGitRepo(cwd);
    const record = makeWorkerRecord({
      id: "w-gone",
      name: "gone",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    let branch: unknown[] = [branchEntry(record)];
    mockCtx.sessionManager.getBranch = vi.fn(() => branch);

    const removed = await executeTool("workers", { action: "remove", id: "w-gone" });
    expect(removed.content[0].text).toContain("removed");
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      WORKER_REMOVED_ENTRY,
      expect.objectContaining({ id: "w-gone" }),
    );
    expect(await loadWorker(cwd, "w-gone")).toBeUndefined();

    // pi persisted the marker to the transcript: the next workers action
    // and a session_start replay must both keep the id absent.
    branch = [branchEntry(record), removedEntry("w-gone")];

    const relisted = await executeTool("workers", { action: "list" });
    expect(relisted.content[0].text).not.toContain("w-gone");

    await getEventHandler("session_start")({ type: "session_start", reason: "reload" }, mockCtx);
    const afterReload = await executeTool("workers", { action: "list" });
    expect(afterReload.content[0].text).toContain("No workers yet");
    await expect(executeTool("workers", { action: "status", id: "w-gone" })).rejects.toThrow(
      /Unknown worker/,
    );
  });

  it("refresh reconciles a removal marker replayed from the branch", async () => {
    const record = makeWorkerRecord({
      id: "w-drop",
      name: "drop",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    let branch: unknown[] = [branchEntry(record)];
    mockCtx.sessionManager.getBranch = vi.fn(() => branch);

    // First action caches the record in memory.
    const first = await executeTool("workers", { action: "list" });
    expect(first.content[0].text).toContain("drop");

    // A reload (or another writer of this session) replays the branch with
    // the marker: the cached record must be dropped, not just shadowed.
    branch = [branchEntry(record), removedEntry("w-drop")];
    const second = await executeTool("workers", { action: "list" });
    expect(second.content[0].text).toContain("No workers yet");
  });

  it("removing an orphan deletes its artifacts but refuses another live session's worker", async () => {
    // An orphan's owner is gone; a foreign worker still has a live owner.
    // Neither is governed by this session's transcript, so no marker here.
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
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-foreign",
        name: "foreign",
        parentPid: process.pid,
        status: "failed",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    await executeTool("workers", { action: "remove", id: "w-orphan" });
    await expect(executeTool("workers", { action: "remove", id: "w-foreign" })).rejects.toThrow(
      /another live session/,
    );

    expect(await loadWorker(cwd, "w-orphan")).toBeUndefined();
    expect(await loadWorker(cwd, "w-foreign")).toBeDefined();
    const markerCalls = mockPi.appendEntry.mock.calls.filter(
      (call) => call[0] === WORKER_REMOVED_ENTRY,
    );
    expect(markerCalls).toHaveLength(0);
  });

  it("workers remove clears an old ghost with a transcript entry but no artifact file", async () => {
    await initGitRepo(cwd);
    const record = makeWorkerRecord({
      id: "w-ghost",
      name: "ghost",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    // The record file was pruned or lost; the transcript entry alone kept
    // resurrecting this worker on every reload. No disk artifacts exist.
    let branch: unknown[] = [branchEntry(record)];
    mockCtx.sessionManager.getBranch = vi.fn(() => branch);

    const removed = await executeTool("workers", { action: "remove", id: "w-ghost" });
    expect(removed.content[0].text).toContain("removed");
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      WORKER_REMOVED_ENTRY,
      expect.objectContaining({ id: "w-ghost" }),
    );

    branch = [branchEntry(record), removedEntry("w-ghost")];
    await expect(executeTool("workers", { action: "status", id: "w-ghost" })).rejects.toThrow(
      /Unknown worker/,
    );
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

  describe("provision integration", () => {
    beforeEach(() => {
      vi.mocked(runGit).mockClear();
      vi.mocked(runSetupHook).mockClear();
    });

    afterEach(() => {
      // Restore the call-through git spy so non-provision tests keep real git.
      vi.mocked(runGit).mockRestore();
    });

    it("provision preflight refuses before any slot is reserved", async () => {
      vi.mocked(runGit).mockImplementation(async (_repoCwd, args) =>
        args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" ? "true\n" : "",
      );
      const state: WorkerSessionState = {
        running: new Map(),
        branchWorkers: new Map(),
        reserved: new Map(),
      };
      const persist = vi.fn(async () => true);
      const plan = await planDelegate({ task: "isolated task" }, mockCtx);

      await expect(
        startDelegatedWorker({ cwd, plan, state, events: testEvents(), persist }),
      ).rejects.toThrow(/provisioned: none \(setup hook missing or not executable/);

      expect(state.reserved.size).toBe(0);
      expect(state.running.size).toBe(0);
      expect(persist).not.toHaveBeenCalled();
      expect(vi.mocked(runGit).mock.calls.some((call) => call[1][0] === "worktree")).toBe(false);
    });

    it("an isolated spawn without a setup hook refuses and burns nothing", async () => {
      fakeWorktreeGit();

      const error = await executeTool("spawn_worker", { task: "isolated task" }).then(
        () => null,
        (e: Error) => e,
      );

      expect(error?.message).toContain("provisioned: none (setup hook missing or not executable");
      expect(error?.message).toContain(join(CONFIG_DIR_NAME, "provision-worktree"));
      expect(error?.message).toContain(join(CONFIG_DIR_NAME, "sandbox.json"));
      expect((await listRecordFiles(cwd)).length).toBe(0);
      expect(existsSync(join(cwd, CONFIG_DIR_NAME, "worktrees"))).toBe(false);
    });

    it("a missing sandbox policy refuses before any slot, worktree, or record exists", async () => {
      vi.mocked(runGit).mockImplementation(async (_repoCwd, args) =>
        args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" ? "true\n" : "",
      );
      await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(
        join(cwd, CONFIG_DIR_NAME, "provision-worktree"),
        "#!/bin/sh\nexit 0\n",
        "utf8",
      );
      await chmod(join(cwd, CONFIG_DIR_NAME, "provision-worktree"), 0o755);

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: none \(sandbox policy missing/,
      );
      expect((await listRecordFiles(cwd)).length).toBe(0);
    });

    it("a modified tracked setup file is path-committed and removed from the dirty gate", async () => {
      await writeProvisionConfig(cwd);
      await initGitRepo(cwd);
      await writeFile(
        join(cwd, CONFIG_DIR_NAME, "provision-worktree"),
        "#!/bin/sh\necho v2\n",
        "utf8",
      );
      await chmod(join(cwd, CONFIG_DIR_NAME, "provision-worktree"), 0o755);
      const fixture = await writeFixture(fixtureDir, "v2-worker.sh", SUCCESS_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
      expect(started.details.worker.status).toBe("completed");

      const status = await execFileAsync(
        "git",
        ["status", "--porcelain", "--", join(CONFIG_DIR_NAME, "provision-worktree")],
        gitOpts(cwd),
      );
      expect(status.stdout.trim()).toBe("");
      const head = await execFileAsync(
        "git",
        ["show", `HEAD:${join(CONFIG_DIR_NAME, "provision-worktree")}`],
        gitOpts(cwd),
      );
      expect(head.stdout).toContain("v2");
    });

    it("a failed provision persists the record with its worktree and spawns nothing", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      vi.mocked(runSetupHook).mockResolvedValueOnce({
        exitCode: 1,
        detail: "setup failed",
        ms: 2_000,
        logPath: join(cwd, ".hook.log"),
      });
      const spawnMarker = join(fixtureDir, "spawn-marker");
      setEnv(
        "PI_WORKER_COMMAND",
        await writeFixture(
          fixtureDir,
          "spawn-marker.sh",
          `#!/bin/sh\ntouch '${spawnMarker}'\nexit 0\n`,
        ),
      );

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: failed \(exit 1\): setup failed\. Log: .+\. Fix \.pi\/provision-worktree or the environment, then re-run spawn_worker./,
      );

      const records = await listRecordFiles(cwd);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.status).toBe("failed");
      const wt = recordWorktree(record);
      expect(wt).toBe(join(cwd, CONFIG_DIR_NAME, "worktrees", record.id));
      expect(record.branch).toBe(`workers/${record.id}`);
      expect(existsSync(wt)).toBe(true); // kept: remove/prune owns discarding it
      expect(record.provision).toMatchObject({ state: "failed" });
      expect(existsSync(spawnMarker)).toBe(false); // nothing spawned

      const removed = await executeTool("workers", { action: "remove", id: record.id });
      expect(removed.content[0].text).toContain("Worktree and branch discarded");
      expect(existsSync(wt)).toBe(false);
      expect(await loadWorker(cwd, record.id)).toBeUndefined();
    });

    it("sandbox initialization failure refuses delegation without spawning an unsandboxed worker", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      vi.mocked(runSetupHook).mockRejectedValueOnce(
        new Error("Sandbox dependencies not available: socat not installed"),
      );
      const spawnMarker = join(fixtureDir, "unsandboxed-spawn-marker");
      setEnv(
        "PI_WORKER_COMMAND",
        await writeFixture(
          fixtureDir,
          "unsandboxed-spawn-marker.sh",
          `#!/bin/sh\ntouch '${spawnMarker}'\nexit 0\n`,
        ),
      );

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: failed \(Sandbox dependencies not available: socat not installed\)/,
      );
      const records = await listRecordFiles(cwd);
      expect(records).toHaveLength(1);
      expect(records[0].provision?.state).toBe("failed");
      expect(existsSync(spawnMarker)).toBe(false);
    });

    it("an empty-output hook failure points at the setup hook and log", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      vi.mocked(runSetupHook).mockResolvedValueOnce({
        exitCode: 137,
        detail: "",
        ms: 90_000,
        logPath: join(fixtureDir, "hook.log"),
      });

      const error = await executeTool("spawn_worker", { task: "isolated task" }).then(
        () => null,
        (e: Error) => e,
      );

      expect(error?.message).toEqual(
        expect.stringContaining("provisioned: failed (exit 137). Log: "),
      );
      expect(error?.message).toEqual(
        expect.stringContaining(join(CONFIG_DIR_NAME, "provision-worktree")),
      );
    });

    it("an empty detail never leaves a stray colon in the failure pointer", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      vi.mocked(runSetupHook).mockResolvedValueOnce({
        exitCode: 9,
        detail: "",
        ms: 1_000,
        logPath: join(fixtureDir, "hook.log"),
      });

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: failed \(exit 9\)\. Log: .+\. Fix /,
      );
    });

    it("preflight commits a modified tracked setup file before the worktree is created", async () => {
      await writeProvisionConfig(cwd);
      await initGitRepo(cwd);
      await writeFile(
        join(cwd, CONFIG_DIR_NAME, "sandbox.json"),
        `${JSON.stringify({ network: { allowedDomains: ["example.com"], deniedDomains: [] }, filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] } }, null, 2)}\n`,
      );
      const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
      setEnv("PI_WORKER_COMMAND", fixture);

      const started = await executeTool("spawn_worker", { task: "t", isolate: true, wait: true });
      expect(started.details.worker.status).toBe("completed");

      const status = await execFileAsync(
        "git",
        ["status", "--porcelain", "--", join(CONFIG_DIR_NAME, "sandbox.json")],
        gitOpts(cwd),
      );
      expect(status.stdout.trim()).toBe("");
      const head = await execFileAsync(
        "git",
        ["show", `HEAD:${join(CONFIG_DIR_NAME, "sandbox.json")}`],
        gitOpts(cwd),
      );
      expect(head.stdout).toContain("example.com");
    });

    it("prune discards a failed provision record's worktree past retention", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      vi.mocked(runSetupHook).mockResolvedValueOnce({
        exitCode: 1,
        detail: "boom",
        ms: 1_000,
        logPath: join(fixtureDir, "hook.log"),
      });

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: failed \(exit 1\)/,
      );

      const record = (await listRecordFiles(cwd))[0];
      const wt = recordWorktree(record);
      expect(existsSync(wt)).toBe(true);

      const pruned = await pruneWorkerArtifacts(cwd, Date.now() + WORKER_RETENTION_MS + 60_000);
      expect(pruned).toEqual([record.id]);
      expect(existsSync(wt)).toBe(false);
      expect(await loadWorker(cwd, record.id)).toBeUndefined();
    });

    it("an exhausted provision lock refuses busy and discards the fresh worktree", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      // Simulate the lock wait running out (real bound: budget + grace).
      vi.mocked(withFileLock).mockImplementationOnce(
        async (
          _lockPath: string,
          _fn: () => Promise<unknown>,
          options?: { timeoutMessage?: string },
        ) => {
          throw new Error(options?.timeoutMessage ?? "lock timeout");
        },
      );

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        "provisioned: busy (another provision is running); retry shortly.",
      );

      const records = await listRecordFiles(cwd);
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("failed");
      expect(records[0].worktree).toBeUndefined(); // discarded: no orphan
      expect(vi.mocked(runSetupHook)).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, CONFIG_DIR_NAME, "worktrees", records[0].id))).toBe(false);
    });

    it("a dirty-tree refusal before spawn leaves no record, slot, or worktree", async () => {
      await initGitRepo(cwd);
      await writeProvisionConfig(cwd);
      // Dirty outside the config dir: preflight passes, createWorktree refuses.
      await writeFile(join(cwd, "scratch.ts"), "export {};\n");
      const spawnMarker = join(fixtureDir, "dirty-spawn-marker");
      setEnv(
        "PI_WORKER_COMMAND",
        await writeFixture(
          fixtureDir,
          "dirty-spawn-marker.sh",
          `#!/bin/sh\ntouch '${spawnMarker}'\n${SUCCESS_WORKER}`,
        ),
      );
      setEnv("PI_MAX_WORKERS", "1");

      const refusal = executeTool("spawn_worker", { task: "isolated task" });
      await expect(refusal).rejects.toThrow(/dirty tree/);
      // The refusal names the blocker, so the parent needs no extra
      // diagnostic status call to find it.
      await expect(refusal).rejects.toThrow(/scratch\.ts/);

      // The spawn was refused before anything existed: no phantom failed
      // record (disk or transcript), no worktree, nothing spawned.
      expect(await listRecordFiles(cwd)).toHaveLength(0);
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, CONFIG_DIR_NAME, "worktrees"))).toBe(false);
      expect(existsSync(spawnMarker)).toBe(false);

      // The slot was released: a next spawn works at the cap of 1.
      const next = await executeTool("spawn_worker", {
        task: "follow-up",
        isolate: false,
        wait: true,
      });
      expect((next.details.worker as WorkerRecord).status).toBe("completed");
    });

    it("a failed setup commit refuses the spawn before any slot, worktree, or record exists", async () => {
      fakeWorktreeGit({ commitError: "pre-commit hook declined" });
      await writeProvisionConfig(cwd);

      await expect(executeTool("spawn_worker", { task: "isolated task" })).rejects.toThrow(
        /provisioned: setup commit failed \(pre-commit hook declined\)\. Commit /,
      );

      // Review D2 pre-gate position: the commit runs in preflight, before
      // the reservation — a refusal here creates nothing at all.
      expect(await listRecordFiles(cwd)).toHaveLength(0);
      expect(existsSync(join(cwd, CONFIG_DIR_NAME, "worktrees"))).toBe(false);
    });

    it("a non-isolated spawn skips provisioning and never runs the hook", async () => {
      await writeProvisionConfig(cwd);
      const argsFile = join(fixtureDir, "skipped-args.txt");
      const rootFile = join(fixtureDir, "skipped-messenger-root.txt");
      const fixture = await writeFixture(
        fixtureDir,
        "skipped-worker.sh",
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' "$PI_MESSENGER_PROJECT_ROOT" > '${rootFile}'\n${SUCCESS_WORKER}`,
      );
      setEnv("PI_WORKER_COMMAND", fixture);

      const result = await executeTool("spawn_worker", {
        task: "say hi",
        isolate: false,
        wait: true,
      });

      expect(vi.mocked(runSetupHook)).not.toHaveBeenCalled();
      const worker = result.details.worker as WorkerRecord;
      expect(worker.status).toBe("completed");
      expect(worker.provision).toMatchObject({ state: "skipped", detail: "no worktree" });
      expect(result.content[0].text).toContain("Provision: skipped — no worktree");
      const args = (await readFile(argsFile, "utf8")).split("\n");
      const environment = args.find((line) => line.startsWith("ENVIRONMENT:"));
      expect(environment).toContain("Provision: skipped — no worktree");
      expect(environment).toContain("call report_blocker with the exact missing tool");
      expect(await readFile(rootFile, "utf8")).toBe(cwd);
    });

    it("an isolated spawn carries the include paths, runs the setup hook, and commits setup files", async () => {
      fakeWorktreeGit();
      await writeProvisionConfig(cwd);
      await mkdir(join(cwd, "data"), { recursive: true });
      await writeFile(join(cwd, "data", "config.json"), "{}\n");
      await writeFile(join(cwd, ".worktreeinclude"), "data/\n");
      const argsFile = join(fixtureDir, "happy-args.txt");
      const rootFile = join(fixtureDir, "happy-messenger-root.txt");
      const fixture = await writeFixture(
        fixtureDir,
        "happy-worker.sh",
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' "$PI_MESSENGER_PROJECT_ROOT" > '${rootFile}'\n${SUCCESS_WORKER}`,
      );
      setEnv("PI_WORKER_COMMAND", fixture);
      setEnv("PI_MESSENGER_PROJECT_ROOT", join(fixtureDir, "stale-root"));
      vi.mocked(runSetupHook).mockResolvedValueOnce({
        exitCode: 0,
        detail: "setup done",
        ms: 16_000,
        logPath: join(fixtureDir, "hook.log"),
      });

      const started = await executeTool("spawn_worker", { task: "build the widget" });

      const id = started.details.workerId as string;
      const wt = join(cwd, CONFIG_DIR_NAME, "worktrees", id);
      expect(await readFile(join(wt, "data", "config.json"), "utf8")).toBe("{}\n");
      expect(vi.mocked(runSetupHook)).toHaveBeenCalledWith(wt, 600_000, undefined);
      const gitCalls = vi.mocked(runGit).mock.calls.map((call) => call[1].join(" "));
      expect(
        gitCalls.some((entry) =>
          entry.includes(`add -- ${join(CONFIG_DIR_NAME, "provision-worktree")}`),
        ),
      ).toBe(true);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("committed"), "info");
      expect(started.details.provision).toMatchObject({
        state: "yes",
        detail: "carry 1, hook exit 0 (16s), setup committed",
      });
      expect(started.content[0].text).toContain("Provision: yes — carry 1, hook exit 0 (16s)");
      // The child writes its argv and root files before it exits; wait for
      // the completed record so the reads cannot race the spawned process.
      const record = await waitForRecord(cwd, id, "completed");
      expect(record.provision).toMatchObject({ state: "yes" });
      const args = (await readFile(argsFile, "utf8")).split("\n");
      const environment = args.find((line) => line.startsWith("ENVIRONMENT:"));
      expect(environment).toContain("Provision: yes — carry 1, hook exit 0 (16s)");
      expect(await readFile(rootFile, "utf8")).toBe(cwd);
    });

    describe("abort during delegation", () => {
      /** Blocked-hook mock: parks until the external signal aborts, then
       *  rejects with SetupHookCancelled exactly like the real hook. */
      function blockHookOnAbort(): {
        blocked: Promise<void>;
        hookedSignal: AbortSignal | undefined;
      } {
        let hookedSignal: AbortSignal | undefined;
        let start: () => void = () => {};
        const blocked = new Promise<void>((resolve) => {
          start = resolve;
        });
        vi.mocked(runSetupHook).mockImplementationOnce(
          async (_worktree: string, _timeoutMs: number, signal?: AbortSignal) => {
            hookedSignal = signal;
            start();
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new SetupHookCancelled("test abort")),
                { once: true },
              );
            });
          },
        );
        return {
          blocked,
          get hookedSignal() {
            return hookedSignal;
          },
        };
      }

      it("an already-aborted signal refuses the spawn before any preparation or spawn", async () => {
        const spawnMarker = join(fixtureDir, "aborted-refusal-marker");
        setEnv(
          "PI_WORKER_COMMAND",
          await writeFixture(
            fixtureDir,
            "aborted-refusal-marker.sh",
            `#!/bin/sh\ntouch '${spawnMarker}'\nexit 0\n`,
          ),
        );
        const controller = new AbortController();
        controller.abort();

        await expect(
          executeTool("spawn_worker", { task: "t", isolate: false, wait: true }, controller.signal),
        ).rejects.toThrow(/abort/i);

        expect(existsSync(spawnMarker)).toBe(false); // refused before spawn
        expect(await listRecordFiles(cwd)).toHaveLength(0); // nothing recorded
        expect(mockPi.appendEntry).not.toHaveBeenCalled();
      });

      it("aborting a wait=true spawn during a blocked setup hook starts no worker, frees the slot, and leaves nothing behind", async () => {
        fakeWorktreeGit();
        await writeProvisionConfig(cwd);
        const spawnMarker = join(fixtureDir, "abort-hook-spawn-marker");
        setEnv(
          "PI_WORKER_COMMAND",
          await writeFixture(
            fixtureDir,
            "abort-hook-spawn-marker.sh",
            `#!/bin/sh\ntouch '${spawnMarker}'\nexit 0\n`,
          ),
        );
        setEnv("PI_MAX_WORKERS", "1");
        const hook = blockHookOnAbort();

        const controller = new AbortController();
        const pending = executeTool(
          "spawn_worker",
          { task: "isolated task", wait: true },
          controller.signal,
        );
        await hook.blocked; // the hook is now parked inside provisioning
        // The tool's signal reaches the setup hook as its external signal.
        expect(vi.mocked(runSetupHook)).toHaveBeenCalledWith(
          expect.any(String),
          600_000,
          controller.signal,
        );
        controller.abort();

        await expect(pending).rejects.toThrow(SetupHookCancelled);

        expect(hook.hookedSignal?.aborted).toBe(true); // the hook cancelled on it
        expect(existsSync(spawnMarker)).toBe(false); // the child never started
        expect(await listRecordFiles(cwd)).toHaveLength(0); // no failed record
        expect(mockPi.appendEntry).not.toHaveBeenCalled(); // nothing persisted
        // The fresh worktree was removed: the worktrees dir holds nothing.
        const worktrees = join(cwd, CONFIG_DIR_NAME, "worktrees");
        const leftover = existsSync(worktrees) ? await readdir(worktrees) : [];
        expect(leftover.filter((entry) => !entry.endsWith(".git"))).toEqual([]);

        // The reservation was freed: the next spawn fits at the cap of 1.
        setEnv(
          "PI_WORKER_COMMAND",
          await writeFixture(fixtureDir, "after-abort.sh", SUCCESS_WORKER),
        );
        const next = await executeTool("spawn_worker", {
          task: "follow-up",
          isolate: false,
          wait: true,
        });
        expect((next.details.worker as WorkerRecord).status).toBe("completed");
      });

      it("an abort during a blocked setup hook removes the worktree and persists nothing", async () => {
        fakeWorktreeGit();
        await writeProvisionConfig(cwd);
        const { blocked } = blockHookOnAbort();
        const state: WorkerSessionState = {
          running: new Map(),
          branchWorkers: new Map(),
          reserved: new Map(),
        };
        const persist = vi.fn(async () => true);
        const plan = await planDelegate({ task: "isolated task" }, mockCtx);

        const controller = new AbortController();
        const pending = startDelegatedWorker({
          cwd,
          plan,
          state,
          events: testEvents(),
          persist,
          signal: controller.signal,
        });
        await blocked; // the hook is now parked inside provisioning
        controller.abort();

        await expect(pending).rejects.toThrow(SetupHookCancelled);
        expect(state.reserved.size).toBe(0); // the slot was released
        expect(persist).not.toHaveBeenCalled(); // nothing was recorded
        // The fresh worktree was removed: the worktrees dir holds nothing.
        const worktrees = join(cwd, CONFIG_DIR_NAME, "worktrees");
        expect(existsSync(join(worktrees, plan.workerId))).toBe(false);
      });

      it("keeps a recoverable record if a cancelled worktree cannot be removed", async () => {
        fakeWorktreeGit();
        await writeProvisionConfig(cwd);
        const git = vi.mocked(runGit).getMockImplementation();
        if (!git) throw new Error("fake git was not installed");
        vi.mocked(runGit).mockImplementation(async (repo, args, options) => {
          if (args[0] === "worktree" && args[1] === "remove") throw new Error("busy worktree");
          return git(repo, args, options);
        });
        const hook = blockHookOnAbort();
        const state: WorkerSessionState = {
          running: new Map(),
          branchWorkers: new Map(),
          reserved: new Map(),
        };
        const persist = vi.fn(async (record: WorkerRecord) => {
          await writeRecordFile(cwd, record);
          return true;
        });
        const plan = await planDelegate({ task: "isolated task" }, mockCtx);
        const controller = new AbortController();
        const pending = startDelegatedWorker({
          cwd,
          plan,
          state,
          events: testEvents(),
          persist,
          signal: controller.signal,
        });
        await hook.blocked;
        controller.abort();

        await expect(pending).rejects.toThrow(/worktree cleanup failed/);
        expect(state.reserved.size).toBe(0);
        expect(await loadWorker(cwd, plan.workerId)).toMatchObject({
          status: "failed",
          worktree: join(cwd, CONFIG_DIR_NAME, "worktrees", plan.workerId),
        });
      });

      it("an abort after the child starts but before the wait listener still cancels the worker immediately", async () => {
        const fixture = await writeFixture(fixtureDir, "wait-gap-worker.sh", SLOW_WORKER);
        setEnv("PI_WORKER_COMMAND", fixture);

        // Gate on the first appendEntry: the running-record persist happens
        // strictly after the child spawned and strictly before the tool
        // attaches its wait listener, so aborting from the gate lands inside
        // the attach gap. The mock never returns (its promise is discarded)
        // and the next appendEntry call (the terminal save) uses the default.
        let releaseGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        mockPi.appendEntry.mockImplementationOnce(() => {
          releaseGate();
          return new Promise<void>(() => {});
        });

        const controller = new AbortController();
        const pending = executeTool(
          "spawn_worker",
          { task: "long task", isolate: false, wait: true },
          controller.signal,
        );
        await gate; // the child is live; the listener is not attached yet
        controller.abort();

        const result = await pending;
        const record = result.details.worker as WorkerRecord;
        expect(record.status).toBe("cancelled");
        // The child process is gone right after the response settles.
        const pidDeadline = Date.now() + 5_000;
        while (record.pid !== undefined && isProcessAlive(record.pid)) {
          if (Date.now() > pidDeadline) throw new Error("worker child was not killed");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await waitForRecord(cwd, record.id, "cancelled").then((r) => r.status)).toBe(
          "cancelled",
        );
        // A cancellation never wakes the parent.
        const wakeCall = mockPi.sendMessage.mock.calls.find(
          ([message]) => (message as WakeMessageShape).customType === "workers:wake",
        );
        expect(wakeCall).toBeUndefined();
      });
    });
  });
});

describe("workers-units", () => {
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

  it("extractAssistantSettlement returns an assistant message's stop reason and error detail", () => {
    expect(extractAssistantSettlement("not json")).toBeUndefined();
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"user","content":"hi","stopReason":"length"}}',
      ),
    ).toBeUndefined();
    // No stopReason field (older records): the settlement stays unknown.
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
      ),
    ).toBeUndefined();
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"truncated"}],"stopReason":"length"}}',
      ),
    ).toEqual({ stopReason: "length" });
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}',
      ),
    ).toEqual({ stopReason: "stop" });
    // A provider error carries its detail; a blank one is omitted.
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Request failed: 503"}}',
      ),
    ).toEqual({ stopReason: "error", errorMessage: "Request failed: 503" });
    expect(
      extractAssistantSettlement(
        '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"   "}}',
      ),
    ).toEqual({ stopReason: "error" });
  });

  it("extractAssistantOwnText returns only an assistant message's own text", () => {
    expect(extractAssistantOwnText("not json")).toBeUndefined();
    expect(
      extractAssistantOwnText('{"type":"message_end","message":{"role":"user","content":"hi"}}'),
    ).toBeUndefined();
    expect(
      extractAssistantOwnText(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
      ),
    ).toBe("first");
    // A message with no text block has empty own text (not undefined).
    expect(
      extractAssistantOwnText(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"h"}]}}',
      ),
    ).toBe("");
  });

  it("assistantTextFromContent joins text blocks and ignores other content", () => {
    expect(
      assistantTextFromContent([
        { type: "text", text: "half " },
        { type: "text", text: "done" },
      ]),
    ).toBe("half done");
    expect(assistantTextFromContent([{ type: "thinking", thinking: "h" }])).toBe("");
    expect(assistantTextFromContent("a plain string")).toBe("");
  });

  it("formatRawStreamEntries renders the joined assistant text", () => {
    const lines = [
      '{"type":"workers_start","task":"do it"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"half "},{"type":"text","text":"done"}]}}',
    ];
    expect(formatRawStreamEntries(lines)).toEqual(["▷ started do it", "✎ half done"]);
  });

  it("abortReason prefers the signal reason and uses the caller's fallback", () => {
    const aborted = (reason: unknown) => {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    };
    expect(abortReason(aborted("stop it"), "fallback")).toBe("stop it");
    expect(abortReason(aborted(new Error("boom")), "fallback")).toBe("boom");
    // abort(null) leaves a reason with no usable text; only an absent signal
    // or an unusable reason reaches the caller's fallback.
    expect(abortReason(aborted(null), "fallback")).toBe("fallback");
    expect(abortReason(undefined, "fallback")).toBe("fallback");
  });

  it("resolveWorkerExtensions defaults extensionsRoot to the repository extensions directory", () => {
    const messenger = resolveWorkerExtensions(["messenger"]).find(
      (extension) => extension.name === "messenger",
    );
    expect(messenger?.path).toContain(join("extensions", "messenger", "messenger.ts"));
  });

  it("ingestStreamEvent records blocker markers on the record", () => {
    const record = makeWorkerRecord();

    expect(
      ingestStreamEvent('{"type":"workers_blocker","at":5,"reason":"a real blocker"}', record),
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
    ingestStreamEvent('{"type":"workers_blocker","at":6,"reason":"line1\\nline2"}', record);
    expect(record.blocker).toEqual({ reason: "line1 line2", at: 6 });
    ingestStreamEvent('{"type":"workers_blocker","at":7,"reason":"the final answer"}', record);
    expect(record.blocker).toEqual({ reason: "the final answer", at: 7 });
  });

  it("isGitRepo detects git and non-git directories", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "workers-git-"));
    const plainDir = await mkdtemp(join(tmpdir(), "workers-plain-"));
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
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-"));
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

  it("captureWorktreePatch removes orphaned setup cache before staging worker changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-orphan-cache-"));
    try {
      await initGitRepo(repo);
      // The tracked hook lives beside the scratch paths it may leave behind;
      // the sweep must never mistake it for scratch.
      const hook = join(repo, CONFIG_DIR_NAME, "provision-worktree");
      await mkdir(join(repo, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(hook, "#!/bin/sh\nexit 0\n");
      await execFileAsync("git", ["add", "."], gitOpts(repo));
      await execFileAsync("git", ["commit", "-qm", "setup files"], gitOpts(repo));
      const wt = await createWorktree(repo, "w-orphan-cache");
      const scratch = join(wt.path, CONFIG_DIR_NAME, "provision-tmp-Ab12Cd34");
      await mkdir(join(scratch, "npm-cache"), { recursive: true });
      await writeFile(join(scratch, "npm-cache", "blob"), "cached package\n");
      const scratchFile = join(wt.path, CONFIG_DIR_NAME, "provision-tmp-Ef56Gh78");
      await writeFile(scratchFile, "temporary credentials\n");
      const outside = join(repo, "outside.txt");
      await writeFile(outside, "outside content\n");
      const scratchLink = join(wt.path, CONFIG_DIR_NAME, "provision-tmp-Ij90Kl12");
      await symlink(outside, scratchLink);
      await writeFile(join(wt.path, "result.txt"), "worker output\n");

      const patchPath = join(repo, "orphan.patch.diff");
      await captureWorktreePatch(wt.path, patchPath);
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain("result.txt");
      expect(patch).not.toContain("provision-tmp-Ab12Cd34");
      expect(patch).not.toContain("provision-tmp-Ef56Gh78");
      expect(patch).not.toContain("provision-tmp-Ij90Kl12");
      expect(patch).not.toContain("provision-worktree");
      expect(patch).not.toContain("temporary credentials");
      await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(scratchFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(scratchLink)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(wt.path, CONFIG_DIR_NAME, "provision-worktree"), "utf8")).toBe(
        "#!/bin/sh\nexit 0\n",
      );
      expect(await readFile(outside, "utf8")).toBe("outside content\n");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("captureWorktreePatch captures committed and uncommitted changes since the worktree base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-committed-"));
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

  it("captureWorktreePatch excludes ignored worker cache artifacts but keeps source and tracked config changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-cache-"));
    try {
      await initGitRepo(repo);
      // The project's ignore policy declares worker cache directories, and a
      // tracked config file exists before the worker branches.
      await writeFile(join(repo, ".gitignore"), ".npm-cache/\n");
      await mkdir(join(repo, "config"), { recursive: true });
      await writeFile(join(repo, "config", "app.json"), '{"name": "base"}\n');
      await execFileAsync("git", ["add", "."], gitOpts(repo));
      await execFileAsync(
        "git",
        ["commit", "-qm", "ignore policy and tracked config"],
        gitOpts(repo),
      );

      const wt = await createWorktree(repo, "w-cache");
      // The worker populates a package cache inside the worktree...
      const cacheBlob = join(wt.path, ".npm-cache", "_cacache", "index-v5", "ab");
      await mkdir(cacheBlob, { recursive: true });
      await writeFile(join(cacheBlob, "cd"), Buffer.from([0x00, 0x01, 0xff, 0xfe]));
      // ...populates its own runtime state in the config dir...
      await mkdir(join(wt.path, CONFIG_DIR_NAME, "messenger", "inbox"), { recursive: true });
      await writeFile(join(wt.path, CONFIG_DIR_NAME, "messenger", "inbox", "peer.jsonl"), "{}\n");
      // ...edits tracked source and tracked config...
      await writeFile(join(wt.path, "README.md"), "# worker edit\n");
      await writeFile(join(wt.path, "config", "app.json"), '{"name": "worker"}\n');
      // ...and adds a new source file.
      await mkdir(join(wt.path, "src"), { recursive: true });
      await writeFile(join(wt.path, "src", "feature.ts"), "export const feature = true;\n");

      const patchPath = join(repo, CONFIG_DIR_NAME, "workers", "patches", "w-cache.diff");
      await captureWorktreePatch(wt.path, patchPath);
      const patch = await readFile(patchPath, "utf8");
      expect(patch).not.toContain(".npm-cache");
      expect(patch).not.toContain("_cacache");
      expect(patch).not.toContain(CONFIG_DIR_NAME);
      expect(patch).toContain("README.md");
      expect(patch).toContain("config/app.json");
      expect(patch).toContain("src/feature.ts");

      // The patch applies cleanly and leaves the cache untouched in the
      // worktree rather than deleting it.
      await applyPatch(repo, patchPath);
      expect(await readFile(join(repo, "config", "app.json"), "utf8")).toBe('{"name": "worker"}\n');
      expect(await readFile(join(repo, "src", "feature.ts"), "utf8")).toBe(
        "export const feature = true;\n",
      );
      expect(existsSync(join(cacheBlob, "cd"))).toBe(true);
      expect(existsSync(join(wt.path, CONFIG_DIR_NAME, "messenger", "inbox", "peer.jsonl"))).toBe(
        true,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("captureWorktreePatch stores binary changes as applicable binary patches", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-binary-"));
    try {
      await initGitRepo(repo);
      const wt = await createWorktree(repo, "w-binary");
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x00]);
      await mkdir(join(wt.path, "assets"), { recursive: true });
      await writeFile(join(wt.path, "assets", "logo.bin"), bytes);

      const patchPath = join(repo, "binary.patch.diff");
      await captureWorktreePatch(wt.path, patchPath);
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain("GIT binary patch");

      await applyPatch(repo, patchPath);
      expect(await readFile(join(repo, "assets", "logo.bin"))).toEqual(bytes);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("captureWorktreePatch refuses an unapplicable patch without storing it and keeps the worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-wt-refuse-"));
    try {
      await initGitRepo(repo);
      const wt = await createWorktree(repo, "w-drift");
      // The parent tree drifts after the worker branched (uncommitted is
      // enough: `git apply --check` tests against the working tree)...
      await writeFile(join(repo, "README.md"), "# parent drifted\n");
      // ...and the worker edits the same file.
      await writeFile(join(wt.path, "README.md"), "# worker edit\n");

      const patchesDir = join(repo, CONFIG_DIR_NAME, "workers", "patches");
      const patchPath = join(patchesDir, "w-drift.diff");
      await expect(captureWorktreePatch(wt.path, patchPath)).rejects.toThrow(/refusing/i);

      // Nothing is stored — neither the patch nor a validation leftover.
      await expect(stat(patchPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${patchPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
      // The worktree survives with the worker's changes for manual recovery.
      expect(existsSync(wt.path)).toBe(true);
      expect(await readFile(join(wt.path, "README.md"), "utf8")).toBe("# worker edit\n");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree refuses a dirty tree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-"));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, "README.md"), "# changed\n");
      await expect(createWorktree(repo, "w-dirty")).rejects.toThrow(/dirty tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree names the blocking paths in the dirty-tree refusal", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-named-"));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, "README.md"), "# changed\n");
      await writeFile(join(repo, "src notes.md"), "export {};\n");

      const failure = await createWorktree(repo, "w-named").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DirtyWorktreeError);
      const message = (failure as Error).message;
      expect(message).toContain("README.md");
      expect(message).toContain("src notes.md");
      // The actionable guidance stays: commit or stash before delegating.
      expect(message).toContain("Commit or stash first");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree names at most five blocking paths and counts the rest", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-many-"));
    try {
      await initGitRepo(repo);
      for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
        await writeFile(join(repo, `blocked-${name}.ts`), "export {};\n");
      }

      const failure = await createWorktree(repo, "w-many").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DirtyWorktreeError);
      const message = (failure as Error).message;
      // Git sorts porcelain output: the first five names appear, the rest
      // collapse into a count.
      expect(message).toContain("blocked-a.ts");
      expect(message).toContain("blocked-e.ts (and 2 more)");
      expect(message).not.toContain("blocked-f.ts");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree names real blockers but never untracked config-dir state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-mixed-"));
    try {
      await initGitRepo(repo);
      // Messenger writes here in repos that do not gitignore the config dir.
      await mkdir(join(repo, CONFIG_DIR_NAME, "messenger", "inbox"), { recursive: true });
      await writeFile(join(repo, CONFIG_DIR_NAME, "messenger", "inbox", "peer.jsonl"), "{}\n");
      await writeFile(join(repo, "scratch.ts"), "export {};\n");

      const failure = await createWorktree(repo, "w-mixed").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DirtyWorktreeError);
      const message = (failure as Error).message;
      expect(message).toContain("scratch.ts");
      expect(message).not.toContain("peer.jsonl");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree ignores untracked config-dir state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-state-"));
    try {
      await initGitRepo(repo);
      // Messenger/missions/workers write here in repos that do not gitignore it.
      await mkdir(join(repo, CONFIG_DIR_NAME, "messenger", "inbox"), { recursive: true });
      await writeFile(join(repo, CONFIG_DIR_NAME, "messenger", "inbox", "peer.jsonl"), "{}\n");

      await expect(createWorktree(repo, "w-state")).resolves.toEqual({
        path: expect.stringContaining("w-state"),
        branch: "workers/w-state",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree still refuses untracked work files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-src-"));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, "scratch.ts"), "export {};\n");
      await expect(createWorktree(repo, "w-src")).rejects.toThrow(/dirty tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("createWorktree refuses tracked modifications under the config dir", async () => {
    const repo = await mkdtemp(join(tmpdir(), "workers-dirty-tracked-"));
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

  it("killPidTree refuses non-positive and non-integer pids without signaling", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await killPidTree(0);
      await killPidTree(-1);
      await killPidTree(Number.NaN);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("killPidTree still signals a positive pid", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    sleeper.unref();
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        await killPidTree(sleeper.pid ?? 0);
        expect(killSpy).toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    } finally {
      if (sleeper.pid !== undefined) {
        try {
          process.kill(-sleeper.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe("worker store (session-scoped)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "workers-store-"));
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

  it("a removed finished worker stays absent on replay while kept history remains", () => {
    const removedWorker = makeWorkerRecord({
      id: "w-removed",
      name: "removed",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    });
    const kept = makeWorkerRecord({
      id: "w-kept",
      name: "kept",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    });

    const workers = loadWorkersFromBranch([
      branchEntry(removedWorker),
      branchEntry(kept),
      removedEntry("w-removed"),
    ]);

    expect(workers.has("w-removed")).toBe(false);
    expect(workers.get("w-kept")?.id).toBe("w-kept");
  });

  it("loadWorkersFromBranch applies worker-removed markers with last-wins semantics", () => {
    const completed = makeWorkerRecord({
      id: "w-a",
      name: "a",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    });

    // Marker after the record: the removal wins.
    expect(loadWorkersFromBranch([branchEntry(completed), removedEntry("w-a")]).size).toBe(0);

    // A record after the marker re-adds the id (last entry wins).
    const reAdded = loadWorkersFromBranch([removedEntry("w-a"), branchEntry(completed)]);
    expect(reAdded.get("w-a")?.status).toBe("completed");

    // Re-added, then removed again: absent.
    expect(
      loadWorkersFromBranch([removedEntry("w-a"), branchEntry(completed), removedEntry("w-a")])
        .size,
    ).toBe(0);

    // A marker only shadows its own id.
    const other = makeWorkerRecord({ id: "w-b", name: "b", status: "completed" });
    const scoped = loadWorkersFromBranch([
      branchEntry(completed),
      removedEntry("w-a"),
      branchEntry(other),
    ]);
    expect(scoped.has("w-a")).toBe(false);
    expect(scoped.get("w-b")?.id).toBe("w-b");

    // Corrupt markers (no id) are ignored.
    const withCorrupt = loadWorkersFromBranch([
      branchEntry(completed),
      { type: "custom", customType: WORKER_REMOVED_ENTRY, data: {} },
    ]);
    expect(withCorrupt.get("w-a")?.id).toBe("w-a");
  });

  it("persistWorkerRemoval deletes artifacts, appends the marker, and blocks later saves", async () => {
    const persistence = createWorkerPersistence();
    const appendEntry = vi.fn();
    await seedRecord(
      cwd,
      makeWorkerRecord({ id: "w-r", name: "r", status: "completed", startedAt: 1, endedAt: 2 }),
    );
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "streams"), { recursive: true });
    const streamFile = streamPath(cwd, "w-r");
    await writeFile(streamFile, "{}\n", "utf8");

    await persistence.persistWorkerRemoval(appendEntry, cwd, "w-r");

    expect(appendEntry).toHaveBeenCalledWith(
      WORKER_REMOVED_ENTRY,
      expect.objectContaining({ id: "w-r" }),
    );
    expect(await loadWorker(cwd, "w-r")).toBeUndefined();
    await expect(stat(streamFile)).rejects.toMatchObject({ code: "ENOENT" });

    // A terminal save arriving after the removal cannot re-add the worker:
    // no transcript entry, no artifact file.
    const lateSave = await persistence.persistWorkerRecord(
      appendEntry,
      cwd,
      makeWorkerRecord({ id: "w-r", name: "r", status: "completed", startedAt: 3, endedAt: 4 }),
    );
    expect(lateSave).toBe(false);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(await loadWorker(cwd, "w-r")).toBeUndefined();
  });

  it("a terminal save queued behind a removal in the same tick is refused", async () => {
    const persistence = createWorkerPersistence();
    const appendEntry = vi.fn();

    const removal = persistence.persistWorkerRemoval(appendEntry, cwd, "w-q");
    const save = persistence.persistWorkerRecord(
      appendEntry,
      cwd,
      makeWorkerRecord({ id: "w-q", name: "q", status: "completed" }),
    );
    await Promise.all([removal, save]);

    expect(await save).toBe(false);
    expect(appendEntry).toHaveBeenCalledTimes(1); // the marker only
    expect(await loadWorker(cwd, "w-q")).toBeUndefined();
  });

  it("persistence state is per-instance: one instance's removal does not block another's saves", async () => {
    const owner = createWorkerPersistence();
    const other = createWorkerPersistence();
    const appendOwner = vi.fn();
    const appendOther = vi.fn();

    await owner.persistWorkerRemoval(appendOwner, cwd, "w-shared");
    const saved = await other.persistWorkerRecord(
      appendOther,
      cwd,
      makeWorkerRecord({
        id: "w-shared",
        name: "shared",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
      }),
    );

    // The tombstone is scoped to the instance that removed the worker; a
    // second Pi instance (fresh extension instance, same project cwd) must
    // still persist its own records for that cwd.
    expect(saved).toBe(true);
    expect(appendOther).toHaveBeenCalledWith(
      WORKER_RECORD_ENTRY,
      expect.objectContaining({ id: "w-shared" }),
    );
  });

  it("loadWorker surfaces an unreadable record file instead of reporting it missing", async () => {
    // A directory at the record path makes readFile fail with EISDIR — not
    // a missing file. The read error must surface; returning undefined
    // would make a broken record indistinguishable from a removed one.
    await mkdir(recordPath(cwd, "w-bad"), { recursive: true });
    await expect(loadWorker(cwd, "w-bad")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("loadWorker surfaces EACCES on a permission-denied record file", async () => {
    if (process.getuid?.() === 0) return; // root reads past file modes; cannot simulate
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-denied",
        name: "denied",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
      }),
    );
    await chmod(recordPath(cwd, "w-denied"), 0o000);
    try {
      await expect(loadWorker(cwd, "w-denied")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(recordPath(cwd, "w-denied"), 0o644);
    }
  });

  it("listRecordFiles skips an unreadable record file with a logged error", async () => {
    // The janitor must keep classifying the readable records; the broken
    // one is announced, not silently dropped.
    await seedRecord(
      cwd,
      makeWorkerRecord({ id: "w-ok", name: "ok", status: "completed", startedAt: 1, endedAt: 2 }),
    );
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "records", "w-broken.json"), {
      recursive: true,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const records = await listRecordFiles(cwd);
      expect(records.map((record) => record.id)).toEqual(["w-ok"]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("w-broken"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("removeWorkerRecord clears a ghost with no artifact file but refuses a running record", async () => {
    // Transcript ownership is the caller's check: a missing artifact file
    // (pruned or lost) must not block removal.
    await expect(removeWorkerRecord(cwd, "w-absent")).resolves.toBeUndefined();

    await seedRecord(cwd, makeWorkerRecord({ id: "w-live", name: "live", pid: process.pid }));
    await expect(removeWorkerRecord(cwd, "w-live")).rejects.toThrow(/still running/);
    expect(await loadWorker(cwd, "w-live")).toBeDefined();
  });

  it("removeWorkerRecord deletes the paired stderr log with the spool", async () => {
    await seedRecord(
      cwd,
      makeWorkerRecord({ id: "w-gone", name: "gone", status: "completed", endedAt: Date.now() }),
    );
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(streams, { recursive: true });
    const spool = streamPath(cwd, "w-gone");
    const stderrLog = stderrLogPath(cwd, "w-gone");
    await writeFile(spool, '{"at":1}\n', "utf8");
    await writeFile(stderrLog, "startup noise\n", "utf8");

    await removeWorkerRecord(cwd, "w-gone");

    await expect(stat(spool)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stderrLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadWorker(cwd, "w-gone")).toBeUndefined();
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

  it("rejects invalid worker ids before constructing any artifact or worktree path", async () => {
    const paths = [recordPath, streamPath, stderrLogPath, patchPath, worktreePath];
    for (const id of [
      "w-decoy/../w-victim",
      "../w-victim",
      "w-victim\\other",
      "w-victim\n",
      "/w-victim",
    ]) {
      for (const path of paths) expect(() => path(cwd, id)).toThrow(/Invalid worker id/);
      expect(() => worktreeBranch(id)).toThrow(/Invalid worker id/);
      await expect(loadWorker(cwd, id)).rejects.toThrow(/Invalid worker id/);
    }
    expect(worktreePath(cwd, "w-valid-123")).toContain("w-valid-123");
  });

  it("does not load an artifact record with another worker's id", async () => {
    const path = recordPath(cwd, "w-requested");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(makeWorkerRecord({ id: "w-victim" })), "utf8");
    expect(await loadWorker(cwd, "w-requested")).toBeUndefined();
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

  it("sweepWorkerArtifacts classifies a recycled parent pid as an orphan", async () => {
    // The parent pid answers kill(0) — some other process owns it now — but
    // the recorded start time proves the original owner is gone. The record
    // must be adoptable, not pinned as a foreign live session.
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-recycled",
        name: "recycled",
        parentPid: process.pid,
        parentProcessStartedAt: "Mon Jan  2 03:04:05 2001",
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const sweep = await sweepWorkerArtifacts(cwd, new Set());
    expect(sweep.foreignLive).toHaveLength(0);
    expect(sweep.terminalOrphans.map((r) => r.id)).toEqual(["w-recycled"]);
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
    await expect(runGit(cwd, ["rev-parse", "--verify", "workers/w-old"])).rejects.toThrow();
    expect(await loadWorker(cwd, "w-live")).toBeDefined();
  });

  it("pruneWorkerArtifacts keeps a failed capture record while its worktree holds the changes", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-recovery");
    await writeFile(join(wt.path, "README.md"), "# worker changes\n", "utf8");
    const patchPath = join(cwd, CONFIG_DIR_NAME, "workers", "patches", "w-recovery.diff");
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-recovery",
        name: "recovery",
        status: "completed",
        worktree: wt.path,
        branch: wt.branch,
        patchPath,
        endedAt: Date.now() - WORKER_RETENTION_MS - 60_000,
      }),
    );

    const pruned = await pruneWorkerArtifacts(cwd);

    expect(pruned).not.toContain("w-recovery");
    expect(await loadWorker(cwd, "w-recovery")).toBeDefined();
    expect(await readFile(join(wt.path, "README.md"), "utf8")).toBe("# worker changes\n");
  });

  it("pruneStreams keeps a running worker's spool and stderr log", async () => {
    const now = Date.now();
    await seedRecord(cwd, makeWorkerRecord({ id: "w-live", name: "live", pid: process.pid }));
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(streams, { recursive: true });
    const spool = streamPath(cwd, "w-live");
    const stderrLog = stderrLogPath(cwd, "w-live");
    await writeFile(spool, '{"at":1}\n', "utf8");
    await writeFile(stderrLog, "worker booted\n", "utf8");

    await pruneStreams(cwd, now);

    await expect(stat(spool)).resolves.toBeTruthy();
    await expect(stat(stderrLog)).resolves.toBeTruthy();
  });

  it("pruneStreams removes the spool and stderr log of a terminal worker past a day", async () => {
    const now = Date.now();
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-dead",
        name: "dead",
        status: "failed",
        endedAt: now - 25 * 60 * 60_000,
      }),
    );
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(streams, { recursive: true });
    const spool = streamPath(cwd, "w-dead");
    const stderrLog = stderrLogPath(cwd, "w-dead");
    await writeFile(spool, '{"at":1}\n', "utf8");
    await writeFile(stderrLog, "boom\n", "utf8");

    await pruneStreams(cwd, now);

    await expect(stat(spool)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stderrLog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pruneWorkerArtifacts removes the paired stderr log with past-retention artifacts", async () => {
    const now = Date.now();
    await seedRecord(
      cwd,
      makeWorkerRecord({
        id: "w-stale",
        name: "stale",
        status: "completed",
        startedAt: now - WORKER_RETENTION_MS - 60_000,
        endedAt: now - WORKER_RETENTION_MS - 60_000,
      }),
    );
    const streams = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(streams, { recursive: true });
    const spool = streamPath(cwd, "w-stale");
    const stderrLog = stderrLogPath(cwd, "w-stale");
    await writeFile(spool, '{"at":1}\n', "utf8");
    await writeFile(stderrLog, "old failure detail\n", "utf8");

    const pruned = await pruneWorkerArtifacts(cwd);

    expect(pruned).toContain("w-stale");
    await expect(stat(spool)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stderrLog)).rejects.toMatchObject({ code: "ENOENT" });
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
        branch: "workers/w-orphan",
        startedAt: Date.now(),
        endedAt: Date.now(),
      }),
    );

    const sweep = await sweepWorkerArtifacts(cwd, new Set());

    expect(sweep.terminalOrphans.map((r) => r.id)).toEqual(["w-orphan"]);
    expect(sweep.unownedWorktrees).toEqual(["w-unowned"]);
  });

  it.each(["", "earlier report"])(
    "finalizeWorker records native cancellation with report %j without announcing success",
    async (report) => {
      const record = makeWorkerRecord({
        id: "w-aborted",
        name: "aborted",
        status: "running",
        streamFormat: "raw",
        worktree: join(cwd, "unavailable-worktree"),
        branch: "workers/w-aborted",
      });
      const path = streamPath(cwd, record.id);
      await mkdir(join(path, ".."), { recursive: true });
      const message = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: report }] },
      });
      await writeFile(path, `${message}\n{"type":"agent_settled","aborted":true}\n`, "utf8");
      const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };
      const onRecord = vi.fn((finalized: WorkerRecord) => writeRecordFile(cwd, finalized));

      const finalized = await finalizeWorker({ cwd, record, events, onRecord });

      expect(finalized.status).toBe("cancelled");
      expect(finalized.error).toBe("worker run aborted");
      expect(finalized.outputText).toBe(report || undefined);
      expect(finalized.patchPath).toBeUndefined();
      expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(await loadWorker(cwd, record.id)).toMatchObject({ status: "cancelled" });
      expect(await readFile(path, "utf8")).toContain('"status":"cancelled"');
      expect(events.wake).not.toHaveBeenCalled();
      expect(events.notify).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ type: "agent_settled", aborted: false }],
    [{ type: "agent_settled" }],
    [{ type: "agent_settled", aborted: "true" }],
    [
      { type: "agent_settled", aborted: true },
      { type: "agent_settled", aborted: false },
    ],
  ])(
    "finalizeWorker preserves completion for non-aborted or legacy settlements %j",
    async (...settlements) => {
      const record = makeWorkerRecord({ id: "w-settled", status: "running", streamFormat: "raw" });
      const path = streamPath(cwd, record.id);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final report" }] } })}\n${settlements.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );

      const finalized = await finalizeWorker({ cwd, record });

      expect(finalized.status).toBe("completed");
      expect(finalized.outputText).toBe("final report");
      expect(finalized.error).toBeUndefined();
    },
  );

  it.each([
    {
      stopReason: "error",
      errorMessage: "Request failed: 503 Service Unavailable",
      expectedError: "Request failed: 503 Service Unavailable",
    },
    {
      stopReason: "error",
      errorMessage: undefined,
      expectedError: "provider request failed",
    },
  ])(
    "finalizeWorker fails a worker whose final message settles with stopReason %s",
    async ({ stopReason, errorMessage, expectedError }) => {
      const record = makeWorkerRecord({
        id: "w-provider-error",
        name: "flaky",
        status: "running",
        streamFormat: "raw",
      });
      const path = streamPath(cwd, record.id);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial report" }],
            stopReason,
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          },
        })}\n{"type":"agent_settled","aborted":false}\n`,
        "utf8",
      );
      const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

      const finalized = await finalizeWorker({ cwd, record, events });

      expect(finalized.status).toBe("failed");
      expect(finalized.error).toBe(expectedError);
      expect(finalized.outputText).toBe("partial report");
      expect(events.notify).toHaveBeenCalledWith("error", expect.stringContaining(expectedError));
      expect(events.wake).toHaveBeenCalledWith(expect.stringContaining("failed"));
      expect(await readFile(path, "utf8")).toContain('"status":"failed"');
    },
  );

  it("finalizeWorker stays completed when a provider error precedes a successful final message", async () => {
    const record = makeWorkerRecord({ id: "w-retry", status: "running", streamFormat: "raw" });
    const path = streamPath(cwd, record.id);
    await mkdir(join(path, ".."), { recursive: true });
    const failedAttempt = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Request failed: 503 Service Unavailable",
      },
    });
    const finalAttempt = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final report" }],
        stopReason: "stop",
      },
    });
    await writeFile(
      path,
      `${failedAttempt}\n${finalAttempt}\n{"type":"agent_settled","aborted":false}\n`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toBe("final report");
    expect(finalized.error).toBeUndefined();
  });

  it.each([
    { statusOverride: "timeout" as const, marker: undefined, expected: "timeout" },
    { statusOverride: undefined, marker: "failed", expected: "failed" },
    { statusOverride: "cancelled" as const, marker: "failed", expected: "cancelled" },
  ])(
    "finalizeWorker gives explicit status priority over native cancellation: $expected",
    async ({ statusOverride, marker, expected }) => {
      const record = makeWorkerRecord({ id: "w-priority", status: "running", streamFormat: "raw" });
      const path = streamPath(cwd, record.id);
      await mkdir(join(path, ".."), { recursive: true });
      const end = marker
        ? `${JSON.stringify({ type: "workers_end", status: marker, error: "explicit failure" })}\n`
        : "";
      await writeFile(path, `{"type":"agent_settled","aborted":true}\n${end}`, "utf8");

      const finalized = await finalizeWorker({
        cwd,
        record,
        ...(statusOverride !== undefined ? { statusOverride } : {}),
      });

      expect(finalized.status).toBe(expected);
      expect(finalized.error).not.toBe("worker run aborted");
    },
  );

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
      '{"type":"workers_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"the salvaged report"}]}}\n',
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toContain("the salvaged report");
    expect(finalized.patchPath).toBeDefined();
    // The end marker lands in the spool so later readers see terminal state.
    const spool = await readFile(join(spoolDir, "w-salvage.jsonl"), "utf8");
    expect(spool).toContain('"type":"workers_end"');
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
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("boom went the worker");
    // An ordinary failure has no patch, so the wake carries no collect hint.
    expect(events.wake).toHaveBeenCalledWith(expect.not.stringContaining("collect"));
  });

  it("finalizeWorker infers completed from the last report of an oversized spool", async () => {
    const record = makeWorkerRecord({
      id: "w-oversized",
      name: "oversized",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // Noise well past the finalization scan's read chunk, then two reports:
    // the most recent one must win.
    const noise = `{"type":"tool_execution_start","toolName":"bash","args":{"command":"${"x".repeat(512)}"}}\n`;
    const oversized = noise.repeat(Math.ceil((STREAM_TAIL_BYTES * 2) / noise.length));
    await writeFile(
      join(spoolDir, "w-oversized.jsonl"),
      `${oversized}{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"draft report"}]}}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"the final report"}]}}\n`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toBe("the final report");
  });

  it("finalizeWorker records a complete report even when one line exceeds the old read window", async () => {
    const record = makeWorkerRecord({
      id: "w-straddle",
      name: "straddle",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // The streaming scan sees the whole spool, so a single report line
    // larger than any window is still a readable report.
    const hugeReport = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${"y".repeat(STREAM_TAIL_BYTES)} the whole report"}]}}\n`;
    await writeFile(
      join(spoolDir, "w-straddle.jsonl"),
      `{"type":"workers_start","at":1}\n${hugeReport}`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toContain("the whole report");
    expect(finalized.outputText?.length).toBeGreaterThan(STREAM_TAIL_BYTES);
  });

  it("finalizeWorker keeps an early report when later noise exceeds the read window", async () => {
    const record = makeWorkerRecord({
      id: "w-head-report",
      name: "head-report",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // The report sits at the spool head; the streaming scan must still see
    // it however much noise follows.
    const report =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"early report"}]}}\n';
    const noise = `{"type":"tool_execution_start","toolName":"bash","args":{"command":"${"x".repeat(512)}"}}\n`;
    await writeFile(
      join(spoolDir, "w-head-report.jsonl"),
      `${report}${noise.repeat(Math.ceil((STREAM_TAIL_BYTES * 2) / noise.length))}`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toBe("early report");
  });

  it("finalizeWorker recovers an output-limit report that trailing spool events push past the read window", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-trailer");
    await writeFile(join(wt.path, "TRAILER.md"), "trailer work\n", "utf8");
    const record = makeWorkerRecord({
      id: "w-trailer",
      name: "trailer",
      status: "running",
      worktree: wt.path,
      branch: wt.branch,
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // pi writes trailing events after the final assistant message, and
    // agent_end repeats the whole run conversation: a long run makes it the
    // biggest line in the spool. Finalization must still see the truncated
    // report and its stopReason.
    const truncated = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial report, cut off" }],
        stopReason: "length",
      },
    });
    const agentEnd = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "x".repeat(STREAM_TAIL_BYTES * 2) }] },
      ],
    });
    await writeFile(
      join(spoolDir, "w-trailer.jsonl"),
      `${truncated}\n{"type":"agent_settled","aborted":false}\n${agentEnd}\n`,
      "utf8",
    );
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("output limit");
    expect(finalized.outputText).toBe("partial report, cut off");
    expect(finalized.patchPath).toBeDefined();
    expect(events.wake).toHaveBeenCalledWith(expect.stringContaining("output limit"));
  });

  it("finalizeWorker honors an end marker in an oversized spool", async () => {
    const record = makeWorkerRecord({
      id: "w-marked-huge",
      name: "marked-huge",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    const noise = `{"type":"tool_execution_start","toolName":"bash","args":{"command":"${"x".repeat(512)}"}}\n`;
    await writeFile(
      join(spoolDir, "w-marked-huge.jsonl"),
      `${noise.repeat(Math.ceil((STREAM_TAIL_BYTES * 2) / noise.length))}{"type":"workers_end","at":2,"status":"timeout","error":"worker exceeded 30s timeout"}\n`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("timeout");
    expect(finalized.error).toContain("30s timeout");
  });

  it("readSpoolLines drops the first incomplete line when the window cuts a JSON event", async () => {
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    const noise = `{"type":"tool_execution_start","toolName":"bash","args":{"command":"${"x".repeat(600)}"}}\n`;
    const report =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"tail report"}]}}\n';
    await writeFile(
      join(spoolDir, "w-cut.jsonl"),
      `{"type":"workers_start","at":1}\n${noise}${report}`,
      "utf8",
    );

    const lines = await readSpoolLines(cwd, "w-cut", 120);

    // The window cut inside the noise line: its partial remainder is not a
    // valid event and must not surface; the complete report line survives.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "message_end" });
  });

  it("finalizeWorker keeps the worktree recoverable when patch capture refuses", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-uncaptured");
    // The parent tree drifts after the branch, making the worker's patch
    // inapplicable at capture time.
    await writeFile(join(cwd, "README.md"), "# parent drifted\n", "utf8");
    await writeFile(join(wt.path, "README.md"), "# worker edit\n", "utf8");
    const record = makeWorkerRecord({
      id: "w-uncaptured",
      name: "uncaptured",
      status: "running",
      worktree: wt.path,
      branch: wt.branch,
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-uncaptured.jsonl"),
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"the report"}]}}\n',
      "utf8",
    );
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    expect(finalized.status).toBe("completed");
    expect(finalized.patchPath).toBeDefined();
    await expect(stat(finalized.patchPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    expect(finalized.error).toContain("patch capture failed");
    // No patch was stored, so the completed wake must not tell the parent
    // to collect one.
    expect(events.wake).toHaveBeenCalledWith(expect.not.stringContaining("collect"));
    // The record points at the absent patch, so collect and retention treat
    // the worktree as the only remaining copy of the worker's changes.
    expect(existsSync(wt.path)).toBe(true);
    await expect(discardWorktree(cwd, finalized)).resolves.toBe("kept");
  });

  it("finalizeWorker keeps the worktree recoverable when a truncated report's patch capture refuses", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-trunc-uncaptured");
    await writeFile(join(cwd, "README.md"), "# parent drifted\n", "utf8");
    await writeFile(join(wt.path, "README.md"), "# worker edit\n", "utf8");
    const record = makeWorkerRecord({
      id: "w-trunc-uncaptured",
      name: "trunc-uncaptured",
      status: "running",
      worktree: wt.path,
      branch: wt.branch,
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-trunc-uncaptured.jsonl"),
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial report, cut off" }],
          stopReason: "length",
        },
      })}\n`,
      "utf8",
    );
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("output limit");
    expect(finalized.error).toContain("patch capture failed");
    expect(finalized.patchPath).toBeDefined();
    await expect(stat(finalized.patchPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    // The wake names the output-limit cause but must not offer a collect
    // for a patch that was never stored.
    expect(events.wake).toHaveBeenCalledWith(expect.stringContaining("output limit"));
    expect(events.wake).toHaveBeenCalledWith(expect.not.stringContaining("collect"));
    // The worktree keeps the changes for recovery.
    expect(existsSync(wt.path)).toBe(true);
    await expect(discardWorktree(cwd, finalized)).resolves.toBe("kept");
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
      '{"type":"workers_end","at":2,"status":"timeout","error":"worker exceeded 30s timeout"}\n',
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
      '{"type":"workers_blocker","at":9,"reason":"stuck on missing credentials"}\n{"type":"workers_end","at":10,"status":"timeout","error":"worker exceeded 30s timeout"}\n',
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    // The adoption/timeout path still surfaces why the worker got stuck.
    expect(finalized.status).toBe("timeout");
    expect(finalized.blocker).toEqual({ reason: "stuck on missing credentials", at: 9 });
  });

  it("finalizeWorker reports failed with an output-limit reason when the final report is truncated", async () => {
    const record = makeWorkerRecord({
      id: "w-truncated",
      name: "truncated",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // A final assistant report cut off by the model output limit: the child
    // exits zero and the partial text is present, but the run never settled
    // normally.
    await writeFile(
      join(spoolDir, "w-truncated.jsonl"),
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The auth module uses JWT to" }],
          stopReason: "length",
        },
      })}\n`,
      "utf8",
    );
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    // Truncation never reads as completed, even with a nonempty report and
    // a zero exit code.
    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("output limit");
    // The partial report stays readable for status inspection.
    expect(finalized.outputText).toBe("The auth module uses JWT to");
    // Status and wake messages identify the output-limit cause.
    expect(events.notify).toHaveBeenCalledWith("error", expect.stringContaining("output limit"));
    expect(events.wake).toHaveBeenCalledWith(expect.stringContaining("output limit"));
    // A non-isolated worker has no patch, so the wake carries no collect hint.
    expect(events.wake).toHaveBeenCalledWith(expect.not.stringContaining("collect"));
  });

  it("finalizeWorker captures the patch when the report is truncated so the worktree stays recoverable", async () => {
    await initGitRepo(cwd);
    const wt = await createWorktree(cwd, "w-trunc-patch");
    await writeFile(join(wt.path, "TRUNCATED.md"), "partial work\n", "utf8");
    const record = makeWorkerRecord({
      id: "w-trunc-patch",
      name: "trunc-patch",
      status: "running",
      worktree: wt.path,
      branch: wt.branch,
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-trunc-patch.jsonl"),
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial report, cut off mid-sentence" }],
          stopReason: "length",
        },
      })}\n`,
      "utf8",
    );
    const events = { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };

    const finalized = await finalizeWorker({ cwd, record, events });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("output limit");
    expect(finalized.outputText).toBe("partial report, cut off mid-sentence");
    // The captured patch applies to the parent tree, so the worker's real
    // changes remain collectible despite the failed outcome.
    expect(finalized.patchPath).toBeDefined();
    await expect(readFile(finalized.patchPath as string, "utf8")).resolves.toContain(
      "TRUNCATED.md",
    );
    // The failed wake points at the recoverable patch, like the completed
    // wake does.
    expect(events.wake).toHaveBeenCalledWith(expect.stringContaining("(action=collect)"));
  });

  it.each([
    ["no stopReason field (older records)", {}],
    ["stopReason stop", { stopReason: "stop" }],
  ])("finalizeWorker keeps completion for a final report with %s", async (_label, extra) => {
    const record = makeWorkerRecord({
      id: "w-stop-reason",
      name: "stop-reason",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-stop-reason.jsonl"),
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final report" }],
          ...extra,
        },
      })}\n`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toBe("final report");
    expect(finalized.error).toBeUndefined();
  });

  it("finalizeWorker keeps completion when only a mid-stream message hit the output limit", async () => {
    const record = makeWorkerRecord({
      id: "w-recovered",
      name: "recovered",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // A length stop mid-run followed by a normal final settlement: the run
    // continued past the limit and finished, so the worker completed.
    const truncated = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "length",
      },
    });
    const finished = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "the final report" }],
        stopReason: "stop",
      },
    });
    await writeFile(join(spoolDir, "w-recovered.jsonl"), `${truncated}\n${finished}\n`, "utf8");

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("completed");
    expect(finalized.outputText).toBe("the final report");
    expect(finalized.error).toBeUndefined();
  });

  it("finalizeWorker drops stale earlier text when the truncated final message has none", async () => {
    const record = makeWorkerRecord({
      id: "w-trunc-quiet",
      name: "trunc-quiet",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    // The limit cut the final message during thinking: it carries no text
    // block. The earlier mid-run text must not surface as the report.
    const midRun = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reading auth module." }],
        stopReason: "toolUse",
      },
    });
    const truncated = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "half-formed thought" }],
        stopReason: "length",
      },
    });
    await writeFile(join(spoolDir, "w-trunc-quiet.jsonl"), `${midRun}\n${truncated}\n`, "utf8");

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("output limit");
    // The earlier mid-run text is not the partial report; only the spool
    // tail keeps it.
    expect(finalized.outputText).toBeUndefined();
  });

  it.each([
    { override: "timeout" as const, expected: "timeout" },
    { override: "cancelled" as const, expected: "cancelled" },
  ])(
    "finalizeWorker keeps an explicit override over output-limit truncation: $expected",
    async ({ override, expected }) => {
      const record = makeWorkerRecord({
        id: "w-trunc-override",
        name: "trunc-override",
        status: "running",
        streamFormat: "raw",
      });
      const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
      await mkdir(spoolDir, { recursive: true });
      await writeFile(
        join(spoolDir, "w-trunc-override.jsonl"),
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial report" }],
            stopReason: "length",
          },
        })}\n`,
        "utf8",
      );

      const finalized = await finalizeWorker({ cwd, record, statusOverride: override });

      expect(finalized.status).toBe(expected);
      expect(finalized.error ?? "").not.toContain("output limit");
    },
  );

  it("finalizeWorker keeps native cancellation over output-limit truncation", async () => {
    const record = makeWorkerRecord({
      id: "w-trunc-aborted",
      name: "trunc-aborted",
      status: "running",
      streamFormat: "raw",
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    const truncated = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial report" }],
        stopReason: "length",
      },
    });
    await writeFile(
      join(spoolDir, "w-trunc-aborted.jsonl"),
      `${truncated}\n{"type":"agent_settled","aborted":true}\n`,
      "utf8",
    );

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("cancelled");
    expect(finalized.error).toBe("worker run aborted");
  });
});

describe("worker session scoping", () => {
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
    cwd = await mkdtemp(join(tmpdir(), "workers-scope-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "workers-scope-fixture-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    setEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
    setEnv("PI_MAX_WORKERS", "1");
    await workersExtension(mockPi);
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
    const started = await executeTool("spawn_worker", { task: "t", isolate: false });
    expect(started.details.workerId).toBeDefined();
    await executeTool("workers", { action: "cancel", id: started.details.workerId as string });
  });

  it("a spawn persists the worker child pid on the record", async () => {
    const fixture = await writeFixture(fixtureDir, "slow-worker.sh", SLOW_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "long", isolate: false });
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

  it("a spawn records the owning session on the worker", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("spawn_worker", { task: "t", isolate: false, wait: true });
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
      '{"type":"workers_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"adopted report"}]}}\n',
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

  it("an adopted worker past its persisted deadline is killed and recorded as a timeout", async () => {
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    // Original bound: 60s, already elapsed before adoption. Corresponds to
    // a spawn_worker call with timeout_seconds: 60.
    const record = makeWorkerRecord({
      id: "w-expired",
      name: "expired",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 61_000,
      deadlineAt: now - 1_000,
    });
    await seedRecord(cwd, record);

    try {
      const disarm = armAdoptedTimeout(record, {
        cwd,
        onRecord: (finalized) => writeRecordFile(cwd, finalized),
      });

      await vi.waitFor(
        async () => {
          const stored = await loadWorker(cwd, "w-expired");
          expect(stored?.status).toBe("timeout");
        },
        { timeout: 8_000 },
      );
      // The terminal record carries the same detail the spawning parent
      // would have written for the same bound.
      const stored = await loadWorker(cwd, "w-expired");
      expect(stored?.error).toBe("worker exceeded 60s timeout");
      // Enforcement kills the process group before terminalizing, so the
      // timeout record implies the worker is gone.
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(false);
      disarm();
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("an adopted worker is killed when the remaining deadline elapses, not after the full timeout", async () => {
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    // Original bound: 120s, ~119s already spent before adoption. Arming the
    // remaining ~1s is the only way the kill can happen inside this test;
    // a full-timeout re-arm could not fire, and no arming would never kill.
    const record = makeWorkerRecord({
      id: "w-remaining",
      name: "remaining",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + 1_000,
    });
    await seedRecord(cwd, record);

    try {
      const disarm = armAdoptedTimeout(record, {
        cwd,
        onRecord: (finalized) => writeRecordFile(cwd, finalized),
      });

      await vi.waitFor(
        async () => {
          const stored = await loadWorker(cwd, "w-remaining");
          expect(stored?.status).toBe("timeout");
        },
        { timeout: 8_000 },
      );
      expect(await loadWorker(cwd, "w-remaining")).toMatchObject({
        status: "timeout",
        error: "worker exceeded 120s timeout",
      });
      disarm();
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("a legacy adopted worker without a persisted deadline is not retroactively timed out", async () => {
    const sleeper = execFile("sleep", ["30"]);
    // Records created before deadlines were persisted carry no deadlineAt;
    // startedAt alone must never become a retroactive bound.
    const record = makeWorkerRecord({
      id: "w-legacy",
      name: "legacy",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: Date.now() - 10 * 60_000,
    });
    await seedRecord(cwd, record);

    try {
      const disarm = armAdoptedTimeout(record, {
        cwd,
        onRecord: (finalized) => writeRecordFile(cwd, finalized),
      });

      // Far past any plausible retroactive bound: still alive, still running.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(true);
      expect((await loadWorker(cwd, "w-legacy"))?.status).toBe("running");
      disarm();
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("disarming an adopted worker's deadline leaves it running past the deadline", async () => {
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    const record = makeWorkerRecord({
      id: "w-disarm",
      name: "disarm",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + 600,
    });
    await seedRecord(cwd, record);

    try {
      const disarm = armAdoptedTimeout(record, {
        cwd,
        onRecord: (finalized) => writeRecordFile(cwd, finalized),
      });
      disarm();

      // Past the deadline: disarmed means no kill, no terminal record.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(true);
      expect((await loadWorker(cwd, "w-disarm"))?.status).toBe("running");
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("session_start adopting a live worker past its deadline kills it and records a timeout", async () => {
    // pi -c restored a running worker whose persisted deadline already
    // elapsed: adoption must re-arm the remaining (zero) time, kill the
    // child, and terminalize the record as a timeout — not leave it running
    // unbounded, and not let the exit poller classify the kill as a
    // completed report (the spool below carries one).
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    // Original bound: 60s, already elapsed before adoption.
    const record = makeWorkerRecord({
      id: "w-adopt-expired",
      name: "expired",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 61_000,
      deadlineAt: now - 1_000,
    });
    const spoolDir = join(cwd, CONFIG_DIR_NAME, "workers", "streams");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      join(spoolDir, "w-adopt-expired.jsonl"),
      '{"type":"workers_start","at":1}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"expired report"}]}}\n',
      "utf8",
    );

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      const stored = await waitForRecord(cwd, "w-adopt-expired", "timeout", 10_000);
      // The record carries the same cause the spawning parent would have
      // written for the same bound — not a completed-report classification
      // of the deadline kill.
      expect(stored.error).toBe("worker exceeded 60s timeout");
      expect(stored.outputText).toContain("expired report");
      // Enforcement kills the process group before terminalizing.
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(false);
      // Owned worker: the terminal record lands in this session's transcript.
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        WORKER_RECORD_ENTRY,
        expect.objectContaining({ id: "w-adopt-expired", status: "timeout" }),
      );
      // Notification and wake tell the user why the worker stopped.
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
        "warning",
      );
      expect(findWakeCall(mockPi).message.content[0].text).toContain("timed out");
      // Widget cleanup: the worker no longer runs, so the strip must not keep
      // showing it. If a publish ran while adoption still reported "running",
      // the last strip call is the clear; when the deadline kill beats
      // session_start's final publish, the strip is legitimately never
      // published at all (the strip only hides a previously published widget).
      await vi.waitFor(() => {
        const stripCalls = mockCtx.ui.setWidget.mock.calls.filter(
          ([key]) => key === STRIP_KEY_ABOVE,
        );
        const last = stripCalls.at(-1);
        expect(last === undefined || last[1] === undefined).toBe(true);
      });
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("session_start arms only the remaining deadline for an adopted worker", async () => {
    // Original bound: 120s with ~119s already spent. Re-arming the full
    // timeout would push the kill two minutes out and fail this test.
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    const record = makeWorkerRecord({
      id: "w-adopt-remaining",
      name: "remaining",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + 600,
    });

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      const stored = await waitForRecord(cwd, "w-adopt-remaining", "timeout", 10_000);
      expect(stored.error).toBe("worker exceeded 120s timeout");
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(false);
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("session_start does not impose a deadline on an adopted worker whose record predates deadlines", async () => {
    // Legacy records carry no deadlineAt; startedAt alone must never become
    // a retroactive bound through adoption.
    const sleeper = execFile("sleep", ["30"]);
    const record = makeWorkerRecord({
      id: "w-adopt-legacy",
      name: "legacy",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: Date.now() - 10 * 60_000,
    });
    await seedRecord(cwd, record);

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      // Far past any plausible retroactive bound: still alive, still running.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(true);
      expect((await loadWorker(cwd, "w-adopt-legacy"))?.status).toBe("running");
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("cancelling an adopted worker disposes its deadline", async () => {
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    // The deadline must outlast slow setup (adoption runs real file scans),
    // so the cancel disposes a live timer rather than an elapsed one. The
    // past-deadline check below waits out the real deadline dynamically.
    const deadlineMs = 4_000;
    const record = makeWorkerRecord({
      id: "w-adopt-cancel",
      name: "adopt-cancel",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + deadlineMs,
    });
    await seedRecord(cwd, record);

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      const result = await executeTool("workers", { action: "cancel", id: "w-adopt-cancel" });
      expect(result.content[0].text).toContain("cancelled");
      expect(await waitForRecord(cwd, "w-adopt-cancel", "cancelled")).toMatchObject({
        error: "cancelled by user",
      });
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(false);

      // Past the deadline the disposed timer must not rewrite the record:
      // cancelled stays cancelled. The wait reaches the real deadline
      // however long the setup took.
      await waitPastDeadline(record.deadlineAt ?? now);
      expect((await loadWorker(cwd, "w-adopt-cancel"))?.status).toBe("cancelled");
      const timeoutSave = mockPi.appendEntry.mock.calls.some(
        ([customType, data]) =>
          customType === WORKER_RECORD_ENTRY &&
          (data as WorkerRecord).id === "w-adopt-cancel" &&
          (data as WorkerRecord).status === "timeout",
      );
      expect(timeoutSave).toBe(false);
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("session_shutdown disposes an adopted worker's deadline timer", async () => {
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    // The deadline must outlast slow setup (adoption runs real file scans),
    // so the shutdown disposes a live timer rather than an elapsed one. The
    // past-deadline check below waits out the real deadline dynamically.
    const deadlineMs = 4_000;
    const record = makeWorkerRecord({
      id: "w-adopt-shutdown",
      name: "adopt-shutdown",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + deadlineMs,
    });
    await seedRecord(cwd, record);

    try {
      mockCtx.sessionManager.getBranch = vi.fn(() => [branchEntry(record)]);
      await getEventHandlerFrom(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );
      // Shutdown cancels owned adopted workers and must disarm the deadline
      // with them.
      await getEventHandlerFrom(mockPi, "session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        mockCtx,
      );
      expect(await waitForRecord(cwd, "w-adopt-shutdown", "cancelled")).toMatchObject({
        error: "cancelled by user",
      });
      expect(isProcessAlive(sleeper.pid ?? 0)).toBe(false);

      // Past the deadline: disposed means no timeout kill and no rewrite.
      // The wait reaches the real deadline however long the setup took.
      await waitPastDeadline(record.deadlineAt ?? now);
      expect((await loadWorker(cwd, "w-adopt-shutdown"))?.status).toBe("cancelled");
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
    }
  });

  it("the deadline hook stops watching synchronously before the kill", async () => {
    // The exit poller must be disabled before the deadline sends a signal:
    // otherwise its natural-death finalize (completed/failed from the spool)
    // can win the race against the timeout terminal save.
    const sleeper = execFile("sleep", ["30"]);
    const now = Date.now();
    const record = makeWorkerRecord({
      id: "w-before-kill",
      name: "before-kill",
      pid: sleeper.pid ?? 0,
      parentPid: 999_999_999,
      status: "running",
      streamFormat: "raw",
      startedAt: now - 119_000,
      deadlineAt: now + 600,
    });
    await seedRecord(cwd, record);
    let aliveAtBeforeKill: boolean | undefined;
    const beforeKill = vi.fn(() => {
      aliveAtBeforeKill = isProcessAlive(record.pid ?? -1);
    });

    try {
      const disarm = armAdoptedTimeout(record, {
        cwd,
        beforeKill,
        onRecord: (finalized) => writeRecordFile(cwd, finalized),
      });

      expect(await waitForRecord(cwd, "w-before-kill", "timeout")).toMatchObject({
        error: "worker exceeded 120s timeout",
      });
      expect(beforeKill).toHaveBeenCalledTimes(1);
      // No signal had been sent when the hook ran, so the worker was alive.
      expect(aliveAtBeforeKill).toBe(true);
      disarm();
    } finally {
      if (sleeper.pid !== undefined) await killPidTree(sleeper.pid);
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

/** The record's worktree path, failing loudly when the record has none. */
function recordWorktree(record: WorkerRecord): string {
  if (record.worktree === undefined) throw new Error(`record ${record.id} has no worktree`);
  return record.worktree;
}

function testEvents(): WorkerEvents {
  return { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };
}

/** Fake git for provision flows: a repository that is always clean, always
 *  inside a work tree, and materializes requested worktree directories on
 *  disk so provisioning has a real target. The committed provision config
 *  defaults to untracked so the D2 commit path runs. */
function fakeWorktreeGit(opts: { configStatus?: string; commitError?: string } = {}): void {
  vi.mocked(runGit).mockImplementation(async (repoCwd: string, args: string[]) => {
    const [cmd, sub] = args;
    if (cmd === "rev-parse") {
      if (sub === "--is-inside-work-tree") return "true\n";
      if (sub === "HEAD") return "fakebase\n";
      if (sub === "--absolute-git-dir") {
        const gitDir = `${repoCwd}.git`;
        await mkdir(gitDir, { recursive: true });
        return gitDir;
      }
      throw new Error(`fake git: unexpected rev-parse ${String(sub)}`);
    }
    if (cmd === "status" && sub === "--porcelain") {
      if (args[2] === "--") {
        return (
          opts.configStatus ??
          `?? ${CONFIG_DIR_NAME}/provision-worktree\n?? ${CONFIG_DIR_NAME}/sandbox.json\n`
        );
      }
      return ""; // clean tree
    }
    if (cmd === "worktree" && sub === "add") {
      await mkdir(args[4], { recursive: true });
      return "";
    }
    if (cmd === "worktree" && sub === "remove") {
      await rm(args[3], { recursive: true, force: true });
      return "";
    }
    if (cmd === "branch" || cmd === "add") return "";
    if (cmd === "commit") {
      if (opts.commitError !== undefined) throw new Error(opts.commitError);
      return "";
    }
    if (cmd === "ls-files" && sub === "--others") {
      // Minimal fake ignore engine: enumerate files under source (absolute
      // root path = repoCwd), filter by the include file, return -z form.
      const includeFlag = args.find((arg) => arg.startsWith("--exclude-from="));
      const includeFile = includeFlag?.slice("--exclude-from=".length) ?? "";
      let includeText = "";
      try {
        includeText = await readFile(includeFile, "utf8");
      } catch {
        return "";
      }
      const patterns = includeText
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "" && !line.startsWith("#"));
      const results: string[] = [];
      async function scan(dir: string, prefix: string): Promise<void> {
        for (const [type, entries] of [
          ["dir", await readdir(dir).catch(() => [] as string[])],
        ] as const) {
          void type;
          for (const entry of entries) {
            const full = join(dir, entry);
            const rel = prefix ? `${prefix}/${entry}` : entry;
            const info = await stat(full).catch(() => null);
            if (info?.isDirectory()) {
              if (entry === ".git" || entry === "node_modules") continue;
              await scan(full, rel);
            } else if (info?.isFile()) {
              if (matchesInclude(rel, patterns)) results.push(rel);
            }
          }
        }
      }
      function matchesInclude(rel: string, pats: string[]): boolean {
        let best = false;
        for (const raw of pats) {
          if (!raw) continue;
          const negative = raw.startsWith("!");
          const body = (negative ? raw.slice(1) : raw).replace(/^\//, "").replace(/\/$/, "");
          if (!body) continue;
          const regex = new RegExp(
            `^${body
              .split("/")
              .map((part) =>
                part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`)),
              )
              .join("/")}(?=/|$)`,
          );
          if (regex.test(rel)) best = !negative;
        }
        return best;
      }
      await scan(repoCwd, "");
      return results.map((rel) => `${rel}\0`).join("");
    }
    throw new Error(`fake git: unexpected command: ${args.join(" ")}`);
  });
}
