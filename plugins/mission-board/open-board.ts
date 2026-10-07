#!/usr/bin/env node
/** "Mission board" action: opens the board tab for the selected workspace.
 *  Reuses the workspace's stored board pane when it is still open; otherwise
 *  opens a new tab and remembers the returned pane id. Calls Herdr through
 *  HERDR_BIN_PATH with an argument array, never a shell string.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";
import { BOARD_ENTRYPOINT, PLUGIN_ID } from "./plugin.ts";

export interface OpenBoardDeps {
  env: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: string[],
    options: { shell: boolean; stdio: "inherit" | "pipe"; encoding?: "utf8" },
  ) => { status: number | null; error?: Error; stdout?: string };
  stderr?: (text: string) => void;
}

interface PluginContext {
  workspace_id?: unknown;
}

interface PaneState {
  workspaces: Record<string, string>;
}

function readContext(env: NodeJS.ProcessEnv): PluginContext {
  try {
    const parsed: unknown = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as PluginContext)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readPaneState(stateDir: string | undefined): Promise<PaneState> {
  if (!stateDir) return { workspaces: {} };
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(stateDir, "panes.json"), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PaneState).workspaces === "object" &&
      (parsed as PaneState).workspaces !== null
    ) {
      return parsed as PaneState;
    }
    return { workspaces: {} };
  } catch {
    return { workspaces: {} };
  }
}

async function writePaneState(stateDir: string | undefined, state: PaneState): Promise<void> {
  if (!stateDir) return;
  await writeJsonAtomic(join(stateDir, "panes.json"), state, { mode: 0o600 });
}

/** Open (or focus) the board pane; returns the process exit code. */
export async function runOpenBoard(deps: OpenBoardDeps): Promise<number> {
  const spawn =
    deps.spawn ??
    ((command: string, args: string[], options: { shell: boolean; stdio: "inherit" | "pipe"; encoding?: "utf8" }) =>
      spawnSync(command, args, { ...options, encoding: "utf8" }));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const herdr = deps.env.HERDR_BIN_PATH ?? "herdr";
  const stateDirs = [text(deps.env.HERDR_PLUGIN_STATE_DIR), text(deps.env.HERDR_PLUGIN_CONFIG_DIR)].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const stateDir = stateDirs[0];
  const workspace = text(readContext(deps.env).workspace_id);

  const state = await readPaneState(stateDir);
  const stored = workspace ? text(state.workspaces[workspace]) : undefined;
  if (stored) {
    // Focus doubles as the alive check: a gone pane errors here.
    const focused = spawn(herdr, ["plugin", "pane", "focus", stored], {
      shell: false,
      stdio: "inherit",
    });
    if ((focused.status ?? 1) === 0) return 0;
  }

  const opened = spawn(
    herdr,
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      PLUGIN_ID,
      "--entrypoint",
      BOARD_ENTRYPOINT,
      // Tab panes are bound to a workspace; without a workspace context,
      // Herdr opens the manifest default (overlay over the active pane).
      ...(workspace ? (["--placement", "tab", "--workspace", workspace] as const) : []),
    ],
    { shell: false, stdio: "pipe", encoding: "utf8" },
  );
  if ((opened.status ?? 1) !== 0) {
    const detail = opened.error instanceof Error ? `: ${opened.error.message}` : "";
    stderr(`Mission board failed to open (status ${opened.status ?? 1})${detail}\n`);
    return opened.status ?? 1;
  }

  let paneId: string | undefined;
  try {
    // The CLI prints its full response envelope; the socket returns the bare
    // result. Accept both shapes.
    const parsed: unknown = JSON.parse(opened.stdout ?? "{}");
    const sources = [
      parsed as Record<string, unknown>,
      (parsed as {result?: unknown}).result as Record<string, unknown> | undefined,
    ];
    for (const source of sources) {
      const candidate = (source?.plugin_pane as {pane?: {pane_id?: unknown}} | undefined)?.pane
        ?.pane_id;
      if (typeof candidate === "string" && candidate.length > 0) paneId = candidate;
    }
  } catch {
    paneId = undefined;
  }
  if (paneId && workspace) {
    state.workspaces[workspace] = paneId;
    await writePaneState(stateDir, state);
  }
  return opened.status ?? 0;
}

// --- Entry ---

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runOpenBoard({ env: process.env });
}
