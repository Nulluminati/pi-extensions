import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DelegatePlan,
  startDelegatedWorker,
  type WorkerSessionState,
} from "../../extensions/agents/src/delegate.ts";
import { listRecordFiles } from "../../extensions/agents/src/store.ts";
import type { WorkerEvents, WorkerRecord } from "../../extensions/agents/src/types.ts";
import {
  PROVISION_HOOK_RELATIVE,
  WORKER_SANDBOX_RELATIVE,
} from "../../extensions/agents/src/worker-sandbox-config.ts";
import { cleanGitEnv, runGit } from "../../lib/git.ts";

/**
 * Set by the concurrency test: fired once when the provision preflight
 * reaches its setup-file status gate, before the gate's path commit. The
 * hook runs real git (call-through below), so a refusal's "Git history
 * unchanged" property is exercised against an actual repository.
 */
const preflightHook = vi.hoisted(() => ({
  onStatus: undefined as (() => void | Promise<void>) | undefined,
}));

// Call-through git spy: tests run real git in a temp repository. The spy
// exists only so the concurrency test can fire its hook deterministically
// at the preflight's status gate.
vi.mock("../../lib/git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/git.ts")>();
  return {
    ...actual,
    runGit: vi.fn(async (repoCwd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "--porcelain" && preflightHook.onStatus) {
        const hook = preflightHook.onStatus;
        preflightHook.onStatus = undefined;
        await hook();
      }
      return actual.runGit(repoCwd, args);
    }),
  };
});

// The setup hook is faked so a regressed reservation path (recheck dropped)
// stays hermetic and cannot boot a real sandbox; correct refusals never
// reach provisioning.
vi.mock("../../extensions/agents/src/provision/hook.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../extensions/agents/src/provision/hook.ts")>();
  return {
    ...actual,
    runSetupHook: vi.fn(async (worktree: string) => ({
      exitCode: 0,
      detail: "ok",
      ms: 1,
      logPath: `${worktree}/.hook.log`,
    })),
  };
});

const execFileAsync = promisify(execFile);
const gitOpts = (cwd: string) => ({ cwd, env: cleanGitEnv() });

/** Temp repos created by the current test; drained and removed in afterEach. */
const tempDirs: string[] = [];

// --- Helpers ---

/** Valid sandbox policy body; `markDirty` toggles content to dirty a tracked file. */
function sandboxPolicy(markDirty: boolean): string {
  const policy = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
  };
  return JSON.stringify(markDirty ? { ...policy, dirty: true } : policy);
}

function hookScript(markDirty: boolean): string {
  return markDirty ? "#!/bin/sh\necho dirty\n" : "#!/bin/sh\nexit 0\n";
}

/**
 * Temp git repository with committed, executable setup files, then both
 * files modified (tracked-dirty) like a parent checkout awaiting the
 * preflight's path commit. Also carries a no-op PI_WORKER_COMMAND fixture
 * so a regressed spawn path stays harmless.
 */
async function makeDirtySetupRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "delegate-preflight-"));
  tempDirs.push(repo);
  await execFileAsync("git", ["init", "-q"], gitOpts(repo));
  await execFileAsync("git", ["config", "user.email", "test@example.com"], gitOpts(repo));
  await execFileAsync("git", ["config", "user.name", "Test"], gitOpts(repo));
  await mkdir(join(repo, CONFIG_DIR_NAME), { recursive: true });
  await writeFile(join(repo, CONFIG_DIR_NAME, "sandbox.json"), sandboxPolicy(false), "utf8");
  await writeFile(join(repo, CONFIG_DIR_NAME, "provision-worktree"), hookScript(false), "utf8");
  await chmod(join(repo, CONFIG_DIR_NAME, "provision-worktree"), 0o755);
  await writeFile(join(repo, "noop-worker.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(repo, "noop-worker.sh"), 0o755);
  await execFileAsync("git", ["add", "."], gitOpts(repo));
  await execFileAsync("git", ["commit", "-qm", "init"], gitOpts(repo));
  // Dirty both tracked setup files; the sandbox policy stays valid so the
  // preflight (pre-fix) reaches its path-commit step instead of refusing.
  await writeFile(join(repo, CONFIG_DIR_NAME, "sandbox.json"), sandboxPolicy(true), "utf8");
  await writeFile(join(repo, CONFIG_DIR_NAME, "provision-worktree"), hookScript(true), "utf8");
  await chmod(join(repo, CONFIG_DIR_NAME, "provision-worktree"), 0o755);
  // A regressed path that reaches spawn must stay harmless and hermetic.
  vi.stubEnv("PI_WORKER_COMMAND", join(repo, "noop-worker.sh"));
  return repo;
}

async function gitHead(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], gitOpts(repo));
  return stdout.trim();
}

/** Porcelain status of exactly the two setup files (empty means committed away). */
async function setupFileStatus(repo: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--", PROVISION_HOOK_RELATIVE, WORKER_SANDBOX_RELATIVE],
    gitOpts(repo),
  );
  return stdout;
}

