import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderBoard,
  resolveProject,
  runBoard,
} from "../../plugins/mission-board/mission-board.ts";
import { runOpenBoard } from "../../plugins/mission-board/open-board.ts";
import { BOARD_ENTRYPOINT, PLUGIN_ID } from "../../plugins/mission-board/plugin.ts";

// --- Fixtures ---

function missionProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-mission-board-"));
}

type MissionOverride = {
  id?: string;
  title?: string;
  objective?: string;
  status?: string;
  updatedAt?: number;
  tasks?: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  budget?: Record<string, number>;
  spent?: Record<string, number>;
};

function mission(overrides: MissionOverride = {}): Record<string, unknown> {
  return {
    id: "mission-test-000000000000000a",
    title: "Probe mission",
    objective: "Render the probe board",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tasks: [],
    checkpoints: [],
    decisions: [],
    budget: { maxIterations: 10, maxTokens: 4_000 },
    spent: { iterations: 3, tokens: 1_500 },
    ...overrides,
  };
}

async function writeMission(project: string, value: Record<string, unknown>): Promise<string> {
  const dir = join(project, ".pi", "missions");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${String(value.id)}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
}

function ttyOutput(): { write: (text: string) => void; columns: number } {
  return { write: vi.fn(() => {}), columns: 100 };
}

function ttyInput(): EventEmitter & {
  on: (event: string, handler: (data: string | Buffer) => void) => void;
  removeListener: (event: string, handler: (data: string | Buffer) => void) => void;
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (raw: boolean) => void;
  resume: () => void;
  pause: () => void;
} {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(() => {}),
    resume: vi.fn(() => {}),
    pause: vi.fn(() => {}),
  });
  return input;
}

const globalRestores: Array<() => void> = [];

afterEach(() => {
  for (const restore of globalRestores.splice(0)) restore();
  vi.useRealTimers();
});

// --- Rendering ---

