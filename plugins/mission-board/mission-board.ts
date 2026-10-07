#!/usr/bin/env node
/** Read-only Herdr pane that renders a project's missions from
 *  `<project>/.pi/missions/` in the worker-cards visual language. The
 *  missions extension owns that state; this board only reads it. Runs under
 *  strip-only Node without a build step.
 *
 *  Usage (from the manifest pane entrypoint): the project comes from
 *  HERDR_PLUGIN_CONTEXT_JSON (workspace_cwd, then focused_pane_cwd).
 *  `--project <path>` overrides both for manual runs.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import { renderModalFrame, modalContentWidth } from "../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../lib/ui-format.ts";
import { workerViewTheme } from "../../extensions/herdr/src/worker-cards.ts";
import { listMissionSummaries, loadMission } from "../../extensions/missions/src/storage.ts";
import type { Mission, MissionSummary } from "../../extensions/missions/src/types.ts";

// --- Constants ---

const theme = workerViewTheme;

const TASK_STATUS_ORDER = [
  "in_progress",
  "blocked",
  "regressed",
  "failed",
  "todo",
  "done",
] as const;

const TASK_STATUS_MARKS: Record<string, readonly [string, string]> = {
  in_progress: ["\u25b8", "accent"],
  blocked: ["\u26d4", "warning"],
  regressed: ["\u26a0", "error"],
  failed: ["\u2717", "error"],
  todo: ["\u00b7", "text"],
  done: ["\u2713", "success"],
};

const MISSION_STATES: Record<string, readonly [string, string]> = {
  planning: ["\u25cb", "muted"],
  active: ["\u25c8", "accent"],
  paused: ["\u2022", "warning"],
  complete: ["\u2713", "success"],
  aborted: ["\u2717", "error"],
};

// --- Text helpers ---

/** Remove terminal escapes and control characters from mission text. */
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function dim(text: string): string {
  return theme.fg("dim", text);
}

function taskTotal(summary: MissionSummary): number {
  return Object.values(summary.taskCounts).reduce((total, count) => total + count, 0);
}

function missionState(status: string): readonly [string, string] {
  return MISSION_STATES[status] ?? ["\u00b7", "muted"];
}

function progressText(counts: Record<string, number>, total: number): string {
  const done = counts.done ?? 0;
  const failing = (counts.failed ?? 0) + (counts.regressed ?? 0);
  const parts = [`tasks ${done}/${total}`];
  if (failing > 0) parts.push(`${failing} failing`);
  return parts.join(" \u00b7 ");
}

// --- Board data ---

export interface BoardData {
  project: string;
  newest?: Mission | undefined;
  rest: MissionSummary[];
  skipped: string[];
}

export async function loadBoardData(project: string): Promise<BoardData> {
  const { summaries, skipped } = await listMissionSummaries(project);
  const [newestSummary, ...rest] = summaries;
  let newest: Mission | undefined;
  if (newestSummary) {
    try {
      newest = await loadMission(project, newestSummary.id);
    } catch {
      newest = undefined;
    }
  }
  return { project, newest, rest, skipped };
}

// --- Rendering ---

function expandedCard(mission: Mission, width: number, rows: number): string[] {
  const [icon, color] = missionState(mission.status);
  const done = mission.tasks.filter((task) => task.status === "done").length;
  const failing = mission.tasks.filter(
    (task) => task.status === "failed" || task.status === "regressed",
  ).length;
  const progress = [`tasks ${done}/${mission.tasks.length}`];
  if (failing > 0) progress.push(`${failing} failing`);
  const { maxIterations = 0, maxTokens = 0 } = mission.budget ?? {};
  const budget = [
    `${mission.spent.iterations}${maxIterations ? `/${maxIterations}` : ""} iterations`,
    `${mission.spent.tokens.toLocaleString("en-US")} tokens`,
  ].join(" \u00b7 ");

  const body: string[] = [
    theme.fg("text", truncateToWidth(clean(mission.objective), Math.max(1, width - 4))),
    dim(progress.join(" \u00b7 ")),
    dim(
      `budget ${budget}${mission.updatedAt ? ` \u00b7 updated ${new Date(mission.updatedAt).toISOString().slice(0, 10)}` : ""}`,
    ),
  ];
  let shown = 0;
  for (const status of TASK_STATUS_ORDER) {
    for (const task of mission.tasks.filter((candidate) => candidate.status === status)) {
      if (body.length >= rows) break;
      const [mark, markColor] = TASK_STATUS_MARKS[task.status] ?? ["\u00b7", "text"];
      const parts = [
        `${theme.fg(markColor, mark)} ${task.id} ${truncateToWidth(clean(task.title), Math.max(1, width - 12))}`,
      ];
      if (task.dependsOn.length > 0)
        parts.push(dim(`(after ${task.dependsOn.join(", ")})`));
      if (task.owner) parts.push(dim(`(owner ${task.owner})`));
      body.push(theme.fg("text", truncateToWidth(parts.join(" "), Math.max(1, width - 4))));
      shown += 1;
    }
  }
  const remaining = mission.tasks.length - shown;
  if (remaining > 0) body.push(dim(`\u2026 ${remaining} more tasks`));
  const checkpoint = mission.checkpoints.at(-1);
  if (checkpoint && body.length < rows) {
    const commit = checkpoint.commit ? ` (${clean(checkpoint.commit)})` : "";
    body.push(
      truncateToWidth(
        `${theme.fg("accent", "\u25c8")} ${clean(checkpoint.label)} ${dim(clean(checkpoint.summary) + commit)}`,
        Math.max(1, width - 4),
      ),
    );
  }
  const decision = mission.decisions.at(-1);
  if (decision && body.length < rows) {
    body.push(
      truncateToWidth(
        `${theme.fg("accent", "\u2023")} ${clean(decision.text)}`,
        Math.max(1, width - 4),
      ),
    );
  }
  return body.slice(0, rows);
}

