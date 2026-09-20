/** Continuation loop: while the campaign is active, re-prompt the owning agent
 *  after each turn so the experiment cycle keeps going, with runaway guards
 *  (iteration cap, stall detection). */

import type { ExtensionAPI, ExtensionContext } from "pi";
import { projectStateRelative } from "../../../lib/paths.ts";
import { loadConfig, readLog, saveConfig } from "./store.ts";
import type { InstanceState, PublishFn } from "./types.ts";

function buildContinuationPrompt(): string {
  return `Continue the autoresearch loop. Re-read ${projectStateRelative("autoresearch")}/prompt.md and the tail of ${projectStateRelative("autoresearch")}/log.jsonl, then: pick the next hypothesis, edit the code, run the autoresearch tool (action=run), and log the result (action=log, keep or discard). If the cap is reached or you genuinely cannot improve further, call action=stop.`;
}

export async function handleAgentEnd(
  state: InstanceState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<void> {
  const config = await loadConfig(ctx.cwd);
  if (!config || config.stopped) return;
  // Ownership gate: the continuation loop is driven only by the session
  // that created the campaign. Project state is shared, so another
  // session's turn must never be hijacked into running this experiment
  // loop (legacy configs without an owner keep the old behavior).
  if (
    config.ownerSessionId !== undefined &&
    config.ownerSessionId !== ctx.sessionManager.getSessionId()
  ) {
    return;
  }
  if (state.continuationQueued || ctx.hasPendingMessages()) return;

  const entries = await readLog(ctx.cwd);
  const iterations = entries.filter((e) => e.status === "keep" || e.status === "discard").length;
  if (config.maxIterations !== undefined && iterations >= config.maxIterations) {
    config.stopped = true;
    await saveConfig(ctx.cwd, config);
    publish(ctx, config, entries);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Autoresearch iteration cap (${config.maxIterations}) reached. Loop stopped.`,
        "info",
      );
    }
    return;
  }

  // Stall guard: two consecutive continuations with zero autoresearch tool
  // activity mean the loop is not actually running — stop and hand control
  // back. Log growth alone is the wrong signal: the agent legitimately
  // interleaves other work (mission tasks, user questions) between
  // experiments, and settle boundaries do not align with work boundaries.
  if (state.toolActivity !== state.lastSeenActivity) {
    state.lastSeenActivity = state.toolActivity;
    state.idleWakes = 0;
  } else {
    state.idleWakes += 1;
  }
  if (state.idleWakes >= 2) {
    config.stopped = true;
    await saveConfig(ctx.cwd, config);
    publish(ctx, config, entries);
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Autoresearch stopped: no new experiments were logged after repeated prompts.",
        "warning",
      );
    }
    return;
  }

  state.continuationQueued = true;
  pi.sendUserMessage(buildContinuationPrompt(), { deliverAs: "followUp" });
}

export function handleLoopInput(state: InstanceState, event: unknown): void {
  const source = (event as { source?: string }).source;
  if (source !== "interactive") {
    // Our own followUp was delivered — reset guards for the next cycle.
    state.continuationQueued = false;
  }
}
