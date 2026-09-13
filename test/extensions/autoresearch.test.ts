import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import autoresearchExtension from "../../extensions/autoresearch/autoresearch.ts";
import { parseMetric } from "../../extensions/autoresearch/src/measure.ts";
import { AUTORESEARCH_PARAMETERS } from "../../extensions/autoresearch/src/schemas.ts";
import { bestEntry, confidence } from "../../extensions/autoresearch/src/stats.ts";
import { loadConfig, readLog } from "../../extensions/autoresearch/src/store.ts";
import type { RunEntry } from "../../extensions/autoresearch/src/types.ts";
import { cleanGitEnv } from "../../lib/git.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const execFileAsync = promisify(execFile);
const gitOpts = (cwd: string) => ({ cwd, env: cleanGitEnv() });

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

    const stateDir = join(cwd, ".pi", "autoresearch");
    expect(existsSync(join(stateDir, "config.json"))).toBe(true);
    expect(existsSync(join(stateDir, "log.jsonl"))).toBe(true);
    expect(existsSync(join(stateDir, "untracked-snapshot.json"))).toBe(true);
    const prompt = await readFile(join(stateDir, "prompt.md"), "utf8");
    expect(prompt).toContain("Make the code faster");
    expect(existsSync(join(cwd, ".auto"))).toBe(false);

    // .pi/autoresearch/ is excluded from git locally.
    const exclude = await readFile(join(cwd, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".pi/autoresearch/");
    expect(exclude.split("\n")).not.toContain(".auto/");
  });

  it("init rejects a second active session", async () => {
    await initSession();
    await expect(initSession()).rejects.toThrow(/already exists|active autoresearch/);
  });

  it("init rejects tracked pre-existing work without writing campaign state", async () => {
    // A modified tracked file predates the campaign; a later discard must not
    // reset it and a later keep must not commit it.
    await writeFile(join(cwd, "code.txt"), "pre-existing edit\n");

    await expect(initSession()).rejects.toThrow(/clean worktree/i);

    // The pre-existing edit is preserved and no state was written.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("pre-existing edit\n");
    expect(existsSync(join(cwd, ".pi", "autoresearch"))).toBe(false);
    const exclude = await readFile(join(cwd, ".git/info/exclude"), "utf8").catch(() => "");
    expect(exclude).not.toContain(".pi/autoresearch/");
  });

  it("init rejects pre-existing untracked work", async () => {
    await writeFile(join(cwd, "scratch.txt"), "agent state that must survive\n");

    await expect(initSession()).rejects.toThrow(/clean worktree/i);

    expect(await readFile(join(cwd, "scratch.txt"), "utf8")).toBe(
      "agent state that must survive\n",
    );
    expect(existsSync(join(cwd, ".pi", "autoresearch"))).toBe(false);
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
    expect(existsSync(join(cwd, ".pi", "autoresearch", "pending.json"))).toBe(true);

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
    expect(existsSync(join(cwd, ".pi", "autoresearch", "pending.json"))).toBe(false);
  });

  it("session shutdown clears the status line and lifecycle state", async () => {
    await initSession();
    await writeFile(join(cwd, "code.txt"), "pending edit\n");
    await executeTool({ action: "run", description: "pending experiment" });

    const shutdown = getEventHandler("session_shutdown");
    await shutdown({ type: "session_shutdown", reason: "reload" }, mockCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("autoresearch", undefined);
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
    const archived = await readdir(join(cwd, ".pi", "autoresearch"));
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
      expect(exclude.split("\n")).toContain(".pi/autoresearch/");
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

  it("git operations are immune to inherited GIT_INDEX_FILE (lint-staged)", async () => {
    await initSession();
    // Simulate lint-staged's environment: its temp index belongs to the outer
    // repo and must never leak into the campaign repo's commits.
    const oldIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = "/tmp/definitely-not-a-real-index";
    try {
      const log = await runAndLog("90", "keep", "env-poison keep");
      expect(log.content[0].text).toContain("Kept (commit");
    } finally {
      if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = oldIndex;
    }
  });

  it("reports confidence once enough runs exist", async () => {
    await initSession();
    await runAndLog("99.0", "keep", "big noisy improvement");
    await runAndLog("101.0", "discard", "noisy regression");
    const log = await runAndLog("99.96", "discard", "tiny change");
    expect(log.content[0].text).toContain("Confidence: 1.349x noise (marginal)");
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
      expect.stringContaining("Re-read .pi/autoresearch/prompt.md"),
      { deliverAs: "followUp" },
    );
    expect(mockPi.sendUserMessage.mock.calls[0][0]).toContain(".pi/autoresearch/log.jsonl");
    expect(mockPi.sendUserMessage.mock.calls[0][0]).not.toContain(".auto/");
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
    const pendingPath = join(cwd, ".pi", "autoresearch", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    const statusWithPending = await executeTool({ action: "status" });
    expect(statusWithPending.content[0].text).toContain("pending experiment");

    const stop = await executeTool({ action: "stop" });
    expect(stop.content[0].text).toContain("kept in .pi/autoresearch/");
    expect(stop.details.active).toBe(false);
    expect((await loadConfig(cwd))?.stopped).toBe(true);
    expect(existsSync(pendingPath)).toBe(false);
    // Pending changes were reverted on stop.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
  });
});

describe("autoresearch-units", () => {
  it("schema points notes to the project state directory", () => {
    expect(AUTORESEARCH_PARAMETERS.properties.notes.description).toContain(
      ".pi/autoresearch/prompt.md",
    );
  });

  it("parseMetric handles METRIC lines, name=value, and last-number fallback", () => {
    expect(parseMetric("METRIC time=42.5\ndone", "time")).toBe(42.5);
    expect(parseMetric("time=17", "time")).toBe(17);
    expect(parseMetric("build ok in 3 rounds, 125ms total", "time")).toBe(125);
    expect(parseMetric("nothing here", "time")).toBeUndefined();
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

  it("confidence is undefined under 3 runs and flags noise", () => {
    const few: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 100 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 50 },
    ];
    expect(confidence(few, "lower")).toBeUndefined();

    const noisy: RunEntry[] = [
      { run: 1, at: 1, status: "baseline", description: "b", metric: 100 },
      { run: 2, at: 2, status: "keep", description: "a", metric: 99.9 },
      { run: 3, at: 3, status: "discard", description: "c", metric: 100.1 },
    ];
    const conf = confidence(noisy, "lower");
    expect(conf).toBeDefined();
    expect(conf ?? 0).toBeLessThan(1);
  });
});
