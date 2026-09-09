import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agentsExtension from "../../extensions/agents/agents.ts";
import { extractAssistantText } from "../../extensions/agents/src/runner.ts";
import {
  generateWorkerId,
  loadWorker,
  loadWorkers,
  saveWorker,
} from "../../extensions/agents/src/store.ts";
import {
  applyPatch,
  captureWorktreePatch,
  createWorktree,
  isGitRepo,
  removeWorktree,
} from "../../extensions/agents/src/worktree.ts";
import { cleanGitEnv } from "../../lib/git.ts";
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
const SLOW_WORKER = "#!/bin/sh\nsleep 30\n";

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

// --- Suite ---

describe("agents-extension", () => {
  let cwd: string;
  let fixtureDir: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const executeTool = async (name: string, params: Record<string, unknown>) => {
    const call = mockPi.registerTool.mock.calls.find((c) => c[0].name === name);
    if (!call) throw new Error(`tool ${name} not registered`);
    return call[0].execute("call-1", params as never, undefined, undefined, mockCtx);
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
    cwd = await mkdtemp(join(tmpdir(), "agents-test-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "agents-fixture-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    // Default test configuration: most tests delegate, so a worker model
    // must resolve. The unconfigured-error test clears it again.
    setEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
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
    await rm(cwd, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("registers delegate and workers tools", () => {
    const names = mockPi.registerTool.mock.calls.map((c) => c[0].name);
    expect(names).toContain("delegate");
    expect(names).toContain("workers");
  });

  it("delegate from a planning session forces read-only workers", async () => {
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

    await executeTool("delegate", { task: "research", isolate: false, wait: true });

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args).toContain("--worker-readonly");
    expect(args).not.toContain("--gondolin");
    const planPathIndex = args.indexOf("-e", args.indexOf("-e") + 1);
    const planPaths = args.filter((arg) => arg.includes("plan.ts"));
    expect(planPaths.length).toBeGreaterThanOrEqual(1);
    void planPathIndex;
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
    const stored = await loadWorkers(cwd);
    expect(Object.values(stored)).toHaveLength(1);
    expect(Object.values(stored)[0].outputText).toContain("JWT tokens");
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
    ).rejects.toThrow(/already exists/);
  });

  it("workers status reads a finished worker's report", async () => {
    const fixture = await writeFixture(fixtureDir, "ok-worker.sh", SUCCESS_WORKER);
    setEnv("PI_WORKER_COMMAND", fixture);

    const started = await executeTool("delegate", { task: "look", isolate: false, wait: true });
    const id = started.details.worker.id as string;

    const status = await executeTool("workers", { action: "status", id });
    expect(status.content[0].text).toContain("JWT tokens");
  });

  it("saveWorker ignores a stale running snapshot for a terminal record", async () => {
    await saveWorker(cwd, {
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
    // the terminal record the runner already wrote.
    await saveWorker(cwd, {
      id: "w-done",
      name: "done",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });

    const record = await loadWorker(cwd, "w-done");
    expect(record?.status).toBe("completed");
    expect(record?.outputText).toBe("the report");
  });

  it("concurrent initial-save and completion-save keep the terminal record", async () => {
    const running = saveWorker(cwd, {
      id: "w-race",
      name: "race",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });
    await saveWorker(cwd, {
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

  it("session_start reconciles orphaned running workers", async () => {
    const id = generateWorkerId();
    await loadWorkers(cwd);
    const { saveWorker } = await import("../../extensions/agents/src/store.ts");
    await saveWorker(cwd, {
      id,
      name: "ghost",
      task: "t",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const record = await loadWorker(cwd, id);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("gone");
  });

  it("loadWorkers reconciles stuck-running records whose pid is dead on any read", async () => {
    // The parent may have died with no session_start ever running again; the
    // read itself must heal stuck-running records.
    await saveWorker(cwd, {
      id: "w-stuck",
      name: "stuck",
      task: "orphaned task",
      model: "m",
      pid: 999_999_999,
      cwd,
      status: "running",
      startedAt: Date.now() - 5_000,
    });

    const workers = await loadWorkers(cwd);

    expect(workers["w-stuck"].status).toBe("failed");
    expect(workers["w-stuck"].error).toContain("gone");
    expect(workers["w-stuck"].endedAt).toBeDefined();
  });

  it("loadWorkers leaves live running records alone", async () => {
    await saveWorker(cwd, {
      id: "w-live",
      name: "live",
      task: "live task",
      model: "m",
      pid: process.pid,
      cwd,
      status: "running",
      startedAt: Date.now(),
    });

    const workers = await loadWorkers(cwd);

    expect(workers["w-live"].status).toBe("running");
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

  it("workers collect applies an isolated worker's patch and cleans up", async () => {
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
    const record = await loadWorker(cwd, id);
    expect(record?.collectedAt).toBeDefined();
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
});
