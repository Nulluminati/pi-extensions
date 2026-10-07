#!/usr/bin/env node
/** Read-only Herdr pane that renders a project's missions from
 *  `<project>/.pi/missions/`. The missions extension owns that state; this
 *  board only reads it. Runs under strip-only Node without a build step.
 *
 *  Usage (from the manifest pane entrypoint): the project comes from
 *  HERDR_PLUGIN_CONTEXT_JSON (workspace_cwd, then focused_pane_cwd).
 *  `--project <path>` overrides both for manual runs.
 */

import { listMissionSummaries, loadMission } from "../../extensions/missions/src/storage.ts";
import type { Mission, MissionSummary } from "../../extensions/missions/src/types.ts";
import { pathToFileURL } from "node:url";

// --- Constants ---

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const TASK_STATUS_ORDER = [
  "in_progress",
  "blocked",
  "regressed",
  "failed",
  "todo",
  "done",
] as const;

const TASK_STATUS_MARKS: Record<string, string> = {
  in_progress: "\u25b8",
  blocked: "\u26d4",
  regressed: "\u26a0",
  failed: "\u2717",
  todo: "\u00b7",
  done: "\u2713",
};

// --- Text helpers ---

/** Remove terminal escapes and control characters from mission text. */
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

function statusMark(status: string): string {
  const mark = TASK_STATUS_MARKS[status] ?? "\u00b7";
  return status === "done" ? `${GREEN}${mark}${RESET}` : mark;
}

function taskTotal(summary: MissionSummary): number {
  return Object.values(summary.taskCounts).reduce((total, count) => total + count, 0);
}

// --- Project resolution ---

/** Project directory for this pane: --project wins, then the workspace and
 *  focused-pane working directories from the plugin context. */