function makePlan(overrides: Partial<DelegatePlan> = {}): DelegatePlan {
  return {
    workerId: "w-new",
    name: "fresh",
    task: "isolated task",
    model: "test-model",
    thinkingLevel: "medium",
    timeoutMs: 60_000,
    readOnly: false,
    extensionPaths: [],
    wantIsolate: true,
    isolateRequired: false,
    maxWorkers: 1,
    parentSessionId: "session-parent",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
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

function emptyState(): WorkerSessionState {
  return {
    running: new Map(),
    branchWorkers: new Map(),
    reserved: new Map(),
  };
}

function testEvents(): WorkerEvents {
  return { wake: vi.fn(), notify: vi.fn(), onChange: vi.fn(), onActivity: vi.fn() };
}

// --- Tests ---

describe("delegate-preflight", () => {
  beforeEach(() => {
    vi.mocked(runGit).mockClear();
    preflightHook.onStatus = undefined;
  });

  afterEach(async () => {
    preflightHook.onStatus = undefined;
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) await rmLater(dir);
    }
  });

  it("a full-cap refusal with dirty setup files leaves HEAD and setup status unchanged", async () => {
    const repo = await makeDirtySetupRepo();
    const headBefore = await gitHead(repo);
    const statusBefore = await setupFileStatus(repo);
    expect(statusBefore).not.toBe(""); // sanity: setup files start dirty

    const state = emptyState();
    state.branchWorkers.set(
      "w-busy",
      makeRecord({ id: "w-busy", name: "busy", status: "running" }),
    );
    const persist = vi.fn(async () => true);
    const plan = makePlan({ workerId: "w-new", name: "fresh", maxWorkers: 1 });

    await expect(
      startDelegatedWorker({ cwd: repo, plan, state, events: testEvents(), persist }),
    ).rejects.toThrow(/Worker limit reached \(1\/1\)\./);

    expect(await gitHead(repo)).toBe(headBefore); // no setup commit leaked
    expect(await setupFileStatus(repo)).toBe(statusBefore); // files still dirty
    expect(state.reserved.size).toBe(0); // no slot was reserved or leaked
    expect(persist).not.toHaveBeenCalled(); // no failed record for a refusal
    expect(await listRecordFiles(repo)).toHaveLength(0);
  });

  it("a duplicate-name refusal with dirty setup files leaves HEAD and setup status unchanged", async () => {
    const repo = await makeDirtySetupRepo();
    const headBefore = await gitHead(repo);
    const statusBefore = await setupFileStatus(repo);
    expect(statusBefore).not.toBe("");

    const state = emptyState();
    state.branchWorkers.set(
      "w-alpha",
      makeRecord({ id: "w-alpha", name: "alpha", status: "running" }),
    );
    const persist = vi.fn(async () => true);
    const plan = makePlan({ workerId: "w-new", name: "alpha", maxWorkers: 4 });

    await expect(
      startDelegatedWorker({ cwd: repo, plan, state, events: testEvents(), persist }),
    ).rejects.toThrow(/A worker named "alpha" is already running/);

    expect(await gitHead(repo)).toBe(headBefore);
    expect(await setupFileStatus(repo)).toBe(statusBefore);
    expect(state.reserved.size).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(await listRecordFiles(repo)).toHaveLength(0);
  });

  it("holds a slot during preflight so a concurrent limit refusal cannot commit setup files", async () => {
    const repo = await makeDirtySetupRepo();
    const headBefore = await gitHead(repo);
    const statusBefore = await setupFileStatus(repo);
    const state = emptyState();
    const persist = vi.fn(async () => true);
    const firstPlan = makePlan({ workerId: "w-first", name: "first", maxWorkers: 1 });
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let reachedGate: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let reservedAtGate: string | undefined;
    preflightHook.onStatus = async () => {
      reservedAtGate = state.reserved.get(firstPlan.workerId);
      reachedGate();
      await gate;
    };

    const first = startDelegatedWorker({
      cwd: repo,
      plan: firstPlan,
      state,
      events: testEvents(),
      persist,
    });
    await reached;
    try {
      expect(reservedAtGate).toBe("first");
      await expect(
        startDelegatedWorker({
          cwd: repo,
          plan: makePlan({ workerId: "w-second", name: "second", maxWorkers: 1 }),
          state,
          events: testEvents(),
          persist,
        }),
      ).rejects.toThrow(/Worker limit reached \(1\/1\)\./);
      expect(await gitHead(repo)).toBe(headBefore);
      expect(await setupFileStatus(repo)).toBe(statusBefore);
    } finally {
      releaseGate();
      const result = await first.catch(() => undefined);
      if (result) await result.runningWorker.done;
    }
  });
});

// --- Cleanup ---

async function rmLater(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const transient = code === "ENOTEMPTY" || code === "ENOENT" || code === "EBUSY";
      if (!transient || attempt >= 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
