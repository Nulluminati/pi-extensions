import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import autoresearchExtension from "../../extensions/autoresearch/autoresearch.ts";
import { parseMetric } from "../../extensions/autoresearch/src/measure.ts";
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

  const getEventHandler = (eventType: string) => {
    for (const call of mockPi.on.mock.calls) {
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

  it("init records the baseline and writes .auto files", async () => {
    const res = await initSession();
    expect(res.content[0].text).toContain("Baseline: 100");

    const config = await loadConfig(cwd);
    expect(config?.metric).toBe("time");
    expect(config?.stopped).toBeUndefined();
    const entries = await readLog(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("baseline");
    expect(entries[0].metric).toBe(100);

    const prompt = await readFile(join(cwd, ".auto/prompt.md"), "utf8");
    expect(prompt).toContain("Make the code faster");

    // .auto/ excluded from git locally.
    const exclude = await readFile(join(cwd, ".git/info/exclude"), "utf8");
    expect(exclude).toContain(".auto/");
  });

  it("init rejects a second active session", async () => {
    await initSession();
    await expect(initSession()).rejects.toThrow(/already exists|active autoresearch/);
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

  it("discard removes only experiment-created files, not pre-existing untracked files", async () => {
    // Untracked files that predate the campaign (agent state, scratch notes)
    // must survive every discard — deleting them is data loss.
    await writeFile(join(cwd, "keepme.txt"), "precise state\n");
    await initSession();

    await writeFile(join(cwd, "code.txt"), "experiment edit\n");
    await writeFile(join(cwd, "experiment-only.txt"), "made by the experiment\n");
    await executeTool({ action: "run", description: "adds a file", hypothesis: "h" });
    await executeTool({ action: "log", status: "discard", description: "adds a file" });

    expect(await readFile(join(cwd, "keepme.txt"), "utf8")).toContain("precise state");
    expect(existsSync(join(cwd, "experiment-only.txt"))).toBe(false);
    // Tracked files still revert.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
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
      expect.stringContaining("Continue the autoresearch loop"),
      { deliverAs: "followUp" },
    );
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
    const statusWithPending = await executeTool({ action: "status" });
    expect(statusWithPending.content[0].text).toContain("pending experiment");

    const stop = await executeTool({ action: "stop" });
    expect(stop.details.active).toBe(false);
    expect((await loadConfig(cwd))?.stopped).toBe(true);
    // Pending changes were reverted on stop.
    expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("v1\n");
  });
});

describe("autoresearch-units", () => {
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