function summaryCard(summary: MissionSummary, width: number, rows: number): string[] {
  const [icon, color] = missionState(summary.status);
  const title = truncateToWidth(
    clean(summary.title),
    Math.max(1, width - visibleWidth(icon) - 10),
  );
  const head = `${theme.fg(color, icon)} ${theme.fg("accent", title)}`;
  const detail = dim(
    `${summary.status} \u00b7 ${progressText(summary.taskCounts, taskTotal(summary))}`,
  );
  return [head, truncateToWidth(detail, Math.max(1, width - 4))].slice(0, Math.max(1, rows));
}

/** Render the framed board lines for a project. */
export function renderBoardFrame(
  data: BoardData,
  width: number,
  height: number,
): string[] {
  const hints = formatStyledKeyHints(theme, [
    ["q", "close"],
    ["1s", "refresh"],
  ]);
  const summary = theme.fg(
    "muted",
    `Read-only \u00b7 ${data.rest.length + (data.newest ? 1 : 0)} missions \u00b7 ${truncateToWidth(data.project, Math.max(1, width - 30))}`,
  );
  if (height < 4 || width < 4) {
    return [summary].slice(0, Math.max(0, height - 1)).concat(hints);
  }

  const body: string[] = [summary];
  if (!data.newest && data.rest.length === 0) {
    body.push("", theme.fg("dim", "No missions. Start one with the mission tool (action=create)."), "", hints);
    return renderModalFrame(theme, width, body, { title: "Missions", paddingX: 1, paddingY: 0 }).slice(0, height);
  }

  const cardWidth = modalContentWidth(width, 1);
  if (width < 34 || height < 12) {
    // Compact rows for tight panes.
    if (data.newest) {
      const counts: Record<string, number> = {};
      for (const task of data.newest.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
      body.push(
        truncateToWidth(
          `${theme.fg(missionState(data.newest.status)[1], missionState(data.newest.status)[0])} ${theme.fg("accent", clean(data.newest.title))} ${dim(`${data.newest.status} \u00b7 ${progressText(counts, data.newest.tasks.length)}`)}`,
          width - 2,
        ),
      );
      body.push(truncateToWidth(dim(clean(data.newest.objective)), width - 2));
    }
    for (const other of data.rest) {
      body.push(truncateToWidth(summaryLineText(other), width - 2));
    }
    if (data.skipped.length > 0)
      body.push(theme.fg("warning", `skipped ${data.skipped.length} corrupt file(s)`));
    body.push(hints);
    return renderModalFrame(theme, width, body, { title: "Missions", paddingX: 1, paddingY: 0 }).slice(0, height);
  }

  if (data.newest) {
    const [icon, color] = missionState(data.newest.status);
    const cardHeight = Math.min(12, Math.max(6, height - data.rest.length * 5 - 8));
    body.push("");
    body.push(
      ...renderModalFrame(theme, cardWidth, expandedCard(data.newest, cardWidth, cardHeight - 2), {
        title: `${theme.fg(color, icon)} ${theme.fg("accent", truncateToWidth(clean(data.newest.title), Math.max(1, cardWidth - 8)))}`,
        rawTitle: true,
        titleRight: theme.fg(color, data.newest.status),
        borderColor: "borderMuted",
        paddingX: 1,
        paddingY: 0,
        fixedBodyRows: cardHeight - 2,
      }),
    );
  }
  for (const other of data.rest) {
    body.push("");
    body.push(...summaryCard(other, cardWidth, 2));
  }
  if (data.skipped.length > 0) {
    const skippedList = truncateToWidth(
      data.skipped.join(", "),
      Math.max(1, width - 30),
    );
    body.push(
      theme.fg("warning", `skipped ${data.skipped.length} corrupt mission file(s): ${skippedList}`),
    );
  }
  body.push("", hints);
  // Keep the close hint on screen, even with many missions.
  const budget = Math.max(1, height - 1);
  if (body.length > budget) body.splice(Math.max(0, budget - 1), body.length, hints);
  return renderModalFrame(theme, width, body, {
    title: "Missions",
    paddingX: 1,
    paddingY: 0,
  }).slice(0, height);
}

function summaryLineText(summary: MissionSummary): string {
  const [icon, color] = missionState(summary.status);
  return `${theme.fg(color, icon)} ${clean(summary.title)} ${dim(`${summary.status} \u00b7 ${progressText(summary.taskCounts, taskTotal(summary))}`)}`;
}

/** Render the full board frame for a project directory. */
export async function renderBoard(
  project: string,
  options: { width?: number; height?: number } = {},
): Promise<string> {
  const data = await loadBoardData(project);
  return `${renderBoardFrame(data, options.width ?? 100, options.height ?? 30).join("\n")}\n`;
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
  output: { write(text: string): unknown; columns?: number; rows?: number };
  refreshMs?: number;
}

/** Draw the board, refresh it once per second, and quit on q or Ctrl+C. */
export async function runBoard(streams: BoardStreams): Promise<void> {
  const { project, input, output } = streams;
  const refreshMs = streams.refreshMs ?? 1_000;
  let resolved = false;
  let resolveRun: () => void = () => {};

  const draw = async (): Promise<void> => {
    let frame: string;
    try {
      const data = await loadBoardData(project);
      const width = output.columns ?? 100;
      const height = output.rows ?? 30;
      frame = `\u001b[H\u001b[J${renderBoardFrame(data, width, height).join("\n")}\n`;
    } catch (error) {
      frame = `Mission board failed: ${(error as Error).message}\n`;
    }
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
