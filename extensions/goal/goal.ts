/**
 * Goal Extension
 *
 * Provides /goal commands for goal-oriented auto-continuation: the extension
 * keeps an objective in view each turn and a small-model evaluator decides
 * after every turn whether the goal is met, not yet met (its reason becomes
 * the next continuation's guidance), or impossible (the goal pauses).
 *
 * Cache safety: the system prompt is never modified. The goal reminder is
 * injected as a tail-position message each turn and stale copies are stripped
 * from history, so the request prefix stays byte-stable across turns.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import { promptText } from "../../lib/input-modal.ts";
import { extractToolCallBlocks } from "../../lib/session-utils.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { parseNewGoalArgs, validateObjective } from "./src/command-parser.ts";
import {
  COMPLETION_STATUS_DURATION,
  DEFAULT_MAX_ITERATIONS,
  GOAL_CONTEXT_TYPE,
  ICON_COLOR,
  NO_TOOL_TURN_LIMIT,
  STATE_EVENT,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
} from "./src/constants.ts";
import { type EvaluatorVerdict, evaluateGoal } from "./src/evaluator.ts";
import { buildStatusLine, formatElapsed, formatTokens, getElapsedMs } from "./src/formatting.ts";
import {
  buildContinuePrompt,
  buildGoalContextPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
  buildStartPrompt,
} from "./src/prompts.ts";
import { generateGoalId, reconstructState } from "./src/state.ts";
import type { GoalState } from "./src/types.ts";

// --- Extension ---

export default async function goalExtension(pi: ExtensionAPI) {
  let state: GoalState | null = null;
  let continuationQueued = false;
  let evaluating = false;
  let completionStatusTimer: NodeJS.Timeout | undefined;

  function persistState() {
    pi.appendEntry("goal-state", { goal: state });
  }

  function resetContinuationGuard() {
    continuationQueued = false;
  }

  function updateStatusLine(ctx: ExtensionContext) {
    // Publish on the event bus for the status-bar extension's editor badge,
    // regardless of UI mode (the event is inert when nothing subscribes).
    pi.events.emit(STATE_EVENT, { status: state?.status ?? null });
    if (!ctx.hasUI) return;
    const text = state ? buildStatusLine(state) : undefined;
    ctx.ui.setStatus(
      STATUS_KEY,
      text === undefined
        ? undefined
        : formatStatusLine(ctx.ui.theme, {
            icon: STATUS_ICON,
            prefix: "Goal",
            text,
            iconColor: ICON_COLOR,
            textColor: TEXT_COLOR,
          }),
    );
  }

  function clearCompletionStatus(ctx: ExtensionContext) {
    if (completionStatusTimer) {
      clearTimeout(completionStatusTimer);
      completionStatusTimer = undefined;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function showCompletionStatus(ctx: ExtensionContext) {
    updateStatusLine(ctx);
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(ctx.ui.theme, {
        icon: STATUS_ICON,
        prefix: "Goal",
        text: "complete",
        iconColor: ICON_COLOR,
        textColor: TEXT_COLOR,
      }),
    );
    completionStatusTimer = setTimeout(() => {
      completionStatusTimer = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }, COMPLETION_STATUS_DURATION);
  }

  /** Pause the active goal and hand control back to the user. */
  function pauseGoal(ctx: ExtensionContext, reason: string) {
    if (!state) return;
    state.status = "paused";
    resetContinuationGuard();
    persistState();
    updateStatusLine(ctx);
    ctx.ui.notify(reason, "warning");
  }

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    state = reconstructState(ctx);
    if (state) {
      updateStatusLine(ctx);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state) persistState();
    resetContinuationGuard();
    evaluating = false;
    clearCompletionStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = reconstructState(ctx);
    if (state) {
      updateStatusLine(ctx);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("input", async (event) => {
    const source = (event as { source?: string }).source;
    if (source !== "interactive") {
      // A queued message was delivered (source "extension" via sendUserMessage
      // or "rpc") — reset the guard so this turn's agent_end evaluates again
      // and the continuation loop keeps running unattended.
      resetContinuationGuard();
      return;
    }
    if (continuationQueued && state) {
      resetContinuationGuard();
    }
  });

  // Inject the goal reminder as a per-turn tail message. Stale copies are
  // stripped by the context handler below, so the request prefix stays stable
  // and the reminder itself carries no per-turn-varying content.
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (state?.status !== "active") return undefined;
    return {
      message: {
        customType: GOAL_CONTEXT_TYPE,
        content: [{ type: "text", text: buildGoalContextPrompt(state) }],
        display: false,
      },
    };
  });

  // Goal reminders are re-injected fresh every turn, so stale copies from
  // earlier turns are dropped from context unconditionally. Nothing to strip
  // when no goal is active, so skip the allocation.
  pi.on("context", async (event) => {
    const stales = (event.messages as Array<{ customType?: string }>).some(
      (message) => message.customType === GOAL_CONTEXT_TYPE,
    );
    if (!stales) return undefined;
    return {
      messages: (event.messages as Array<{ customType?: string }>).filter(
        (message) => message.customType !== GOAL_CONTEXT_TYPE,
      ),
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (state?.status !== "active") return;

    const usage = ctx.getContextUsage();
    if (usage && usage.tokens !== null) {
      state.tokensUsed = Math.max(0, usage.tokens - state.baselineTokens);
    }

    const now = Date.now();
    if (state.lastTurnTimestamp) {
      state.elapsedMs += now - state.lastTurnTimestamp;
    }
    state.lastTurnTimestamp = now;

    persistState();
    updateStatusLine(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (state?.status !== "active") return;
    if (continuationQueued || evaluating) return;
    if (ctx.hasPendingMessages()) return;

    evaluating = true;
    let verdict: EvaluatorVerdict;
    try {
      verdict = await evaluateGoal(state.objective, ctx);
    } catch (err) {
      evaluating = false;
      // Fail safe: keep the goal active and let the user's next message
      // re-trigger evaluation, instead of looping on a broken evaluator.
      ctx.ui.notify(
        `Goal evaluation failed: ${(err as Error).message}. The goal stays active; send a message to retry.`,
        "warning",
      );
      return;
    }
    evaluating = false;

    // The goal may have been paused, reset, or replaced while evaluating.
    if (state?.status !== "active") return;
    state.lastEvaluatorReason = verdict.reason;

    if (verdict.status === "met") {
      state.status = "complete";
      persistState();
      showCompletionStatus(ctx);
      ctx.ui.notify(`Goal complete: ${verdict.reason}`, "info");
      return;
    }

    if (verdict.status === "impossible") {
      pauseGoal(
        ctx,
        `Goal paused: the evaluator judged the objective impossible to satisfy. ${verdict.reason}`,
      );
      return;
    }

    // not_met: runaway guards, then queue the next continuation.
    const cap = state.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (cap > 0 && state.iteration >= cap) {
      pauseGoal(
        ctx,
        `Iteration cap reached (${cap}). Goal paused. Use /goal:resume to continue or /goal:reset to cancel.`,
      );
      return;
    }

    const turnHadToolUse = (event.messages as Array<{ content?: unknown }>).some(
      (message) => extractToolCallBlocks(message?.content).length > 0,
    );
    state.consecutiveNoToolTurns = turnHadToolUse ? 0 : (state.consecutiveNoToolTurns ?? 0) + 1;
    if (state.consecutiveNoToolTurns >= NO_TOOL_TURN_LIMIT) {
      pauseGoal(
        ctx,
        `No progress detected (${NO_TOOL_TURN_LIMIT} consecutive turns without tool calls). Goal paused. Use /goal:resume to continue or /goal:reset to cancel.`,
      );
      return;
    }

    continuationQueued = true;
    state.iteration += 1;
    persistState();
    updateStatusLine(ctx);
    pi.sendUserMessage(buildContinuePrompt(state), { deliverAs: "followUp" });
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as { role?: string; stopReason?: string } | undefined;
    if (msg?.role !== "assistant") return;

    const stopReason = msg.stopReason;
    if (stopReason === "aborted" || stopReason === "error") {
      if (state && state.status === "active") {
        pauseGoal(ctx, "Goal paused due to interruption or error. Use /goal:resume to continue.");
      }
    }
  });

  // --- Commands ---

  async function startGoal(args: string, ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) return;
    const parsed = parseNewGoalArgs(args);
    if (parsed.error) {
      ctx.ui.notify(parsed.error, "warning");
      return;
    }

    let objective = parsed.objective;
    if (!objective) {
      // No inline objective — prompt for one in the shared framed input modal.
      objective = (
        await promptText(ctx, {
          title: "Goal",
          placeholder: "What should this run accomplish?",
        })
      )?.trim();
      if (!objective) return;
    }
    const validationError = validateObjective(objective);
    if (validationError) {
      ctx.ui.notify(validationError, "warning");
      return;
    }

    // Confirm replacement of unfinished goal
    if (state && state.status !== "complete") {
      const confirmed = await ctx.ui.confirm(
        "Replace current goal?",
        `Current goal: "${state.objective}"\nNew goal: "${objective}"\n\nThis will reset usage counters.`,
      );
      if (!confirmed) return;
    }

    const usage = ctx.getContextUsage();
    state = {
      id: generateGoalId(),
      objective,
      status: "active",
      startTime: Date.now(),
      elapsedMs: 0,
      iteration: 0,
      tokensUsed: 0,
      baselineTokens: usage?.tokens ?? 0,
      consecutiveNoToolTurns: 0,
    };
    state.maxIterations = parsed.iterations ?? DEFAULT_MAX_ITERATIONS;

    clearCompletionStatus(ctx);
    resetContinuationGuard();
    persistState();
    updateStatusLine(ctx);

    pi.sendUserMessage(buildStartPrompt(state), { deliverAs: "followUp" });

    const capNote =
      parsed.iterations === undefined
        ? ""
        : parsed.iterations === 0
          ? " (unlimited iterations)"
          : ` (max ${parsed.iterations} iterations)`;
    ctx.ui.notify(`Goal started${capNote}: ${objective}`, "info");
  }

  pi.registerCommand("goal", {
    description: "Start a goal and run it to completion (alias for /goal:new)",
    handler: startGoal,
  });

  pi.registerCommand("goal:status", {
    description:
      "Show the active goal, status, elapsed time, token spend, iteration count, and last evaluator reason",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (!state) {
        ctx.ui.notify("No active goal. Use /goal:new <objective> to start one.", "info");
        return;
      }
      const elapsed = formatElapsed(getElapsedMs(state));
      const cap = state.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const capLabel = cap === 0 ? "unlimited" : String(cap);
      const lines = [
        `Goal: ${state.objective}`,
        `Status: ${state.status} | Elapsed: ${elapsed} | Tokens: ${formatTokens(state.tokensUsed)} | Iterations: ${state.iteration}/${capLabel}`,
      ];
      if (state.lastEvaluatorReason) {
        lines.push(`Last evaluator: ${state.lastEvaluatorReason}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("goal:new", {
    description:
      "Start a goal and run it to completion: /goal:new [--iterations <count>] [objective]",
    handler: startGoal,
  });

  pi.registerCommand("goal:edit", {
    description: "Edit the current goal objective: /goal:edit [objective]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (!state) {
        ctx.ui.notify("No active goal to edit. Use /goal:new <objective> to start one.", "error");
        return;
      }
      let objective = args.trim() || undefined;
      if (!objective) {
        // No inline objective — open the input modal prefilled with the
        // current one so it can be tweaked in place.
        objective = (
          await promptText(ctx, {
            title: "Goal",
            placeholder: "Objective",
            initialValue: state.objective,
          })
        )?.trim();
        if (!objective) return;
      }
      const validationError = validateObjective(objective);
      if (validationError) {
        ctx.ui.notify(validationError, "warning");
        return;
      }

      state.objective = objective;
      state.consecutiveNoToolTurns = 0;
      persistState();
      updateStatusLine(ctx);
      ctx.ui.notify(`Goal updated: ${objective}`, "info");

      if (state.status === "active") {
        pi.sendUserMessage(buildObjectiveUpdatedPrompt(state), { deliverAs: "followUp" });
      }
    },
  });

  pi.registerCommand("goal:pause", {
    description: "Pause auto-continuation for the active goal",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (state?.status !== "active") {
        ctx.ui.notify("No active goal to pause.", "info");
        return;
      }
      state.status = "paused";
      resetContinuationGuard();
      persistState();
      updateStatusLine(ctx);
      ctx.ui.notify("Goal paused. Use /goal:resume to continue.", "info");
    },
  });

  pi.registerCommand("goal:resume", {
    description: "Resume a paused goal",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (!state) {
        ctx.ui.notify("No goal to resume. Use /goal:new <objective> to start one.", "info");
        return;
      }
      if (state.status === "active") {
        ctx.ui.notify("Goal is already active.", "info");
        return;
      }
      if (state.status === "complete") {
        ctx.ui.notify("Goal is already complete.", "info");
        return;
      }

      state.status = "active";
      state.lastTurnTimestamp = Date.now();
      state.consecutiveNoToolTurns = 0;
      clearCompletionStatus(ctx);
      resetContinuationGuard();
      persistState();
      updateStatusLine(ctx);

      pi.sendUserMessage(buildResumePrompt(state), { deliverAs: "followUp" });

      ctx.ui.notify("Goal resumed.", "info");
    },
  });

  pi.registerCommand("goal:reset", {
    description: "Cancel the current goal and reset usage counters (asks for confirmation)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (!state) {
        ctx.ui.notify("No goal to reset.", "info");
        return;
      }

      // Resetting discards the objective and all usage counters — confirm
      // before wiping so a stray keystroke can't lose an active goal.
      const confirmed = await ctx.ui.confirm(
        "Reset current goal?",
        `Goal: "${state.objective}"\n\nThis discards the goal and its usage counters.`,
      );
      if (!confirmed) return;

      state = null;
      resetContinuationGuard();
      persistState();
      updateStatusLine(ctx);
      clearCompletionStatus(ctx);

      ctx.ui.notify("Goal reset.", "info");
    },
  });
}
