import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import missionsExtension from "../../extensions/missions/missions.ts";
import {
  acquireMissionLock,
  ensureInsideMissionsDir,
  generateCheckpointId,
  generateMissionId,
  generateTaskId,
  listMissionSummaries,
  loadMission,
  missionsDir,
  validateCheckpointId,
  validateMissionId,
  validateTaskId,
} from "../../extensions/missions/src/storage.ts";
import { runGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { __resetWidgetStrip, STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi as createBasePi } from "../mocks/pi-mocks.ts";

describe("missions-extension", () => {
  let cwd: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionCommandContext>;

  const executeTool = async (params: Record<string, unknown>) => {
    const tool = mockPi.registerTool.mock.calls[0][0];
    return tool.execute("call-1", params as never, undefined, undefined, mockCtx);
  };

  const getCommand = (name: string) => {
    for (const call of mockPi.registerCommand.mock.calls) {
      if (call[0] === name) return call[1];
    }
    throw new Error(`command ${name} not registered`);
  };

  const getEventHandler = (eventType: string) => {
    for (const call of mockPi.on.mock.calls) {
      if (call[0] === eventType) return call[1];
    }
    throw new Error(`handler for ${eventType} not found`);
  };

  beforeEach(async () => {
    __resetWidgetStrip();
    cwd = await mkdtemp(join(tmpdir(), "missions-test-"));
    mockPi = createBasePi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockCommandContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    await missionsExtension(mockPi);
    // The session branch must round-trip appendEntry records the way the real
    // transcript does, or reloadActive can't see this session's pointer.
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      ...mockPi.appendEntry.mock.calls
        .filter(([type]) => type === "missions-active")
        .map(([, data]) => ({ type: "custom", customType: "missions-active", data })),
    ]);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("registers the mission tool and commands", () => {
    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mission" }));
    const names = mockPi.registerCommand.mock.calls.map((c) => c[0]);
    expect(names).toContain("missions");
    expect(names).toContain("mission:status");
    expect(names).toContain("mission:reconcile");
  });

  it("creates a mission, persists it, and sets the active pointer", async () => {
    const result = await executeTool({
      action: "create",
      title: "Build widget",
      objective: "A working widget with tests",
    });
    const text = result.content[0].text as string;
    expect(text).toContain("Created mission-");
    expect(text).toContain("planning");

    const activeId = lastActiveEntryId();
    expect(activeId).toMatch(/^mission-/);
    const stored = JSON.parse(
      await readFile(join(cwd, CONFIG_DIR_NAME, "missions", `${activeId}.json`), "utf8"),
    );
    expect(stored.title).toBe("Build widget");
    expect(stored.status).toBe("planning");
  });

  /** The mission id this session last pointed at (from appendEntry calls). */
  function lastActiveEntryId(): string | undefined {
    const calls = mockPi.appendEntry.mock.calls.filter(([type]) => type === "missions-active");
    const last = calls.at(-1)?.[1] as { id?: string } | undefined;
    return last?.id;
  }

  it("a second session can hold its own active mission", async () => {
    await executeTool({ action: "create", title: "mine", objective: "first session" });

    // Session-scoped pointers: the second session sees no active mission and
    // creates its own without touching the first.
    const secondPi = createBasePi() as DeepMocked<ExtensionAPI>;
    const secondCtx = createMockCommandContext();
    (secondCtx as { cwd: string }).cwd = cwd;
    await missionsExtension(secondPi);
    const secondStart = secondPi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    if (!secondStart) throw new Error("second session_start handler not found");
    await secondStart({ type: "session_start", reason: "startup" }, secondCtx);

    const secondTool = secondPi.registerTool.mock.calls[0][0];
    const secondCreate = await secondTool.execute(
      "call-2",
      { action: "create", title: "theirs", objective: "second session" } as never,
      undefined,
      undefined,
      secondCtx,
    );
    expect(secondCreate.details.missionId).toMatch(/^mission-/);
    const summaries = JSON.stringify(secondCreate.details.missionId);
    expect(summaries).not.toContain(lastActiveEntryId() ?? "none");
  });

  it("rejects a second create while a mission is active", async () => {
    await executeTool({ action: "create", title: "one", objective: "first" });
    await expect(
      executeTool({ action: "create", title: "two", objective: "second" }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects a stale mutation instead of overwriting another session's update", async () => {
    const created = await executeTool({
      action: "create",
      title: "shared",
      objective: "coordinate sessions",
    });
    const sharedId = created.details.missionId as string;

    const secondPi = createBasePi() as DeepMocked<ExtensionAPI>;
    const secondCtx = createMockCommandContext();
    (secondCtx as { cwd: string }).cwd = cwd;
    await missionsExtension(secondPi);
    const secondStart = secondPi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    if (!secondStart) throw new Error("second session_start handler not found");
    await secondStart({ type: "session_start", reason: "startup" }, secondCtx);

    // Session-scoped active pointers: the second session adopts the same
    // mission explicitly (switch) — exactly what a second session must do to
    // work on an existing mission.
    const secondSwitch = secondPi.registerTool.mock.calls[0][0];
    await secondSwitch.execute(
      "call-switch",
      { action: "switch", id: sharedId } as never,
      undefined,
      undefined,
      secondCtx,
    );

    await executeTool({ action: "task_add", taskTitle: "First session task" });

    const secondTool = secondPi.registerTool.mock.calls[0][0];
    await expect(
      secondTool.execute(
        "call-2",
        { action: "task_add", taskTitle: "Stale second session task" },
        undefined,
        undefined,
        secondCtx,
      ),
    ).rejects.toThrow(/changed by another session/);

    const stored = JSON.parse(
      await readFile(join(cwd, CONFIG_DIR_NAME, "missions", `${sharedId}.json`), "utf8"),
    );
    expect(stored.tasks.map((task: { title: string }) => task.title)).toEqual([
      "First session task",
    ]);
  });

  it("enforces dependency ordering and summaries on task_update", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const a = await executeTool({ action: "task_add", taskTitle: "Task A" });
    const aId = a.details.taskId as string;
    const b = await executeTool({
      action: "task_add",
      taskTitle: "Task B",
      dependsOn: [aId],
    });
    const bId = b.details.taskId as string;

    await expect(
      executeTool({ action: "task_update", taskId: bId, status: "done", summary: "did it" }),
    ).rejects.toThrow(/depends on/);

    await expect(
      executeTool({ action: "task_update", taskId: aId, status: "done" }),
    ).rejects.toThrow(/summary/);

    const res = await executeTool({
      action: "task_update",
      taskId: aId,
      status: "done",
      summary: "A done",
    });
    expect(res.content[0].text).toContain("done");

    await expect(
      executeTool({ action: "task_update", taskId: bId, status: "done", summary: "B done" }),
    ).resolves.toMatchObject({ details: { status: "done" } });
  });

  it("tracks spend and flags over-budget", async () => {
    await executeTool({ action: "create", title: "t", objective: "o", maxTokens: 100 });
    const res = await executeTool({ action: "spend", tokens: 150 });
    expect(res.details.overBudget).toBe(true);
    expect(res.content[0].text).toContain("OVER BUDGET");
  });

  it("completes only when every task is done or failed", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const t = await executeTool({ action: "task_add", taskTitle: "Only task" });
    const taskId = t.details.taskId as string;

    await expect(executeTool({ action: "set_status", missionStatus: "complete" })).rejects.toThrow(
      /Cannot complete/,
    );

    await executeTool({ action: "task_update", taskId, status: "done", summary: "delivered" });
    const res = await executeTool({ action: "set_status", missionStatus: "complete" });
    expect(res.details.status).toBe("complete");
  });

  it("completing or aborting a mission frees the active slot for a new one", async () => {
    await executeTool({ action: "create", title: "first", objective: "o" });
    await executeTool({ action: "set_status", missionStatus: "aborted" });

    const second = await executeTool({ action: "create", title: "second", objective: "o" });
    expect(second.details.missionId).toBeDefined();

    // And completing the second frees the slot again.
    await executeTool({ action: "set_status", missionStatus: "aborted" });
    const third = await executeTool({ action: "create", title: "third", objective: "o" });
    expect(third.details.missionId).toBeDefined();
  });

  it("reconcile re-runs verification and marks failures as regressed", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const pass = await executeTool({
      action: "task_add",
      taskTitle: "Passing task",
      verification: { command: "true" },
    });
    const fail = await executeTool({
      action: "task_add",
      taskTitle: "Failing task",
      verification: { command: "echo check-output >&2; false" },
    });
    await executeTool({
      action: "task_update",
      taskId: pass.details.taskId as string,
      status: "done",
      summary: "done",
    });
    await executeTool({
      action: "task_update",
      taskId: fail.details.taskId as string,
      status: "done",
      summary: "done",
    });

    const res = await executeTool({ action: "reconcile" });
    const text = res.content[0].text as string;
    expect(text).toContain("2 verified task(s) re-checked");
    expect(text).toContain("1 task(s) REGRESSED");
    expect(text).toContain("check-output");
    expect(res.details.report.regressed).toHaveLength(1);
    expect(res.details.report.regressed[0].taskId).toBe(fail.details.taskId);

    const status = await executeTool({ action: "status" });
    expect(status.content[0].text).toContain("⚠");
  });

  it("switch selects another mission by id", async () => {
    await executeTool({ action: "create", title: "first", objective: "o" });
    // Manually create a second mission file (create is blocked while active).
    const secondId = generateMissionId();
    const second = {
      id: secondId,
      title: "second",
      objective: "o",
      status: "paused",
      createdAt: 1,
      updatedAt: 2,
      tasks: [],
      checkpoints: [],
      decisions: [],
      budget: {},
      spent: { iterations: 0, tokens: 0 },
    };
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", `${secondId}.json`),
      JSON.stringify(second),
    );

    const res = await executeTool({ action: "switch", id: secondId });
    expect(res.content[0].text).toContain(`Switched to ${secondId}`);
    expect(lastActiveEntryId()).toBe(secondId);
  });

  it("session_start keeps mission state out of git status", async () => {
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    await writeFile(join(cwd, CONFIG_DIR_NAME, "missions", "some-mission.json"), "{}\n");
    await runGit(cwd, ["init", "-q"]);

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(`${projectStateRelative("missions")}/`);
    expect(await runGit(cwd, ["status", "--porcelain"])).toBe("");
  });

  it("session_start restores the active mission into the status line", async () => {
    const restoredId = generateMissionId();
    const mission = {
      id: restoredId,
      title: "restored",
      objective: "o",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      tasks: [{ id: "task-a", title: "A", status: "in_progress", dependsOn: [] }],
      checkpoints: [],
      decisions: [],
      budget: {},
      spent: { iterations: 0, tokens: 0 },
    };
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", `${restoredId}.json`),
      JSON.stringify(mission),
    );
    // The active pointer lives in the session transcript now.
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      { type: "custom", customType: "missions-active", data: { id: restoredId } },
    ]);

    const handler = getEventHandler("session_start");
    await handler({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "missions",
      expect.stringContaining("active"),
    );
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.anything());
    const text = renderLastWidget(mockCtx).join("\n");
    expect(text).toContain("Mission");
    expect(text).toContain("tasks 0/1");
    expect(text).toContain("restored — active");
    expect(text).toContain("▸ task-a");
  });

  it("mission:status command notifies with the full status", async () => {
    await executeTool({ action: "create", title: "listed", objective: "o" });
    const handler = getCommand("mission:status").handler;
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("listed"), "info");
  });

  it("publishes state events and clears UI on shutdown", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    expect(mockPi.events.emit).toHaveBeenCalledWith(
      "missions:state",
      expect.objectContaining({ active: true }),
    );

    const shutdown = getEventHandler("session_shutdown");
    await shutdown({ type: "session_shutdown", reason: "quit" }, mockCtx);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("missions", undefined);
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, undefined);
  });

  it("task_add stores the verification command and description", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    await executeTool({
      action: "task_add",
      taskTitle: "Ship it",
      verification: { command: "npm test", description: "the suite passes" },
    });

    const stored = JSON.parse(
      await readFile(join(cwd, CONFIG_DIR_NAME, "missions", `${lastActiveEntryId()}.json`), "utf8"),
    );
    expect(stored.tasks[0].verification).toEqual({
      command: "npm test",
      description: "the suite passes",
    });
  });

  it("set_status to a non-terminal status keeps the active pointer on disk", async () => {
    const created = await executeTool({ action: "create", title: "t", objective: "o" });
    const id = created.details.missionId as string;

    await executeTool({ action: "set_status", missionStatus: "paused" });
    expect(lastActiveEntryId()).toBe(id);

    await executeTool({ action: "set_status", missionStatus: "active" });
    expect(lastActiveEntryId()).toBe(id);
  });

  it("set_status re-activating a mission restores a cleared pointer", async () => {
    const created = await executeTool({ action: "create", title: "first", objective: "o" });
    const id = created.details.missionId as string;
    await executeTool({ action: "set_status", missionStatus: "aborted" });
    // Aborting clears the session pointer (entry id undefined).
    expect(lastActiveEntryId()).toBeUndefined();

    // Aborting frees the slot; reopening requires re-selecting the mission,
    // and the pointer must come back with it.
    await executeTool({ action: "switch", id });
    await executeTool({ action: "set_status", missionStatus: "paused" });
    expect(lastActiveEntryId()).toBe(id);
  });

  it("list returns every mission with a summary", async () => {
    await executeTool({ action: "create", title: "visible", objective: "o" });
    await executeTool({ action: "set_status", missionStatus: "aborted" });
    const second = await executeTool({ action: "create", title: "current", objective: "o" });
    expect(second.details.missionId).toBeDefined();

    const res = await executeTool({ action: "list" });
    const text = res.content[0].text as string;
    expect(text).toContain("visible");
    expect(text).toContain("current");
    expect(res.details.count).toBe(2);
  });

  it("switch to an unknown id throws", async () => {
    await expect(executeTool({ action: "switch", id: generateMissionId() })).rejects.toThrow(
      /No mission found/,
    );
  });

  it("checkpoint records a labelled checkpoint", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const res = await executeTool({
      action: "checkpoint",
      label: "kickoff",
      summary: "agreed on scope",
      commit: "abc1234",
    });
    expect(res.content[0].text).toContain("Checkpoint");
    expect(res.details.checkpointId).toMatch(/^ckpt-/);

    const stored = JSON.parse(
      await readFile(join(cwd, CONFIG_DIR_NAME, "missions", `${lastActiveEntryId()}.json`), "utf8"),
    );
    expect(stored.checkpoints[0]).toMatchObject({ label: "kickoff", commit: "abc1234" });
  });

  it("decision records a decision", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const res = await executeTool({ action: "decision", text: "Use sqlite for storage" });
    expect(res.content[0].text).toContain("Decision recorded.");

    const stored = JSON.parse(
      await readFile(join(cwd, CONFIG_DIR_NAME, "missions", `${lastActiveEntryId()}.json`), "utf8"),
    );
    expect(stored.decisions[0].text).toBe("Use sqlite for storage");
  });

  it("set_budget stores budgets and rejects negative values", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });

    const res = await executeTool({ action: "set_budget", maxIterations: 5, maxTokens: 1000 });
    expect(res.details.budget).toEqual({ maxIterations: 5, maxTokens: 1000 });

    await expect(executeTool({ action: "set_budget", maxIterations: -1 })).rejects.toThrow(
      /maxIterations must be >= 0/,
    );
    await expect(executeTool({ action: "set_budget", maxTokens: -5 })).rejects.toThrow(
      /maxTokens must be >= 0/,
    );
  });

  it("task_verify attaches and clears a verification command", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const added = await executeTool({ action: "task_add", taskTitle: "Task" });
    const taskId = added.details.taskId as string;

    const set = await executeTool({
      action: "task_verify",
      taskId,
      verification: { command: "npm test", description: "suite passes" },
    });
    expect(set.content[0].text).toContain("npm test");

    const cleared = await executeTool({ action: "task_verify", taskId });
    expect(cleared.content[0].text).toContain("cleared");
  });

  it("spend rejects negative amounts and requires iterations or tokens", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });

    await expect(executeTool({ action: "spend" })).rejects.toThrow(
      /requires iterations and\/or tokens/,
    );
    await expect(executeTool({ action: "spend", iterations: -1 })).rejects.toThrow(
      /iterations must be >= 0/,
    );
    await expect(executeTool({ action: "spend", tokens: -1 })).rejects.toThrow(
      /tokens must be >= 0/,
    );
  });

  it("unknown action throws", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    await expect(executeTool({ action: "explode" })).rejects.toThrow(/Unknown mission action/);
  });

  it("create requires title and objective", async () => {
    await expect(executeTool({ action: "create" })).rejects.toThrow(/requires title/);
    await expect(executeTool({ action: "create", title: "t" })).rejects.toThrow(
      /requires objective/,
    );
  });

  it("task_add is blocked after abort", async () => {
    const created = await executeTool({ action: "create", title: "t", objective: "o" });
    await executeTool({ action: "set_status", missionStatus: "aborted" });
    // Aborting frees the active slot; re-select the closed mission so the
    // mutation hits requireOpen's closed-mission guard.
    await executeTool({ action: "switch", id: created.details.missionId as string });
    await expect(executeTool({ action: "task_add", taskTitle: "Too late" })).rejects.toThrow(
      /no longer be modified/,
    );
  });

  it("loadMission rejects with a descriptive error for a corrupt mission file", async () => {
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    const corruptId = generateMissionId();
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", `${corruptId}.json`),
      "{ this is not json",
    );

    await expect(loadMission(cwd, corruptId)).rejects.toThrow(/invalid JSON/);
  });

  it("a dangling session pointer degrades to no active mission", async () => {
    await executeTool({ action: "create", title: "gone", objective: "o" });
    const id = lastActiveEntryId();
    if (!id) throw new Error("no active entry after create");
    await rm(join(cwd, CONFIG_DIR_NAME, "missions", `${id}.json`));

    // session_start reloads from the session pointer: the mission file is
    // gone, so the session starts with no active mission (and survives).
    await getEventHandler("session_start")({ type: "session_start", reason: "reload" }, mockCtx);
    await expect(executeTool({ action: "status" })).rejects.toThrow(/No active mission/);
  });

  it("a corrupt active mission file degrades at session_start instead of crashing it", async () => {
    await executeTool({ action: "create", title: "corrupt-target", objective: "o" });
    const id = lastActiveEntryId();
    if (!id) throw new Error("no active entry");
    await writeFile(join(cwd, CONFIG_DIR_NAME, "missions", `${id}.json`), "{ corrupted");

    const handler = getEventHandler("session_start");
    await handler({ type: "session_start", reason: "reload" }, mockCtx);
    // Degrades to none at session_start; the corruption surfaces on explicit
    // reads (switch loads the file directly).
    await expect(executeTool({ action: "status" })).rejects.toThrow(/No active mission/);
    await expect(executeTool({ action: "switch", id })).rejects.toThrow(/corrupt/);
  });

  it("list skips a corrupt mission file and reports its filename while still listing others", async () => {
    await executeTool({ action: "create", title: "healthy", objective: "o" });
    const corruptFile = `${generateMissionId()}.json`;
    await writeFile(join(cwd, CONFIG_DIR_NAME, "missions", corruptFile), "{ this is not json");

    const res = await executeTool({ action: "list" });
    const text = res.content[0].text as string;
    expect(text).toContain("healthy");
    expect(text).toContain(corruptFile);
    expect(res.details.count).toBe(1);
    expect(res.details.skipped).toEqual([corruptFile]);
  });

  it("listMissionSummaries skips mission files that fail to load and reports them", async () => {
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    // Stored under a valid-id filename, but the record's own id points
    // elsewhere: loadMission refuses to operate on it.
    const mismatchFile = `${generateMissionId()}.json`;
    const storedId = generateMissionId();
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", mismatchFile),
      JSON.stringify({
        id: storedId,
        title: "mismatched",
        objective: "o",
        status: "planning",
        tasks: [],
        checkpoints: [],
        decisions: [],
        updatedAt: 1,
      }),
    );
    // Right id shape, wrong record shape.
    const shapeFile = `${generateMissionId()}.json`;
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", shapeFile),
      JSON.stringify({ nope: true }),
    );

    const { summaries, skipped } = await listMissionSummaries(cwd);
    expect(summaries).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped).toContain(mismatchFile);
    expect(skipped).toContain(shapeFile);
  });

  it("listMissionSummaries surfaces a missions directory it cannot read", async () => {
    // A file where the missions directory belongs: readdir fails with
    // ENOTDIR, not ENOENT. An empty result would claim there are no missions.
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(missionsDir(cwd), "not a directory", "utf8");

    await expect(listMissionSummaries(cwd)).rejects.toThrow(/cannot list mission files/i);
  });

  it("generateMissionId produces unique ids for 1000 calls in one millisecond", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i += 1) ids.add(generateMissionId());
      expect(ids.size).toBe(1000);
    } finally {
      spy.mockRestore();
    }
  });

  it("a live lock hold is not stolen while the holder keeps it fresh", async () => {
    const lockId = generateMissionId();
    const lockPath = join(cwd, CONFIG_DIR_NAME, "missions", ".locks", `${lockId}.lock`);
    // staleMs is far beyond the test horizon, so the staleness path can never
    // fire: the waiter must lose to its own timeout, not to a steal. Real
    // timers throughout — the staleness check compares Date.now() against
    // real filesystem mtimes, so a fake clock would desync the two.
    const release = await acquireMissionLock(cwd, lockId, {
      staleMs: 60_000,
      refreshMs: 50,
      timeoutMs: 900,
    });
    const initialMtime = (await stat(lockPath)).mtimeMs;
    const waiter = acquireMissionLock(cwd, lockId, {
      staleMs: 60_000,
      refreshMs: 50,
      timeoutMs: 150,
    });
    // Attach the rejection expectation before the waiter's deadline passes.
    const waiterTimedOut = expect(waiter).rejects.toThrow(/Timed out waiting/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await waiterTimedOut;
    // The holder's refresh interval has touched the lock since acquisition.
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(initialMtime);
    await expect(stat(lockPath)).resolves.toBeTruthy();
    await release();
  });

  it("an abandoned stale lock is reclaimed", async () => {
    const lockId = generateMissionId();
    const lockPath = join(cwd, CONFIG_DIR_NAME, "missions", ".locks", `${lockId}.lock`);
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions", ".locks"), { recursive: true });
    await writeFile(lockPath, "0\n");
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    const release = await acquireMissionLock(cwd, lockId, { staleMs: 1_000 });
    await release();
  });

  it("/missions lists missions and handles the empty case", async () => {
    const handler = getCommand("missions").handler;
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No missions"), "info");

    await executeTool({ action: "create", title: "listed", objective: "o" });
    mockCtx.ui.notify.mockClear();
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("listed"), "info");
  });

  it("/mission:status reports when no mission is active", async () => {
    const handler = getCommand("mission:status").handler;
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No active mission"),
      "info",
    );
  });

  it("/mission:reconcile re-runs verification and reports when nothing is active", async () => {
    const handler = getCommand("mission:reconcile").handler;
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith("No active mission to reconcile.", "info");

    await executeTool({ action: "create", title: "reconcile me", objective: "o" });
    const task = await executeTool({
      action: "task_add",
      taskTitle: "Done task",
      verification: { command: "true" },
    });
    await executeTool({
      action: "task_update",
      taskId: task.details.taskId as string,
      status: "done",
      summary: "delivered",
    });
    mockCtx.ui.notify.mockClear();
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reconciled"), "info");
  });

  // --- Id validation: ids from tool calls reach the filesystem, so anything
  // --- that does not match a generated id is rejected before path use.

  it("generators produce ids every validator accepts", () => {
    expect(() => validateMissionId(generateMissionId())).not.toThrow();
    expect(() => validateTaskId(generateTaskId())).not.toThrow();
    expect(() => validateCheckpointId(generateCheckpointId())).not.toThrow();
  });

  it("switch rejects traversal and malformed mission ids before touching the filesystem", async () => {
    const bad = [
      "../outside",
      "../../etc/passwd",
      "/etc/passwd",
      "mission-x/../../y",
      "task-abc123",
      "mission-abc-abc",
      "mission-1-abcdef012345678z",
    ];
    for (const id of bad) {
      await expect(executeTool({ action: "switch", id })).rejects.toThrow(/Invalid mission id/);
    }
    await expect(executeTool({ action: "switch", id: "" })).rejects.toThrow(/switch requires id/);
    await expect(stat(join(cwd, CONFIG_DIR_NAME, "outside.json"))).rejects.toThrow();
  });

  it("task_update and task_verify reject traversal and malformed task ids", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    const bad = ["../task", "task-../../x", "task-abc12g", "mission-0000000000000000-abcdef"];
    for (const taskId of bad) {
      await expect(
        executeTool({ action: "task_update", taskId, status: "done", summary: "s" }),
      ).rejects.toThrow(/Invalid task id/);
      await expect(
        executeTool({ action: "task_verify", taskId, verification: { command: "true" } }),
      ).rejects.toThrow(/Invalid task id/);
    }
  });

  it("task_add rejects traversal ids in dependsOn and accepts generated ones", async () => {
    await executeTool({ action: "create", title: "t", objective: "o" });
    await expect(
      executeTool({ action: "task_add", taskTitle: "T", dependsOn: ["../sneak"] }),
    ).rejects.toThrow(/Invalid task id/);

    const a = await executeTool({ action: "task_add", taskTitle: "A" });
    const aId = a.details.taskId as string;
    const b = await executeTool({ action: "task_add", taskTitle: "B", dependsOn: [aId] });
    expect(b.details.taskId as string).toMatch(/^task-[0-9a-f]{6}$/);
  });

  it("loadMission rejects a crafted record whose stored id is a traversal id", async () => {
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    const requested = generateMissionId();
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", `${requested}.json`),
      JSON.stringify(craftMission("../escape")),
    );

    await expect(loadMission(cwd, requested)).rejects.toThrow(/does not match/);
    await expect(executeTool({ action: "switch", id: requested })).rejects.toThrow(
      /does not match/,
    );
    // The traversal record must never be adopted as active or re-saved.
    await expect(lastActiveEntryId()).toBeUndefined();
    await expect(stat(join(cwd, CONFIG_DIR_NAME, "escape.json"))).rejects.toThrow();
  });

  it("loadMission rejects a record stored under a different valid mission id", async () => {
    await mkdir(join(cwd, CONFIG_DIR_NAME, "missions"), { recursive: true });
    const requested = generateMissionId();
    const storedId = generateMissionId();
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "missions", `${requested}.json`),
      JSON.stringify(craftMission(storedId)),
    );

    await expect(executeTool({ action: "switch", id: requested })).rejects.toThrow(
      /does not match/,
    );
    await expect(lastActiveEntryId()).toBeUndefined();
  });

  it("containment guard rejects mission paths that escape the missions directory", () => {
    const inside = join(missionsDir(cwd), `${generateMissionId()}.json`);
    expect(ensureInsideMissionsDir(cwd, inside)).toBe(resolve(inside));
    expect(() => ensureInsideMissionsDir(cwd, join(missionsDir(cwd), "..", "escape.json"))).toThrow(
      /escapes the missions directory/,
    );
    expect(() => ensureInsideMissionsDir(cwd, "/etc/passwd")).toThrow(
      /escapes the missions directory/,
    );
  });

  it("list skips files that are not valid mission ids instead of crashing", async () => {
    await executeTool({ action: "create", title: "real", objective: "o" });
    await writeFile(join(cwd, CONFIG_DIR_NAME, "missions", "stray-file.json"), "{}\n");

    const res = await executeTool({ action: "list" });
    expect(res.details.count).toBe(1);
    expect(res.content[0].text).toContain("real");
  });
});

// --- Helpers ---

/** A mission-shaped record for crafting corrupt files directly on disk. */
function craftMission(id: string): Record<string, unknown> {
  return {
    id,
    title: "crafted",
    objective: "o",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tasks: [],
    checkpoints: [],
    decisions: [],
    budget: {},
    spent: { iterations: 0, tokens: 0 },
  };
}

/** Instantiate the last widget factory the extension published and render it. */
function renderLastWidget(mockCtx: DeepMocked<ExtensionCommandContext>, width = 80): string[] {
  const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
  const factory = lastCall[1] as
    | ((tui: unknown, theme: unknown) => { render(w: number): string[] })
    | undefined;
  if (typeof factory !== "function") {
    throw new Error(`expected a widget factory, got ${String(factory)}`);
  }
  return factory(undefined, mockCtx.ui.theme).render(width);
}
