import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autoresearchExtension from "../../extensions/autoresearch/autoresearch.ts";
import {
  CHECKS_TIMEOUT_MS,
  parseMetric,
  runCommand,
} from "../../extensions/autoresearch/src/measure.ts";
import { clearPending } from "../../extensions/autoresearch/src/pending.ts";
import { AUTORESEARCH_PARAMETERS } from "../../extensions/autoresearch/src/schemas.ts";
import { bestEntry, spreadScore } from "../../extensions/autoresearch/src/stats.ts";
import { autoDir, loadConfig, readLog } from "../../extensions/autoresearch/src/store.ts";
import type { RunEntry } from "../../extensions/autoresearch/src/types.ts";
import { cleanGitEnv } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { __resetWidgetStrip, STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const execFileAsync = promisify(execFile);
const gitOpts = (cwd: string) => ({ cwd, env: cleanGitEnv() });

// Pass-through spy on exec so tests can assert the options passed to child
// processes (e.g. the git commit timeout) while everything still really runs.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spied = vi.fn(actual.exec);
  // Node's exec carries a custom promisify symbol that vi.fn drops; reattach
  // an equivalent so promisify(exec) still resolves {stdout, stderr}, while
  // calls keep flowing through the spy so tests can inspect them.
  const promisified = (command: string, options?: Parameters<typeof actual.exec>[1]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      spied(command, options, (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      });
    });
  return {
    ...actual,
    exec: Object.assign(spied, {
      [Symbol.for("nodejs.util.promisify.custom")]: promisified,
    }),
  };
});

async function initGitRepo(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], gitOpts(cwd));
  await execFileAsync("git", ["config", "user.email", "test@example.com"], gitOpts(cwd));
  await execFileAsync("git", ["config", "user.name", "Test"], gitOpts(cwd));
  await writeFile(join(cwd, "code.txt"), "v1\n");
  await writeFile(join(cwd, "metric.txt"), "100\n");
  await execFileAsync("git", ["add", "."], gitOpts(cwd));
  await execFileAsync("git", ["commit", "-qm", "init"], gitOpts(cwd));
}

