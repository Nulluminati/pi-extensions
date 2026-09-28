/** Campaign control and reporting (action=status, action=stop). Status works
 *  without an active campaign; stop reverts a pending experiment and marks
 *  the config stopped, keeping config and log for the record. */

import type { AgentToolResult, ExtensionContext } from "pi";
import { projectStateRelative } from "../../../lib/paths.ts";
import { buildSummary, formatSummary } from "./format.ts";
import { discardExperiment } from "./measure.ts";
import { clearPending, entriesAndPending, loadPending } from "./pending.ts";
import { loadConfig, loadUntrackedSnapshot, readLog, stopConfig } from "./store.ts";
import type { AutoConfig, InstanceState, PublishFn } from "./types.ts";

// --- Status action ---

export async function statusAction(
  state: InstanceState,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<AgentToolResult> {
  const cwd = ctx.cwd;
  const config = await loadConfig(cwd);
  if (!config) {
    return {
      content: [{ type: "text", text: "No autoresearch session in this project." }],
      details: { active: false },
    };
  }
  const entries = await entriesAndPending(state, cwd);
  publish(ctx, config, entries);
  return {
    content: [{ type: "text", text: formatSummary(buildSummary(config, entries), entries) }],
    details: { summary: buildSummary(config, entries) },
  };
}

// --- Stop action ---

export async function stopAction(
  state: InstanceState,
  config: AutoConfig,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<AgentToolResult> {
  const cwd = ctx.cwd;
  await loadPending(state, cwd);
  const entries = await readLog(cwd);
  if (state.pending) {
    // A pending run means uncommitted experiment changes; revert them.
    // Failures surface instead of being swallowed so state stays honest.
    await discardExperiment(cwd, await loadUntrackedSnapshot(cwd), config.dirtyAtInit);
    await clearPending(state, cwd);
  }
  const stopped = (await stopConfig(cwd)) ?? { ...config, stopped: true };
  publish(ctx, stopped, entries);
  return {
    content: [
      {
        type: "text",
        text: `Autoresearch stopped. Config and log kept in ${projectStateRelative("autoresearch")}/.`,
      },
    ],
    details: { active: false },
  };
}