export function resolveProject(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--project") {
      const value = argv[index + 1];
      if (value) return value;
    }
    if (argument?.startsWith("--project=")) return argument.slice("--project=".length);
  }
  let context: Record<string, unknown> = {};
  try {
    context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as Record<string, unknown>;
  } catch {
    context = {};
  }
  for (const field of ["workspace_cwd", "focused_pane_cwd"] as const) {
    const value = context[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(
    "No project available. Open the board from a workspace context or pass --project <path>.",
  );
}

// --- Rendering ---

function missionLines(mission: Mission): string[] {
  const lines: string[] = [];
  lines.push(`${bold(clean(mission.title))}  ${dim(clean(mission.status))}`);
  const done = mission.tasks.filter((task) => task.status === "done").length;
  const failing = mission.tasks.filter(
    (task) => task.status === "failed" || task.status === "regressed",
  ).length;
  const progressParts = [`tasks ${done}/${mission.tasks.length}`];
  if (failing > 0) progressParts.push(`${failing} failing`);
  lines.push(`  ${dim(progressParts.join(" \u00b7 "))}`);
  lines.push(`  ${clean(mission.objective)}`);
  const { maxIterations = 0, maxTokens = 0 } = mission.budget ?? {};
  const budgetParts = [
    `${mission.spent.iterations}${maxIterations ? `/${maxIterations}` : ""} iterations spent`,
    `${mission.spent.tokens.toLocaleString("en-US")} tokens spent${maxTokens ? ` of ${maxTokens.toLocaleString("en-US")}` : ""}`,
  ];
  lines.push(`  ${dim(budgetParts.join(" \u00b7 "))}`);
  for (const status of TASK_STATUS_ORDER) {
    for (const task of mission.tasks.filter((candidate) => candidate.status === status)) {
      const parts = [`${statusMark(task.status)} ${task.id} ${clean(task.title)}`];
      if (task.dependsOn.length > 0)
        parts.push(dim(`(after ${task.dependsOn.join(", ")})`));
      if (task.owner) parts.push(dim(`(owner ${task.owner})`));
      lines.push(`  ${parts.join(" ")}`);
    }
  }
  for (const checkpoint of mission.checkpoints) {
    const commit = checkpoint.commit ? ` (${clean(checkpoint.commit)})` : "";
    lines.push(
      `  ${CYAN}\u25c8${RESET} ${clean(checkpoint.label)} \u2014 ${dim(clean(checkpoint.summary))}${dim(commit)}`,
    );
  }
  for (const decision of mission.decisions.slice(-5)) {
    lines.push(`  ${CYAN}\u2023${RESET} ${clean(decision.text)}`);
  }
  return lines;
}

function summaryLine(summary: MissionSummary): string {
  const done = summary.taskCounts.done ?? 0;
  const failing = (summary.taskCounts.failed ?? 0) + (summary.taskCounts.regressed ?? 0);
  const parts = [`tasks ${done}/${taskTotal(summary)}`];
  if (failing > 0) parts.push(`${failing} failing`);
  return `  ${clean(summary.title)}  ${dim(`${clean(summary.status)} \u00b7 ${parts.join(" \u00b7 ")}`)}`;
}

/** Render the full board frame for a project directory. */
export async function renderBoard(project: string): Promise<string> {
  const { summaries, skipped } = await listMissionSummaries(project);
  const lines: string[] = [];
  lines.push(`${bold("Mission board")}  ${dim(project)}`);
  if (summaries.length === 0) {
    lines.push("");
    lines.push("No missions. Start one with the mission tool (action=create).");
  } else {
    const [newest, ...rest] = summaries;
    let mission: Mission | undefined;
    if (newest) {
      try {
        mission = await loadMission(project, newest.id);
      } catch {
        mission = undefined;
      }
    }
    lines.push("");
    lines.push(...(mission ? missionLines(mission) : newest ? [summaryLine(newest)] : []));
    if (rest.length > 0) {
      lines.push("");
      lines.push(dim(`Other missions (${rest.length}):`));
      for (const summary of rest) lines.push(summaryLine(summary));
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(
      `${YELLOW}skipped${RESET} ${skipped.length} corrupt mission file(s): ${skipped.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// --- Refresh loop ---

export interface BoardStreams {
  project: string;
  input: {
    on(event: "data", handler: (data: string | Buffer) => void): unknown;
    removeListener(event: "data", handler: (data: string | Buffer) => void): unknown;
    resume(): unknown;
    pause(): unknown;
    setRawMode(raw: boolean): unknown;
    isTTY?: boolean;
  };
  output: { write(text: string): unknown };
  refreshMs?: number;
}

/** Draw the board, refresh it once per second, and quit on q or Ctrl+C. */
export async function runBoard(streams: BoardStreams): Promise<void> {
  const { project, input, output } = streams;
  const refreshMs = streams.refreshMs ?? 1_000;
  const isTTY = input.isTTY === true;
  let frame = "";

  const draw = async (): Promise<void> => {
    let next: string;
    try {
      next = await renderBoard(project);
    } catch (error) {
      next = `Mission board failed: ${(error as Error).message}\n`;
    }
    frame = `\u001b[H\u001b[J${next}`;
    output.write(frame);
  };

  const quit = (): void => {
    if (resolved) return;
    resolved = true;
    input.removeListener("data", onData);
    clearInterval(timer);
    try {
      input.setRawMode(false);
    } catch {
      // Piped stdin has no raw mode.
    }
    input.pause();
    resolveRun();
  };

  const onData = (raw: string | Buffer): void => {
    // Real streams deliver Buffers; test doubles deliver strings.
    const data = String(raw);
    if (data === "q" || data === "Q" || data === "\u0003") {
      quit();
    }
  };

  let resolveRun: () => void = () => {};
  let resolved = false;
  const timer = setInterval(() => {
    void draw();
  }, refreshMs);
  input.on("data", onData);
  input.resume();
  // Herdr panes report stdin as non-TTY but still provide a PTY: raw mode
  // is what makes quit keys arrive without Enter. Pipes reject it.
  try {
    input.setRawMode(true);
  } catch {
    // Piped stdin has no raw mode.
  }
  await draw();
  return new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
}

// --- Entry ---

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const project = resolveProject(process.argv.slice(2), process.env);
    await runBoard({ project, input: process.stdin, output: process.stdout });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
