#!/usr/bin/env node
/** "Mission board" action: opens the board pane for the selected workspace.
 *  Split beside the focused pane when the runtime context provides one;
 *  otherwise let Herdr open the manifest's default overlay. Calls Herdr
 *  through HERDR_BIN_PATH with an argument array, never a shell string.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BOARD_ENTRYPOINT, PLUGIN_ID } from "./plugin.ts";

export interface OpenBoardDeps {
  env: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: string[],
    options: { shell: boolean; stdio: "inherit" },
  ) => { status: number | null; error?: Error };
  stderr?: (text: string) => void;
}

interface PluginContext {
  focused_pane_id?: unknown;
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
/** Open the board pane; returns the process exit code. */
export async function runOpenBoard(deps: OpenBoardDeps): Promise<number> {
  const spawn =
    deps.spawn ??
    ((command: string, args: string[], options: { shell: boolean; stdio: "inherit" }) =>
      spawnSync(command, args, options));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const herdr = deps.env.HERDR_BIN_PATH ?? "herdr";
  const context = readContext(deps.env);
  const focused = text(context.focused_pane_id);

  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    BOARD_ENTRYPOINT,
  ];
  // Split/zoomed panes target an existing pane and inherit its workspace;
  // an explicit --workspace is rejected. Without a focused pane, Herdr's
  // default overlay applies.
  if (focused) args.push("--placement", "split", "--target-pane", focused);

  const open = (): { status: number | null; error?: Error } =>
    spawn(herdr, args, { shell: false, stdio: "inherit" });
  let result = open();
  if (focused && (result.status ?? 1) !== 0) {
    // The focused pane may not be split-eligible (for example it belongs to
    // a workspace that is not active). Retry with the manifest's overlay.
    const retryArgs = args.slice(
      0,
      args.indexOf("--placement"),
    );
    result = spawn(herdr, retryArgs, { shell: false, stdio: "inherit" });
  }
  const status = result.status ?? 1;
  if (status !== 0) {
    const detail = result.error instanceof Error ? `: ${result.error.message}` : "";
    stderr(`Mission board failed to open (status ${status})${detail}\n`);
  }
  return status;
}

// --- Entry ---

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runOpenBoard({ env: process.env });
}