describe("autoresearch-extension", () => {
  let cwd: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;

  const executeTool = async (params: Record<string, unknown>) => {
    const tool = mockPi.registerTool.mock.calls[0][0];
    return tool.execute("call-1", params as never, undefined, undefined, mockCtx);
  };

  const getEventHandler = (eventType: string, pi: DeepMocked<ExtensionAPI> = mockPi) => {
    for (const call of pi.on.mock.calls) {
      if (call[0] === eventType) return call[1];
    }
    throw new Error(`handler for ${eventType} not found`);
  };

  const initSession = async (extra: Record<string, unknown> = {}) => {
    return executeTool({
      action: "init",
      objective: "Make the code faster",
      metric: "time",
      direction: "lower",
      measure: "cat metric.txt",
      ...extra,
    });
  };

  const runAndLog = async (
    metricValue: string,
    status: "keep" | "discard",
    description: string,
  ) => {
    await writeFile(join(cwd, "code.txt"), `changed for ${description}\n`);
    await writeFile(join(cwd, "metric.txt"), `${metricValue}\n`);
    const run = await executeTool({
      action: "run",
      description,
      hypothesis: "smaller is faster",
    });
    expect(run.details.pending.metric).toBe(Number(metricValue));
    return executeTool({ action: "log", status, description });
  };

  beforeEach(async () => {
    __resetWidgetStrip();
    cwd = await mkdtemp(join(tmpdir(), "autoresearch-test-"));
    await initGitRepo(cwd);
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    await autoresearchExtension(mockPi);
    // Initialize per-turn state the agent_end handler relies on.
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("init refuses to run outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "autoresearch-plain-"));
    try {
      (mockCtx as { cwd: string }).cwd = plain;
      await expect(initSession()).rejects.toThrow(/git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("init records the baseline and writes .pi/autoresearch files", async () => {
    const res = await initSession();
    expect(res.content[0].text).toContain("Baseline: 100");

    const config = await loadConfig(cwd);
    expect(config?.metric).toBe("time");
    expect(config?.stopped).toBeUndefined();
    const entries = await readLog(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("baseline");
    expect(entries[0].metric).toBe(100);

    const stateDir = join(cwd, CONFIG_DIR_NAME, "autoresearch");
    expect(existsSync(join(stateDir, "config.json"))).toBe(true);
    expect(existsSync(join(stateDir, "log.jsonl"))).toBe(true);
    expect(existsSync(join(stateDir, "untracked-snapshot.json"))).toBe(true);
    const prompt = await readFile(join(stateDir, "prompt.md"), "utf8");
    expect(prompt).toContain("Make the code faster");
    expect(existsSync(join(cwd, ".auto"))).toBe(false);

    // Footer status uses the shared themed status line.
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "autoresearch",
      expect.stringContaining("Autoresearch:"),
    );

    // .pi/autoresearch/ is excluded from git locally.
    const exclude = await readFile(join(cwd, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n")).toContain(`${projectStateRelative("autoresearch")}/`);
    expect(exclude.split("\n")).not.toContain(".auto/");
  });

  it("init rejects a second active session", async () => {
    await initSession();
    await expect(initSession()).rejects.toThrow(/already exists|active autoresearch/);
  });

  it("concurrent inits serialize on the config lock so only one campaign wins", async () => {
    // Gate both inits at the worktree probe and stub it to an instant
    // resolve, so they reach the config check-then-save cycle in the same
    // tick. Without the lock both pass the check and the second save
    // clobbers the first campaign (same shape as messenger's concurrent
    // claimIdentity test).
    const measure = await import("../../extensions/autoresearch/src/measure.ts");
    let arrived = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const isGitRepoSpy = vi.spyOn(measure, "isGitRepo").mockResolvedValue(true);
    const changedFilesSpy = vi.spyOn(measure, "changedFiles").mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) releaseGate();
      await gate;
      return { tracked: [], untracked: [] };
    });
    try {
      const results = await Promise.allSettled([
        initSession(),
        initSession({ objective: "Second concurrent objective" }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
      expect(reason.message).toMatch(/active autoresearch session exists/i);

      // The surviving campaign is whole: active, owned by one objective,
      // with a single baseline run — not a blend of both inits.
      const config = await loadConfig(cwd);
      expect(config?.stopped).toBeUndefined();
      expect(["Make the code faster", "Second concurrent objective"]).toContain(config?.objective);
      expect((await readLog(cwd)).map((entry) => entry.status)).toEqual(["baseline"]);
    } finally {
      isGitRepoSpy.mockRestore();
      changedFilesSpy.mockRestore();
    }
  });

  it("init rejects tracked pre-existing work without writing campaign state", async () => {
    // A modified tracked file predates the campaign; a later discard must not
    // reset it and a later keep must not commit it.
    await writeFile(join(cwd, "code.txt"), "pre-existing edit\n");

    await expect(initSession()).rejects.toThrow(/clean worktree/i);

    // The pre-existing edit is preserved and no state was written.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("pre-existing edit\n");
    expect(existsSync(join(cwd, CONFIG_DIR_NAME, "autoresearch"))).toBe(false);
    const exclude = await readFile(join(cwd, ".git/info/exclude"), "utf8").catch(() => "");
    expect(exclude).not.toContain(`${projectStateRelative("autoresearch")}/`);
  });

  it("init rejects a tracked config-dir file that is dirty", async () => {
    // A tracked file under the config dir predates the campaign: letting init
    // proceed would let a later discard restore it from HEAD and destroy it.
    const trackedConfig = join(cwd, CONFIG_DIR_NAME, "autoresearch", "config.json");
    await mkdir(join(cwd, CONFIG_DIR_NAME, "autoresearch"), { recursive: true });
    await writeFile(trackedConfig, "{}\n");
    // -f: a global gitignore commonly lists the config dir, but the point of
    // this test is a TRACKED file under it.
    await execFileAsync("git", ["add", "-f", "."], gitOpts(cwd));
    await execFileAsync("git", ["commit", "-qm", "track a config-dir file"], gitOpts(cwd));
    await writeFile(trackedConfig, "edited\n");

    await expect(initSession()).rejects.toThrow(/clean worktree/i);

    expect(await readFile(trackedConfig, "utf8")).toBe("edited\n");
    expect(existsSync(join(cwd, CONFIG_DIR_NAME, "autoresearch", "log.jsonl"))).toBe(false);
  });

  it("keep does not stage a tracked file that was dirty before the campaign", async () => {
    await initSession();
    await seedDirtyAtInit(cwd, ["code.txt"]);
    await writeFile(join(cwd, "code.txt"), "foreign edit\n");
    await writeFile(join(cwd, "metric.txt"), "90\n");

    await executeTool({ action: "run", description: "experiment on metric only" });
    const log = await executeTool({
      action: "log",
      status: "keep",
      description: "experiment on metric only",
    });
    expect(log.content[0].text).toContain("Kept (commit");

    const shown = await execFileAsync(
      "git",
      ["show", "--pretty=", "--name-only", "HEAD"],
      gitOpts(cwd),
    );
    const committed = shown.stdout.split("\n").filter(Boolean);
    expect(committed).toContain("metric.txt");
    expect(committed).not.toContain("code.txt");
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("foreign edit\n");
  });

  it("keep does not stage project state created mid-campaign", async () => {
    await initSession();
    await writeFile(join(cwd, "metric.txt"), "90\n");

    await executeTool({ action: "run", description: "experiment that makes state" });
    // Infrastructure, not an experiment change: the sandbox policy file is
    // project state under the config dir and must never enter a commit.
    await writeFile(join(cwd, CONFIG_DIR_NAME, "sandbox.json"), "{}\n");
    const log = await executeTool({
      action: "log",
      status: "keep",
      description: "experiment that makes state",
    });
    expect(log.content[0].text).toContain("Kept (commit");

    const shown = await execFileAsync(
      "git",
      ["show", "--pretty=", "--name-only", "HEAD"],
      gitOpts(cwd),
    );
    const committed = shown.stdout.split("\n").filter(Boolean);
    expect(committed).toContain("metric.txt");
    expect(committed).not.toContain(join(CONFIG_DIR_NAME, "sandbox.json"));
  });

  it("discard does not restore a tracked file that was dirty before the campaign", async () => {
    await initSession();
    await seedDirtyAtInit(cwd, ["code.txt"]);
    await writeFile(join(cwd, "code.txt"), "foreign edit\n");
    await writeFile(join(cwd, "metric.txt"), "120\n");

    await executeTool({ action: "run", description: "slower experiment" });
    await executeTool({ action: "log", status: "discard", description: "slower experiment" });

    // The experiment's tracked change is reverted; the foreign edit survives.
    expect(await readFile(join(cwd, "metric.txt"), "utf8")).toContain("100");
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("foreign edit\n");
  });

  it("init refuses to overwrite a corrupt config.json and reports the path", async () => {
    const stateDir = join(cwd, CONFIG_DIR_NAME, "autoresearch");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), "{ not json");

    await expect(initSession()).rejects.toThrow(/config\.json/);
    expect(await readFile(join(stateDir, "config.json"), "utf8")).toBe("{ not json");
  });

  it("a config.json with a foreign shape is treated as absent, not corrupt", async () => {
    const stateDir = join(cwd, CONFIG_DIR_NAME, "autoresearch");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ hello: "world" }));

    const status = await executeTool({ action: "status" });
    expect(status.content[0].text).toContain("No autoresearch session");
  });

  it("a missing config.json still reads as no session", async () => {
    await initSession();
    await rm(join(cwd, CONFIG_DIR_NAME, "autoresearch", "config.json"));

    const status = await executeTool({ action: "status" });
    expect(status.content[0].text).toContain("No autoresearch session");
  });

  it("an unreadable config.json throws with the file path", async () => {
    // Root ignores file permissions, making the chmod scenario ineffective.
    if (process.getuid?.() === 0) return;
    await initSession();
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "config.json");
    await chmod(path, 0o000);
    try {
      await expect(executeTool({ action: "status" })).rejects.toThrow(/config\.json/);
    } finally {
      await chmod(path, 0o644);
    }
  });

  it("init ignores untracked state under .pi/", async () => {
    // Other pi extensions park their state under .pi/; it must not block init.
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    await writeFile(join(cwd, CONFIG_DIR_NAME, "missions", "x.json"), "{}");

    const res = await initSession();
    expect(res.content[0].text).toContain("Baseline: 100");
    expect(existsSync(join(cwd, CONFIG_DIR_NAME, "missions", "x.json"))).toBe(true);
  });

  it("init rejects pre-existing untracked work", async () => {
    await writeFile(join(cwd, "scratch.txt"), "agent state that must survive\n");

    await expect(initSession()).rejects.toThrow(/clean worktree/i);

    expect(await readFile(join(cwd, "scratch.txt"), "utf8")).toBe(
      "agent state that must survive\n",
    );
    expect(existsSync(join(cwd, CONFIG_DIR_NAME, "autoresearch"))).toBe(false);
  });

  it("keep commits the change and records the improvement", async () => {
    await initSession();
    const log = await runAndLog("90", "keep", "narrow the loop");

    expect(log.content[0].text).toContain("Kept (commit");
    const entries = await readLog(cwd);
    const kept = entries.find((e) => e.status === "keep");
    expect(kept?.metric).toBe(90);
    expect(kept?.commit).toBeTruthy();
    expect(await readFile(join(cwd, "metric.txt"), "utf8")).toContain("90");

    const gitLog = await execFileAsync("git", ["log", "--oneline"], { cwd });
    expect(gitLog.stdout).toContain("autoresearch");
  });

  it("discard reverts the current experiment without removing baseline files", async () => {
    // The measure command creates a cache file alongside the metric; the
    // campaign baseline must protect it from later discards.
    await initSession({ measure: "touch baseline-cache.txt; cat metric.txt" });
    expect(existsSync(join(cwd, "baseline-cache.txt"))).toBe(true);

    await writeFile(join(cwd, "code.txt"), "experiment edit\n");
    await writeFile(join(cwd, "experiment-only.txt"), "made by the experiment\n");
    await executeTool({ action: "run", description: "adds a file", hypothesis: "h" });
    await executeTool({ action: "log", status: "discard", description: "adds a file" });

    expect(existsSync(join(cwd, "baseline-cache.txt"))).toBe(true);
    expect(existsSync(join(cwd, "experiment-only.txt"))).toBe(false);
    // Tracked files revert to the committed experiment base.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
  });

  it("discard removes a new file staged during the experiment", async () => {
    await initSession();
    await writeFile(join(cwd, "staged-experiment.txt"), "temporary\n");
    await execFileAsync("git", ["add", "staged-experiment.txt"], gitOpts(cwd));

    await executeTool({ action: "run", description: "staged file" });
    await executeTool({ action: "log", status: "discard", description: "staged file" });

    expect(existsSync(join(cwd, "staged-experiment.txt"))).toBe(false);
    const status = await execFileAsync("git", ["status", "--porcelain"], gitOpts(cwd));
    expect(status.stdout).toBe("");
  });

  it("keep commits only the current experiment changes", async () => {
    // The baseline contains the measure command's side artifact; a keep must
    // not absorb it even though the experiment ran the same command again.
    await initSession({ measure: "touch unrelated.txt; cat metric.txt" });
    expect(existsSync(join(cwd, "unrelated.txt"))).toBe(true);

    await writeFile(join(cwd, "code.txt"), "second experiment\n");
    await writeFile(join(cwd, "experiment.txt"), "created by second experiment\n");
    await executeTool({ action: "run", description: "second experiment" });
    const log = await executeTool({
      action: "log",
      status: "keep",
      description: "second experiment",
    });
    expect(log.content[0].text).toContain("Kept (commit");

    const shown = await execFileAsync(
      "git",
      ["show", "--pretty=", "--name-only", "HEAD"],
      gitOpts(cwd),
    );
    const committed = shown.stdout.split("\n").filter(Boolean);
    expect(committed).toContain("code.txt");
    expect(committed).toContain("experiment.txt");
    expect(committed).not.toContain("unrelated.txt");
    expect(existsSync(join(cwd, "unrelated.txt"))).toBe(true);
  });

  it("session reload restores a pending experiment so log can finish it", async () => {
    await initSession();
    await writeFile(join(cwd, "code.txt"), "pending edit\n");
    await executeTool({ action: "run", description: "pending experiment" });
    const pendingPath = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    // The file must be parseable JSON so a reloaded instance can rehydrate it.
    const pendingOnDisk = JSON.parse(await readFile(pendingPath, "utf8")) as {
      description?: string;
    };
    expect(pendingOnDisk.description).toBe("pending experiment");

    // Simulate a reload: a fresh extension instance over the same cwd.
    const mockPi2 = createMockPi() as DeepMocked<ExtensionAPI>;
    const mockCtx2 = createMockContext();
    (mockCtx2 as { cwd: string }).cwd = cwd;
    await autoresearchExtension(mockPi2);
    await getEventHandler("session_start", mockPi2)(
      { type: "session_start", reason: "reload" },
      mockCtx2,
    );
    const tool2 = mockPi2.registerTool.mock.calls[0][0];
    const log = await tool2.execute(
      "call-relog",
      { action: "log", status: "discard", description: "pending experiment" } as never,
      undefined,
      undefined,
      mockCtx2,
    );

    expect(log.content[0].text).toContain("Discarded");
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json"))).toBe(false);
  });

  it("session start clears stale in-memory pending when the file is gone", async () => {
    // Instance A holds a pending run in memory; another instance resolves it
    // and removes pending.json from disk. A's next session_start must drop
    // its stale copy, or A refuses every new run as "already pending".
    await initSession();
    await writeFile(join(cwd, "code.txt"), "stale pending edit\n");
    await executeTool({ action: "run", description: "stale pending experiment" });
    const pendingPath = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);

    // The other instance resolves the run and clears the file.
    await writeFile(join(cwd, "code.txt"), "v1\n");
    await rm(pendingPath);

    await getEventHandler("session_start", mockPi)(
      { type: "session_start", reason: "reload" },
      mockCtx,
    );

    await expect(
      executeTool({ action: "run", description: "fresh experiment" }),
    ).resolves.toMatchObject({
      content: [expect.objectContaining({ type: "text" })],
    });
    expect(existsSync(pendingPath)).toBe(true);
  });

  it("session shutdown clears the status line and lifecycle state", async () => {
    await initSession();
    await writeFile(join(cwd, "code.txt"), "pending edit\n");
    await executeTool({ action: "run", description: "pending experiment" });

    const shutdown = getEventHandler("session_shutdown");
    await shutdown({ type: "session_shutdown", reason: "reload" }, mockCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("autoresearch", undefined);
    expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
    expect(mockPi.events.emit).toHaveBeenLastCalledWith("autoresearch:state", {
      active: false,
      iterations: 0,
    });

    // Even without a session_start, running again must rehydrate and refuse.
    await expect(executeTool({ action: "run", description: "again" })).rejects.toThrow(/pending/i);
  });

  it("status reports without an active campaign and after stop", async () => {
    const fresh = await executeTool({ action: "status" });
    expect(fresh.content[0].text).toContain("No autoresearch session");
    expect(fresh.details.active).toBe(false);

    await initSession();
    await executeTool({ action: "stop" });
    const stopped = await executeTool({ action: "status" });
    expect(stopped.content[0].text).toContain("STOPPED");
    expect(stopped.details.summary.active).toBe(false);
  });

  it("re-init refuses to overwrite a corrupt pending file from a stopped campaign", async () => {
    await initSession();
    await executeTool({ action: "stop" });
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    const logPath = join(cwd, CONFIG_DIR_NAME, "autoresearch", "log.jsonl");
    const originalLog = await readFile(logPath, "utf8");
    await writeFile(path, "{ invalid");

    await expect(initSession()).rejects.toThrow(/pending\.json.*corrupt/i);
    expect(await readFile(path, "utf8")).toBe("{ invalid");
    expect(await readFile(logPath, "utf8")).toBe(originalLog);
    expect((await loadConfig(cwd))?.stopped).toBe(true);
  });

  it("re-init after stop starts a fresh campaign log", async () => {
    await initSession();
    await runAndLog("90", "keep", "first campaign");
    await executeTool({ action: "stop" });

    await initSession();
    const entries = await readLog(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("baseline");
    expect(entries[0].metric).toBe(90);

    // The previous campaign log is archived, not merged into the new one.
    const archived = await readdir(join(cwd, CONFIG_DIR_NAME, "autoresearch"));
    expect(archived.some((name) => name.startsWith("log.") && name !== "log.jsonl")).toBe(true);
  });

  it("init works in a linked git worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "autoresearch-wt-"));
    const wt = join(parent, "wt");
    try {
      await execFileAsync("git", ["worktree", "add", "--detach", "-q", wt, "HEAD"], gitOpts(cwd));
      (mockCtx as { cwd: string }).cwd = wt;

      const res = await initSession();
      expect(res.content[0].text).toContain("Baseline: 100");

      const excludePath = (
        await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], gitOpts(wt))
      ).stdout.trim();
      const exclude = await readFile(excludePath, "utf8");
      expect(exclude.split("\n")).toContain(`${projectStateRelative("autoresearch")}/`);
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", wt], gitOpts(cwd)).catch(
        () => {},
      );
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("parses retained metric output even when the measure command exits non-zero", async () => {
    const res = await initSession({ measure: "printf 'METRIC time=42\\n'; exit 3" });

    expect(res.content[0].text).toContain("Baseline: 42");
    let entries = await readLog(cwd);
    expect(entries[0].status).toBe("baseline");
    expect(entries[0].metric).toBe(42);

    const run = await executeTool({ action: "run", description: "failed command with result" });
    expect(run.content[0].text).toContain("time=42");
    await executeTool({ action: "log", status: "discard" });
    entries = await readLog(cwd);
    expect(entries[1].metric).toBe(42);
  });

  it("does not mistake a process error code for a reported metric", async () => {
    const res = await initSession({ measure: "exit 3" });

    expect(res.content[0].text).toContain("unparseable");
    const entries = await readLog(cwd);
    expect(entries[0].status).toBe("invalid");
    expect(entries[0].metric).toBeUndefined();
  });

  it("keeps stdout and stderr separate when parsing the metric", async () => {
    await initSession({ measure: "printf 'time=17'; printf '0000 errors' >&2" });

    const entries = await readLog(cwd);
    expect(entries[0].metric).toBe(17);
  });

  it("discard reverts the working tree", async () => {
    await initSession();
    // First establish a committed state that differs from baseline.
    await runAndLog("90", "keep", "keep this");
    const log = await runAndLog("120", "discard", "too slow");

    expect(log.content[0].text).toContain("Discarded");
    expect(await readFile(join(cwd, "metric.txt"), "utf8")).toContain("90");
    const entries = await readLog(cwd);
    expect(entries.filter((e) => e.status === "discard")).toHaveLength(1);
  });

  it("failing checks revert automatically and log checks_failed", async () => {
    await initSession({ checks: "! grep -q BROKEN code.txt" });
    await writeFile(join(cwd, "code.txt"), "BROKEN\n");
    await writeFile(join(cwd, "metric.txt"), "50\n");

    const run = await executeTool({ action: "run", description: "cheat the metric" });
    expect(run.content[0].text).toContain("CHECKS FAILED");
    // Working tree reverted to committed state.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
    const entries = await readLog(cwd);
    expect(entries[entries.length - 1].status).toBe("checks_failed");
  });

  it("measure failure tells the agent to discard the pending run before fixing", async () => {
    await initSession();
    await writeFile(join(cwd, "metric.txt"), "not a number\n");

    const run = await executeTool({ action: "run", description: "unparseable metric" });
    expect(run.content[0].text).toContain("status=discard");
    expect(run.content[0].text).toContain("reverts the working-tree changes");
  });

  it("corrupt pending JSON blocks run, log, stop, and status without changing experiment files", async () => {
    await initSession();
    await writeFile(join(cwd, "code.txt"), "orphaned experiment\n");
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    await writeFile(path, "{ invalid");
    for (const action of ["run", "log", "stop", "status"] as const) {
      await expect(executeTool({ action, description: "next", status: "discard" })).rejects.toThrow(
        /pending\.json.*corrupt/i,
      );
    }
    expect(await readFile(path, "utf8")).toBe("{ invalid");
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("orphaned experiment\n");
    expect((await loadConfig(cwd))?.stopped).toBeUndefined();
  });

  it.each([
    "null",
    "{}",
    '{"run":2,"description":"test","durationMs":null}',
    '{"run":2,"description":"test","durationMs":4,"metric":"not a number"}',
  ])("rejects wrong-shaped pending state: %s", async (content) => {
    await initSession();
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    await writeFile(path, content);
    await expect(executeTool({ action: "run", description: "next" })).rejects.toThrow(
      /pending\.json.*corrupt/i,
    );
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("unreadable pending state fails closed rather than becoming a missing run", async () => {
    if (process.getuid?.() === 0) return;
    await initSession();
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    await writeFile(path, '{"run":2,"description":"test","durationMs":1}');
    await chmod(path, 0o000);
    try {
      await expect(executeTool({ action: "run", description: "next" })).rejects.toThrow(
        /pending\.json.*unreadable/i,
      );
    } finally {
      await chmod(path, 0o644);
    }
  });

  it("detects damaged pending state even when a measurement is cached in memory", async () => {
    await initSession();
    await executeTool({ action: "run", description: "cached" });
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    await writeFile(path, "{ invalid");
    await expect(executeTool({ action: "log", status: "discard" })).rejects.toThrow(
      /pending\.json.*corrupt/i,
    );
  });

  it("a second run while a measurement is pending still throws", async () => {
    await initSession();
    await executeTool({ action: "run", description: "first run" });
    await expect(executeTool({ action: "run", description: "second run" })).rejects.toThrow(
      "A run is already pending. Log it (action=log) before running again.",
    );
  });

  it("keep with a corrupt untracked snapshot fails loudly and does not commit", async () => {
    await initSession();
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "autoresearch", "untracked-snapshot.json"),
      "{ corrupt",
    );
    await writeFile(join(cwd, "code.txt"), "experiment edit\n");
    await executeTool({ action: "run", description: "corrupt snapshot" });

    await expect(
      executeTool({ action: "log", status: "keep", description: "corrupt snapshot" }),
    ).rejects.toThrow(/untracked-snapshot\.json/);

    // No commit was created.
    const gitLog = await execFileAsync("git", ["log", "--oneline"], gitOpts(cwd));
    expect(gitLog.stdout).not.toContain("autoresearch");
  });

  it("keep with a missing untracked snapshot keeps legacy behavior", async () => {
    await initSession();
    await rm(join(cwd, CONFIG_DIR_NAME, "autoresearch", "untracked-snapshot.json"));
    await writeFile(join(cwd, "code.txt"), "legacy edit\n");
    await writeFile(join(cwd, "legacy-new.txt"), "created during experiment\n");
    await executeTool({ action: "run", description: "legacy keep" });

    const log = await executeTool({ action: "log", status: "keep", description: "legacy keep" });
    expect(log.content[0].text).toContain("Kept (commit");

    // Legacy: with no snapshot, every untracked file is fair game for a keep.
    const shown = await execFileAsync(
      "git",
      ["show", "--pretty=", "--name-only", "HEAD"],
      gitOpts(cwd),
    );
    const committed = shown.stdout.split("\n").filter(Boolean);
    expect(committed).toContain("code.txt");
    expect(committed).toContain("legacy-new.txt");
  });

  it("log with no pending run throws", async () => {
    await initSession();
    await expect(executeTool({ action: "log", status: "keep" })).rejects.toThrow(/Nothing to log/);
  });

  it("log with an invalid status throws", async () => {
    await initSession();
    await writeFile(join(cwd, "code.txt"), "changed\n");
    await executeTool({ action: "run", description: "valid run" });
    await expect(executeTool({ action: "log", status: "bogus" })).rejects.toThrow(
      /log requires status/,
    );
  });

  it("stop without a campaign reports the no-session error", async () => {
    await expect(executeTool({ action: "stop" })).rejects.toThrow(/No autoresearch session/);
  });

  it("keep with no experiment changes throws", async () => {
    await initSession();
    await executeTool({ action: "run", description: "no edits" });
    await expect(
      executeTool({ action: "log", status: "keep", description: "no edits" }),
    ).rejects.toThrow("No experiment changes to commit.");
  });

  it("git commit runs with a timeout so a hanging hook cannot block the tool", async () => {
    await initSession();
    await runAndLog("90", "keep", "timed commit");

    const commitCall = vi
      .mocked(exec)
      .mock.calls.find((call) => String(call[0]).includes("git commit"));
    expect(commitCall).toBeDefined();
    const options = commitCall?.[1] as unknown as { timeout?: number; maxBuffer?: number };
    expect(options.timeout).toBe(CHECKS_TIMEOUT_MS);
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
  });

  it("interactive input does not reset the continuation guard", async () => {
    await initSession();
    const agentEnd = getEventHandler("agent_end");
    const input = getEventHandler("input");

    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Interactive input is the user typing, not our follow-up arriving; the
    // queued continuation must stay queued.
    await input({ type: "input", text: "", source: "interactive" }, mockCtx);
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("git operations are immune to inherited GIT_INDEX_FILE (lint-staged)", async () => {
    await initSession();
    // Simulate lint-staged's environment: its temp index belongs to the outer
    // repo and must never leak into the campaign repo's commits.
    vi.stubEnv("GIT_INDEX_FILE", "/tmp/definitely-not-a-real-index");
    const log = await runAndLog("90", "keep", "env-poison keep");
    expect(log.content[0].text).toContain("Kept (commit");
  });

  it("reports a descriptive spread score once enough kept runs exist", async () => {
    await initSession();
    await runAndLog("99.0", "keep", "big improvement");
    await runAndLog("101.0", "discard", "noisy regression");
    const log = await runAndLog("99.96", "keep", "tiny change");
    // Spread is descriptive (|best - baseline| relative to run-to-run
    // variation); it must not claim whether the result is real or noise.
    expect(log.content[0].text).toMatch(/Spread: [0-9.]+x MAD/);
    expect(log.content[0].text).not.toMatch(/[Cc]onfidence|likely real|within noise|marginal/);
  });

  it.each([
    { content: "{ invalid\n", line: 2 },
    { content: '{"run":"bad","status":"keep","description":"foreign","at":1}\n', line: 2 },
  ])(
    "rejects damaged log entries with a line number without appending",
    async ({ content, line }) => {
      await initSession();
      const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "log.jsonl");
      const original = await readFile(path, "utf8");
      await writeFile(path, original + content);
      await expect(executeTool({ action: "status" })).rejects.toThrow(
        new RegExp(`log\\.jsonl.*line ${line}.*corrupt`, "i"),
      );
      await expect(executeTool({ action: "run", description: "next" })).rejects.toThrow(
        /log\.jsonl/,
      );
      expect(await readFile(path, "utf8")).toBe(original + content);
    },
  );

  it("a damaged log blocks keep, discard, stop, and failing checks before any mutation", async () => {
    await initSession({ checks: "! grep -q BROKEN code.txt" });
    await writeFile(join(cwd, "code.txt"), "pending edit\n");
    await executeTool({ action: "run", description: "pending" });
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "log.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}{ invalid\n`);
    for (const status of ["keep", "discard"] as const) {
      await expect(executeTool({ action: "log", status })).rejects.toThrow(/log\.jsonl/);
      expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("pending edit\n");
    }
    await expect(executeTool({ action: "stop" })).rejects.toThrow(/log\.jsonl/);
    expect((await loadConfig(cwd))?.stopped).toBeUndefined();
    // Clear the cached pending slot; a damaged log must also block a
    // checks-failed run before it reverts the working tree.
    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "reload" },
      mockCtx,
    );
    await rm(join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json"));
    await writeFile(join(cwd, "code.txt"), "BROKEN\n");
    await expect(executeTool({ action: "run", description: "bad checks" })).rejects.toThrow(
      /log\.jsonl/,
    );
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("BROKEN\n");
  });

  it("the headline best never comes from a discarded run", async () => {
    await initSession();
    await runAndLog("99.0", "keep", "kept improvement");
    // A discarded run measured "better" but its changes were reverted: the
    // working tree does not contain that result.
    await runAndLog("50.0", "discard", "too good, reverted");
    const log = await runAndLog("99.9", "discard", "tiny change");
    expect(log.content[0].text).toContain("Best: 99");
    expect(log.content[0].text).not.toContain("Best: 50");
  });

  it("a kept regression cannot displace the baseline as the headline best", async () => {
    await initSession();
    await runAndLog("120", "keep", "kept regression");
    const log = await runAndLog("119", "keep", "another kept regression");
    expect(log.content[0].text).toContain("Best: 100 (run 1)");
    expect(log.content[0].text).not.toContain("Best: 120");
  });

  it("iteration cap stops the loop", async () => {
    await initSession({ maxIterations: 1 });
    const log = await runAndLog("90", "keep", "one change");
    expect(log.details.stopped).toBe(true);
    expect((await loadConfig(cwd))?.stopped).toBe(true);

    const agentEnd = getEventHandler("agent_end");
    mockPi.sendUserMessage.mockClear();
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("agent_end continues the loop while active", async () => {
    await initSession();
    const agentEnd = getEventHandler("agent_end");
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(`Re-read ${projectStateRelative("autoresearch")}/prompt.md`),
      { deliverAs: "followUp" },
    );
    expect(mockPi.sendUserMessage.mock.calls[0][0]).toContain(
      `${projectStateRelative("autoresearch")}/log.jsonl`,
    );
    expect(mockPi.sendUserMessage.mock.calls[0][0]).not.toContain(".auto/");
  });

  it("init stamps the owning session id in the config", async () => {
    mockCtx.sessionManager.getSessionId = vi.fn(() => "session-A");
    await initSession();
    expect((await loadConfig(cwd))?.ownerSessionId).toBe("session-A");
  });

  it("a session that does not own the campaign stays silent on agent_end", async () => {
    mockCtx.sessionManager.getSessionId = vi.fn(() => "session-A");
    await initSession();

    // A second session over the same project state: fresh instance, fresh id.
    const mockPi2 = createMockPi() as DeepMocked<ExtensionAPI>;
    const mockCtx2 = createMockContext();
    (mockCtx2 as { cwd: string }).cwd = cwd;
    mockCtx2.sessionManager.getSessionId = vi.fn(() => "session-B");
    await autoresearchExtension(mockPi2);
    await getEventHandler("session_start", mockPi2)(
      { type: "session_start", reason: "startup" },
      mockCtx2,
    );

    // Single-session UI: the non-owner publishes CLEARED state (no widget, no
    // footer status) — campaign state is visible only to the owning session.
    expect(mockCtx2.ui.setStatus).toHaveBeenCalledWith("autoresearch", undefined);
    expect(mockCtx2.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, undefined);
    expect(mockPi2.events.emit).toHaveBeenCalledWith(
      "autoresearch:state",
      expect.objectContaining({ active: false }),
    );

    // But the continuation loop must never drive this session.
    await getEventHandler("agent_end", mockPi2)({ type: "agent_end", messages: [] }, mockCtx2);
    expect(mockPi2.sendUserMessage).not.toHaveBeenCalled();
  });

  it("a non-owner cannot run, log, or stop an owned campaign", async () => {
    mockCtx.sessionManager.getSessionId = vi.fn(() => "session-A");
    await initSession();
    await writeFile(join(cwd, "code.txt"), "owner experiment\n");
    await executeTool({ action: "run", description: "owner run" });

    const foreignCtx = createMockContext();
    (foreignCtx as { cwd: string }).cwd = cwd;
    foreignCtx.sessionManager.getSessionId = vi.fn(() => "session-B");
    const tool = mockPi.registerTool.mock.calls[0][0];
    for (const action of ["run", "log", "stop"] as const) {
      await expect(
        tool.execute(
          "foreign-call",
          { action, description: "foreign run", status: "discard" } as never,
          undefined,
          undefined,
          foreignCtx,
        ),
      ).rejects.toThrow(/owned by another session/i);
    }
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("owner experiment\n");
    expect((await loadConfig(cwd))?.stopped).toBeUndefined();
    expect(await readLog(cwd)).toHaveLength(1);
    await executeTool({ action: "log", status: "discard" });
  });

  it("the owning session keeps driving the continuation loop", async () => {
    mockCtx.sessionManager.getSessionId = vi.fn(() => "session-A");
    await initSession();
    await getEventHandler("agent_end")({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("a legacy config without an owner keeps the any-session behavior", async () => {
    // Pre-ownership campaigns on disk have no ownerSessionId field; any
    // session may continue driving them until they are re-initialized.
    await mkdir(join(cwd, CONFIG_DIR_NAME, "autoresearch"), { recursive: true });
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "autoresearch", "config.json"),
      JSON.stringify({
        objective: "legacy campaign",
        metric: "m",
        direction: "lower",
        measure: "echo 'METRIC m=1'",
        createdAt: Date.now(),
      }),
    );
    const agentEnd = getEventHandler("agent_end");
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("legacy campaigns without an owner allow tool actions from any session", async () => {
    await initSession();
    const path = join(cwd, CONFIG_DIR_NAME, "autoresearch", "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.ownerSessionId = undefined;
    await writeFile(path, JSON.stringify(config));
    mockCtx.sessionManager.getSessionId = vi.fn(() => "unrelated-session");
    await writeFile(join(cwd, "code.txt"), "legacy edit\n");
    await executeTool({ action: "run", description: "legacy run" });
    await executeTool({ action: "log", status: "discard" });
    await executeTool({ action: "stop" });
    expect((await loadConfig(cwd))?.stopped).toBe(true);
  });

  it("stops after repeated stalls with no new experiments", async () => {
    await initSession();
    const agentEnd = getEventHandler("agent_end");
    const input = getEventHandler("input");

    // Two consecutive continuations with zero tool activity → stop.
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    await input({ type: "input", text: "", source: "extension" }, mockCtx);
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    await input({ type: "input", text: "", source: "extension" }, mockCtx);
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect((await loadConfig(cwd))?.stopped).toBe(true);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("tool activity between continuations prevents a stall stop", async () => {
    // The agent may legitimately interleave other work (mission tasks, user
    // questions) between experiments; only two consecutive continuations
    // with zero autoresearch tool activity should stop the loop.
    await initSession();
    const agentEnd = getEventHandler("agent_end");
    const input = getEventHandler("input");

    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    await input({ type: "input", text: "", source: "extension" }, mockCtx);
    await executeTool({ action: "status" });
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect((await loadConfig(cwd))?.stopped).toBeUndefined();
    await input({ type: "input", text: "", source: "extension" }, mockCtx);
    await agentEnd({ type: "agent_end", messages: [] }, mockCtx);
    expect((await loadConfig(cwd))?.stopped).toBeUndefined();
  });

  it("status and stop act on the stored config", async () => {
    await initSession();
    const status = await executeTool({ action: "status" });
    expect(status.content[0].text).toContain("ACTIVE");

    // Restore a pending measurement across sessions via pending.json.
    await writeFile(join(cwd, "code.txt"), "uncommitted experiment\n");
    await executeTool({ action: "run", description: "pending experiment" });
    const pendingPath = join(cwd, CONFIG_DIR_NAME, "autoresearch", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    const statusWithPending = await executeTool({ action: "status" });
    expect(statusWithPending.content[0].text).toContain("pending experiment");

    const stop = await executeTool({ action: "stop" });
    expect(stop.content[0].text).toContain(`kept in ${projectStateRelative("autoresearch")}/`);
    expect(stop.details.active).toBe(false);
    expect((await loadConfig(cwd))?.stopped).toBe(true);
    expect(existsSync(pendingPath)).toBe(false);
    // Pending changes were reverted on stop.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
  });

  describe("widget", () => {
    function renderLastWidget(width = 160): string[] {
      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      const factory = lastCall[1] as
        | ((tui: unknown, theme: unknown) => { render(w: number): string[] })
        | undefined;
      if (typeof factory !== "function") {
        throw new Error(`expected a widget factory, got ${String(factory)}`);
      }
      return factory(undefined, mockCtx.ui.theme).render(width);
    }

    it("shows the campaign widget from init with the baseline state", async () => {
      await initSession();

      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      expect(lastCall[0]).toBe(STRIP_KEY_ABOVE);
      expect(typeof lastCall[1]).toBe("function");
      const text = renderLastWidget().join("\n");
      expect(text).toContain("Autoresearch");
      expect(text).toContain("it 0");
      // Best starts at the baseline; confidence needs more runs.
      expect(text).toContain("best 100");
      expect(text).not.toContain("conf ");
      expect(text).toContain("run 1 baseline");
    });

    it("updates the widget as runs are logged", async () => {
      await initSession();
      await runAndLog("90", "keep", "faster algorithm");

      const text = renderLastWidget().join("\n");
      expect(text).toContain("it 1");
      expect(text).toContain("best 90");
      expect(text).toContain("run 2 keep: faster algorithm");
    });

    it("clears the widget when the campaign stops but keeps the footer fallback", async () => {
      await initSession();
      await executeTool({ action: "stop" });

      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
      expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("autoresearch", undefined);
    });

    it("clears the widget on session shutdown", async () => {
      await initSession();
      const shutdown = getEventHandler("session_shutdown");
      await shutdown({ type: "session_shutdown", reason: "reload" }, mockCtx);
      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
    });
  });
  it("clearPending surfaces a pending file it cannot delete", async () => {
    // A directory where pending.json belongs: unlink fails with EISDIR, not
    // ENOENT. Only a missing file may be ignored.
    const path = join(autoDir(cwd), "pending.json");
    await mkdir(path, { recursive: true });

    await expect(
      clearPending(
        { toolActivity: 0, lastSeenActivity: 0, continuationQueued: false, idleWakes: 0 },
        cwd,
      ),
    ).rejects.toThrow(/could not be cleared/);
  });
});

describe("autoresearch-units", () => {
  it("schema points notes to the project state directory", () => {
    expect(AUTORESEARCH_PARAMETERS.properties.notes.description).toContain(
      `${projectStateRelative("autoresearch")}/prompt.md`,
    );
  });

  it("parseMetric handles METRIC lines, name=value, and last-number fallback", () => {
    expect(parseMetric("METRIC time=42.5\ndone", "time")).toBe(42.5);
    expect(parseMetric("time=17", "time")).toBe(17);
    expect(parseMetric("build ok in 3 rounds, 125ms total", "time")).toBe(125);
    expect(parseMetric("nothing here", "time")).toBeUndefined();
  });

  it("parseMetric reads the value after the first equals sign, including trailing units", () => {
    expect(parseMetric("METRIC time=42 ms", "time")).toBe(42);
    expect(parseMetric("METRIC size=1.5KB", "size")).toBe(1.5);
    expect(parseMetric("METRIC temp=-4 C", "temp")).toBe(-4);
  });

  it("parseMetric matches the tagged line for the configured metric only", () => {
    expect(parseMetric("METRIC latency=10\nMETRIC memory=500", "memory")).toBe(500);
    expect(parseMetric("METRIC memory=500\nMETRIC latency=10", "latency")).toBe(10);
  });

  it("parseMetric skips tagged lines that merely contain or extend the metric name", () => {
    expect(parseMetric("METRIC latencyness=99\nMETRIC latency=20", "latency")).toBe(20);
    expect(parseMetric("METRIC LATENCY=10\nMETRIC latency=20", "latency")).toBe(20);
  });

  it("parseMetric still reads the plain name=value form and the no-tag fallback", () => {
    expect(parseMetric("latency=10", "latency")).toBe(10);
    // Only unrelated tagged lines: no guess is made, the run stays unmeasured.
    expect(parseMetric("METRIC memory=500\nMETRIC other=7", "latency")).toBeUndefined();
  });

  it("parseMetric falls back to a bare number only when no METRIC lines exist", () => {
    expect(parseMetric("METRIC memory=500\nMETRIC other=1", "latency")).toBeUndefined();
    expect(parseMetric("12.5", "latency")).toBe(12.5);
  });

  it("runCommand returns trimmed combined output as both output and metric output", async () => {
    const out = await runCommand("printf 'METRIC m=1'; printf 'warn' >&2", process.cwd(), 10_000);

    expect(out.ok).toBe(true);
    expect(out.metricOutput).toBe("METRIC m=1\nwarn");
    expect(out.output).toBe(out.metricOutput);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runCommand keeps the process error out of metricOutput and appends it to output", async () => {
    const out = await runCommand(
      "printf 'METRIC m=2'; printf 'boom' >&2; exit 3",
      process.cwd(),
      10_000,
    );

    expect(out.ok).toBe(false);
    expect(out.metricOutput).toBe("METRIC m=2\nboom");
    expect(out.output).toContain("METRIC m=2\nboom");
    expect(out.output).toContain("Command failed");
  });

  it("bestEntry respects direction", () => {
    const entries: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 10 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 80 },
      { run: 3, at: 3, status: "discard", description: "c", metric: 90 },
    ];
    expect(bestEntry(entries, "lower")?.run).toBe(1);
    expect(bestEntry(entries, "higher")?.run).toBe(3);
  });

  it("spread score is undefined under 3 measured runs", () => {
    const few: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 100 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 50 },
    ];
    expect(spreadScore(few, "lower")).toBeUndefined();

    const noisy: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 100 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 99.9 },
      { run: 3, at: 3, status: "keep", description: "d", metric: 100.1 },
    ];
    const spread = spreadScore(noisy, "lower");
    expect(spread).toBeDefined();
    expect(spread ?? 0).toBeGreaterThan(0);
  });

  it("spread score uses baseline plus kept runs only", () => {
    const baselineAndKept: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 100 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 98 },
      { run: 3, at: 3, status: "keep", description: "d", metric: 99 },
    ];
    // A discarded outlier must not inflate the observed variation: the score
    // with it present equals the score of the kept set alone.
    const withDiscardedOutlier: RunEntry[] = [
      ...baselineAndKept,
      { run: 4, at: 4, status: "discard", description: "c", metric: 10 },
    ];
    expect(spreadScore(withDiscardedOutlier, "lower")).toBe(spreadScore(baselineAndKept, "lower"));
  });
});

/** Rewrite the campaign config to record tracked files that were already
 * dirty when the campaign started. A normal init refuses to start on dirty
 * tracked files, so tests seed the defensive record directly. */
async function seedDirtyAtInit(dir: string, paths: string[]): Promise<void> {
  const path = join(dir, CONFIG_DIR_NAME, "autoresearch", "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config.dirtyAtInit = paths;
  await writeFile(path, JSON.stringify(config));
}