describe("Herdr mission board plugin", () => {
  describe("board rendering", () => {
    it("shows a friendly empty state when the project has no missions", async () => {
      const project = await missionProject();
      const text = await renderBoard(project);
      expect(text).toContain("No missions");
      expect(text).toContain(project);
    });

    it("expands the newest mission and summarizes the rest", async () => {
      const project = await missionProject();
      await writeMission(
        project,
        mission({
          id: "mission-test-0000000000000001",
          title: "Older mission",
          objective: "Older objective that must stay hidden",
          status: "complete",
          updatedAt: 10,
        }),
      );
      await writeMission(
        project,
        mission({
          id: "mission-test-0000000000000002",
          title: "Newest mission",
          updatedAt: 20,
          tasks: [
            { id: "task-aaa001", title: "Done task", status: "done", dependsOn: [] },
            {
              id: "task-bbb002",
              title: "Running task",
              status: "in_progress",
              dependsOn: ["task-aaa001"],
              owner: "worker:builder",
            },
            { id: "task-ccc003", title: "Blocked task", status: "blocked", dependsOn: [] },
            { id: "task-ddd004", title: "Failed task", status: "failed", dependsOn: [] },
            { id: "task-eee005", title: "Todo task", status: "todo", dependsOn: [] },
          ],
          checkpoints: [
            {
              id: "ckpt-aaa001",
              label: "Reader done",
              summary: "Shipped",
              commit: "abc1234",
              at: 5,
            },
          ],
          decisions: [{ text: "Reuse the worker viewer loop", at: 6 }],
        }),
      );
      const text = await renderBoard(project);
      expect(text).toContain("Newest mission");
      expect(text).toContain("Render the probe board");
      expect(text).toContain("Running task");
      expect(text).toContain("task-bbb002");
      expect(text).toContain("after task-aaa001");
      expect(text).toContain("worker:builder");
      expect(text).toContain("Reader done");
      expect(text).toContain("abc1234");
      expect(text).toContain("Reuse the worker viewer loop");
      expect(text).toContain("3/10 iterations");
      expect(text).toContain("1,500 tokens");
      expect(text).toContain("Older mission");
      expect(text).toContain("tasks 1/5");
      expect(text).not.toContain("Older objective that must stay hidden");
    });

    it("reports corrupt mission files instead of failing the board", async () => {
      const project = await missionProject();
      await writeMission(project, mission({ title: "Good mission" }));
      const dir = join(project, ".pi", "missions");
      await writeFile(join(dir, "mission-test-00000000000000ff.json"), "{ not json");
      const text = await renderBoard(project);
      expect(text).toContain("Good mission");
      expect(text).toContain("mission-test-00000000000000ff.json");
      expect(text).toContain("skipped");
    });

    it("strips terminal escape sequences from mission text", async () => {
      const project = await missionProject();
      await writeMission(
        project,
        mission({ title: "\u001b[31mRed title\u001b[0m", objective: "plain" }),
      );
      const text = await renderBoard(project);
      expect(text).toContain("Red title");
      expect(text).not.toContain("\u001b[31m");
    });
  });

  // --- Project resolution ---

  describe("project resolution", () => {
    it("resolves the project from the pane workspace context", () => {
      const env = {
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/selected/project" }),
      };
      expect(resolveProject([], env)).toBe("/selected/project");
    });

    it("falls back to the focused pane working directory", () => {
      const env = {
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/pane/project" }),
      };
      expect(resolveProject([], env)).toBe("/pane/project");
    });

    it("prefers the --project argument over the context", () => {
      const env = {
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/selected/project" }),
      };
      expect(resolveProject(["--project", "/override/project"], env)).toBe("/override/project");
    });

    it("fails with a clear error when no project is available", () => {
      expect(() => resolveProject([], {})).toThrow(/No project/);
    });
  });

  // --- Refresh loop ---

  describe("board refresh loop", () => {
    it("renders immediately, repaints each second, and quits on q", async () => {
      vi.useFakeTimers();
      const project = await missionProject();
      await writeMission(project, mission({ title: "Looped mission" }));
      const output = ttyOutput();
      const input = ttyInput();

      const running = runBoard({ project, input, output, refreshMs: 1_000 });
      await vi.waitFor(() => expect(output.write).toHaveBeenCalledTimes(1));
      expect(vi.mocked(output.write).mock.calls[0][0]).toContain("Looped mission");
      expect(input.setRawMode).toHaveBeenCalledWith(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(output.write).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(output.write).toHaveBeenCalledTimes(3));

      input.emit("data", "q");
      await running;
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(input.pause).toHaveBeenCalled();
    });

    it("quits on Ctrl+C and renders once without a TTY", async () => {
      vi.useFakeTimers();
      const project = await missionProject();
      await writeMission(project, mission({ title: "Piped mission" }));
      const output = ttyOutput();
      const input = ttyInput();
      Object.assign(input, {
        isTTY: false,
        setRawMode: vi.fn(() => {
          throw new Error("ENOTTY");
        }),
      });

      const running = runBoard({ project, input, output, refreshMs: 1_000 });
      await vi.waitFor(() => expect(output.write).toHaveBeenCalledTimes(1));
      input.emit("data", "\u0003");
      await running;
      const frames = vi.mocked(output.write).mock.calls.map((call) => String(call[0]));
      expect(frames.join("")).toContain("Piped mission");
    });
  });

  // --- Open action ---

  describe("open action", () => {
    it("opens a split pane beside the focused pane through HERDR_BIN_PATH", async () => {
      const spawn = vi.fn(() => ({ status: 0 }));
      const stderr = vi.fn();
      const code = await runOpenBoard({
        env: {
          HERDR_BIN_PATH: "/opt/herdr",
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
            workspace_id: "w9",
            focused_pane_id: "w9:p4",
          }),
        },
        spawn,
        stderr,
      });
      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        "/opt/herdr",
        [
          "plugin",
          "pane",
          "open",
          "--plugin",
          PLUGIN_ID,
          "--entrypoint",
          BOARD_ENTRYPOINT,
          "--placement",
          "split",
          "--target-pane",
          "w9:p4",
        ],
        expect.objectContaining({ shell: false }),
      );
      expect(stderr).not.toHaveBeenCalled();
    });

    it("falls back to the overlay when the split target is refused", async () => {
      const spawn = vi
        .fn((_command: string, _args: string[]) => ({ status: 1 }))
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });
      const code = await runOpenBoard({
        env: {
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w9:p4" }),
        },
        spawn,
        stderr: vi.fn(),
      });
      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      const retryArgs = spawn.mock.calls[1][1];
      expect(retryArgs).not.toContain("--placement");
      expect(retryArgs).not.toContain("--target-pane");
    });

    it("opens the default overlay when the context has no focused pane", async () => {
      const spawn = vi.fn((_command: string, _args: string[]) => ({ status: 0 }));
      const code = await runOpenBoard({
        env: {
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w7" }),
        },
        spawn,
        stderr: vi.fn(),
      });
      expect(code).toBe(0);
      const args = spawn.mock.calls[0][1];
      expect(args).not.toContain("--placement");
      expect(args).not.toContain("--target-pane");
      expect(args).not.toContain("--workspace");
    });

    it("falls back to the herdr command on PATH without HERDR_BIN_PATH", async () => {
      const spawn = vi.fn((command: string, _args: string[]) => ({ status: 0 }));
      await runOpenBoard({ env: {}, spawn, stderr: vi.fn() });
      expect(spawn.mock.calls[0][0]).toBe("herdr");
    });

    it("reports a failed open on stderr and exits nonzero", async () => {
      const spawn = vi.fn(() => ({ status: 3 }));
      const stderr = vi.fn();
      const code = await runOpenBoard({
        env: { HERDR_BIN_PATH: "/opt/herdr", HERDR_PLUGIN_CONTEXT_JSON: "{}" },
        spawn,
        stderr,
      });
      expect(code).toBe(3);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("failed"));
    });
  });

  // --- Manifest contract ---

  describe("manifest", () => {
    it("declares the plugin, action, and board pane contract", async () => {
      const manifest = await readFile(
        new URL("../../plugins/mission-board/herdr-plugin.toml", import.meta.url),
        "utf8",
      );
      expect(manifest).toContain(`id = "${PLUGIN_ID}"`);
      expect(manifest).toContain('name = "Pi Mission Board"');
      expect(manifest).toMatch(/min_herdr_version = "\d+\.\d+\.\d+"/);
      expect(manifest).toMatch(/platforms = \["linux", "macos"\]/);
      expect(manifest).toMatch(
        /\[\[actions\]\][\s\S]*?id = "open"[\s\S]*?contexts = \["workspace"\][\s\S]*?command = \["node", "open-board.ts"\]/,
      );
      expect(manifest).toMatch(
        /\[\[panes\]\][\s\S]*?id = "board"[\s\S]*?command = \["node", "mission-board.ts"\]/,
      );
      expect(BOARD_ENTRYPOINT).toBe("board");
    });
  });
});
