import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import missionsExtension from "../../extensions/missions/missions.ts";
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
    cwd = await mkdtemp(join(tmpdir(), "missions-test-"));
    mockPi = createBasePi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockCommandContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    await missionsExtension(mockPi);
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

    const pointer = JSON.parse(await readFile(join(cwd, ".pi/missions/active.json"), "utf8"));
    expect(pointer.id).toMatch(/^mission-/);
    const stored = JSON.parse(
      await readFile(join(cwd, ".pi/missions", `${pointer.id}.json`), "utf8"),
    );
    expect(stored.title).toBe("Build widget");
    expect(stored.status).toBe("planning");
  });

  it("rejects a second create while a mission is active", async () => {
    await executeTool({ action: "create", title: "one", objective: "first" });
    await expect(
      executeTool({ action: "create", title: "two", objective: "second" }),
    ).rejects.toThrow(/already exists/);
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
    const second = {
      id: "mission-second",
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
    await writeFile(join(cwd, ".pi/missions/mission-second.json"), JSON.stringify(second));

    const res = await executeTool({ action: "switch", id: "mission-second" });
    expect(res.content[0].text).toContain("Switched to mission-second");
    const pointer = JSON.parse(await readFile(join(cwd, ".pi/missions/active.json"), "utf8"));
    expect(pointer.id).toBe("mission-second");
  });

  it("session_start restores the active mission into the status line", async () => {
    const mission = {
      id: "mission-restore",
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
    await mkdir(join(cwd, ".pi/missions"), { recursive: true });
    await writeFile(join(cwd, ".pi/missions/mission-restore.json"), JSON.stringify(mission));
    await writeFile(
      join(cwd, ".pi/missions/active.json"),
      JSON.stringify({ id: "mission-restore" }),
    );

    const handler = getEventHandler("session_start");
    await handler({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "missions",
      expect.stringContaining("active"),
    );
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("missions", expect.anything());
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
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("missions", undefined);
  });
});
