/**
 * Autoresearch Extension
 *
 * Karpathy-style autonomous experiment loop, generalized to any measurable
 * target: try an idea, measure it against a baseline, keep improvements
 * (git commit), discard regressions (git revert), repeat. State lives in
 * `.pi/autoresearch/` (config, prompt, append-only log) so a fresh session
 * resumes from files alone; `.pi/autoresearch/` is excluded from git locally
 * so revert cycles can never destroy the experiment record.
 *
 * Continuation: while the loop is active the extension re-prompts the agent
 * after each turn, with runaway guards (iteration cap, stall detection).
 * Metrics alone don't justify keeps — a descriptive spread score (best vs
 * observed run-to-run variation) is reported after every run and the agent
 * is told to re-measure when the delta is small relative to that spread.
 */

import type { ExtensionAPI, ExtensionContext } from "pi";
import { setStripWidget, WIDGET_PRIORITY_AUTORESEARCH } from "../../lib/widget-strip.ts";
import { statusAction, stopAction } from "./src/control.ts";
import { logAction, runAction } from "./src/experiments.ts";
import {
  AUTORESEARCH_STATE_EVENT,
  AUTORESEARCH_STATUS_KEY,
  AUTORESEARCH_WIDGET_KEY,
  buildSummary,
  createAutoresearchWidget,
  formatFooter,
} from "./src/format.ts";
import { initAction } from "./src/init.ts";
import { handleAgentEnd, handleLoopInput } from "./src/loop.ts";
import { entriesAndPending } from "./src/pending.ts";
import { AUTORESEARCH_PARAMETERS } from "./src/schemas.ts";
import { loadConfig, requireActiveConfig } from "./src/store.ts";
import type { AutoConfig, InstanceState, RunEntry } from "./src/types.ts";

// --- Extension ---

export default async function autoresearchExtension(pi: ExtensionAPI) {
  // Per-instance state: the pending measurement slot plus continuation-loop
  // guards (see InstanceState). Module behavior receives this explicitly.
  const state: InstanceState = {
    pending: undefined,
    toolActivity: 0,
    lastSeenActivity: 0,
    continuationQueued: false,
    idleWakes: 0,
  };

  // --- Helpers ---

  function publish(
    ctx: ExtensionContext,
    config: AutoConfig | undefined,
    entries: RunEntry[],
  ): void {
    const summary = config ? buildSummary(config, entries) : undefined;
    pi.events.emit(AUTORESEARCH_STATE_EVENT, {
      active: summary?.active ?? false,
      iterations: summary?.iterations ?? 0,
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus(AUTORESEARCH_STATUS_KEY, formatFooter(ctx.ui.theme, summary));
      if (summary?.active) {
        const widgetState = { summary, entries };
        setStripWidget(ctx.ui, "aboveEditor", {
          key: AUTORESEARCH_WIDGET_KEY,
          priority: WIDGET_PRIORITY_AUTORESEARCH,
          factory: createAutoresearchWidget(() => widgetState),
        });
      } else {
        setStripWidget(ctx.ui, "aboveEditor", {
          key: AUTORESEARCH_WIDGET_KEY,
          priority: WIDGET_PRIORITY_AUTORESEARCH,
          factory: undefined,
        });
      }
    }
  }

  // --- Tool ---

  pi.registerTool({
    name: "autoresearch",
    exposure: "model-only",
    label: "Autoresearch",
    description:
      "Autonomous experiment loop: init a measurable optimization (metric + measure command), then repeat — edit code, run (action=run), log keep-or-discard (action=log). Keeps are git commits, discards revert everything. Use for optimizing measurable targets: test speed, build time, bundle size, benchmark scores.",
    promptGuidelines: [
      "Use autoresearch when the user asks to optimize a measurable metric autonomously. Init needs a deterministic measure command emitting 'METRIC name=value'. After each result, propose the next hypothesis from what was learned before editing again.",
      "A spread score below 1x means the best-vs-baseline delta is small relative to observed run-to-run variation; re-measure before trusting a keep. The tool reports the spread score after every log.",
    ],
    parameters: AUTORESEARCH_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state.toolActivity += 1;
      const action = params.action;
      if (action === "init") return initAction(state, params, ctx, publish);
      // Status works without an active campaign, and reports a stopped one
      // rather than being blocked by the active-session precondition.
      if (action === "status") return statusAction(state, ctx, publish);
      const config = await requireActiveConfig(ctx.cwd, ctx.sessionManager.getSessionId());
      if (action === "run") return runAction(state, config, params, ctx, publish);
      if (action === "log") return logAction(state, config, params, ctx, publish);
      if (action === "stop") return stopAction(state, config, ctx, publish);
      throw new Error(`Unknown autoresearch action: ${String(action)}`);
    },
  });

  // --- Continuation loop ---

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(state, pi, ctx, publish);
  });

  pi.on("input", async (event) => {
    handleLoopInput(state, event);
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Reload starts fresh guards but rebuilds state from disk so an experiment
    // that was pending before the reload can still be logged.
    state.continuationQueued = false;
    state.idleWakes = 0;
    state.toolActivity = 0;
    state.lastSeenActivity = 0;
    state.pending = undefined;
    const config = await loadConfig(ctx.cwd);
    const entries = await entriesAndPending(state, ctx.cwd);

    // Orchestration UI is single-session: only the campaign's owner shows the
    // widget and footer status. Other sessions publish the cleared state so a
    // stale announcement from an earlier campaign cannot linger. Legacy
    // configs (no owner) keep the old visible-anywhere behavior.
    const owned =
      config === undefined ||
      config.stopped === true ||
      config.ownerSessionId === undefined ||
      config.ownerSessionId === ctx.sessionManager.getSessionId();
    publish(ctx, owned ? config : undefined, owned ? entries : []);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Drop per-session state and tell listeners the loop is no longer running;
    // pending.json on disk keeps a mid-experiment reload resumable.
    state.pending = undefined;
    state.continuationQueued = false;
    state.idleWakes = 0;
    state.toolActivity = 0;
    state.lastSeenActivity = 0;
    pi.events.emit(AUTORESEARCH_STATE_EVENT, { active: false, iterations: 0 });
    if (ctx.hasUI) {
      ctx.ui.setStatus(AUTORESEARCH_STATUS_KEY, undefined);
      setStripWidget(ctx.ui, "aboveEditor", {
        key: AUTORESEARCH_WIDGET_KEY,
        priority: WIDGET_PRIORITY_AUTORESEARCH,
        factory: undefined,
      });
    }
  });
}
