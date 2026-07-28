/**
 * Goal Extension
 *
 * Provides /goal command and goal_complete tool for goal-oriented
 * auto-continuation mode with Codex-like persistence instructions.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { parseGoalArgs, validateObjective } from "./src/command-parser.ts";
import {
  COMPLETION_STATUS_DURATION,
  ICON_COLOR,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
} from "./src/constants.ts";
import { buildStatusLine, formatElapsed, formatTokens, getElapsedMs } from "./src/formatting.ts";
import {
  buildContinuePrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
  buildStartPrompt,
} from "./src/prompts.ts";
import { renderGoalCompleteResult } from "./src/renderer.ts";
import { generateGoalId, reconstructState } from "./src/state.ts";
import {
  GOAL_COMPLETE_DESCRIPTION,
  GOAL_COMPLETE_PARAMETERS,
  GOAL_COMPLETE_PROMPT_GUIDELINES,
  GOAL_COMPLETE_PROMPT_SNIPPET,
} from "./src/tool.ts";
import type { GoalState } from "./src/types.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR };

// --- Extension ---

export default async function goalExtension(pi: ExtensionAPI) {
  let state: GoalState | null = null;
  let goalCompleteCalled = false;
  let continuationQueued = false;
  let completionStatusTimer: NodeJS.Timeout | undefined;

  function persistState() {
    pi.appendEntry("goal-state", { goal: state });
  }

  function resetContinuationGuard() {
    continuationQueued = false;
    goalCompleteCalled = false;
  }

  function updateStatusLine(ctx: ExtensionContext) {
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

  function enableGoalCompleteTool() {
    const active = pi.getActiveTools();
    if (!active.includes("goal_complete")) {
      pi.setActiveTools([...active, "goal_complete"]);
    }
  }

  function disableGoalCompleteTool() {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "goal_complete"));
  }

  function maybeQueueContinuation(ctx: ExtensionContext) {
    if (state?.status !== "active") return;
    if (continuationQueued) return;
    if (ctx.hasPendingMessages()) return;

    continuationQueued = true;
    state.iteration++;
    persistState();

    pi.sendUserMessage(buildContinuePrompt(state), { deliverAs: "followUp" });
  }

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    state = reconstructState(ctx);
    if (state) {
      updateStatusLine(ctx);
      enableGoalCompleteTool();
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      disableGoalCompleteTool();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state) persistState();
    resetContinuationGuard();
    clearCompletionStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = reconstructState(ctx);
    if (state) {
      updateStatusLine(ctx);
      enableGoalCompleteTool();
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      disableGoalCompleteTool();
    }
  });

  pi.on("input", async (event) => {
    if (event.source !== "interactive") return;
    if (continuationQueued && state) {
      resetContinuationGuard();
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (state?.status !== "active") return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(state)}`,
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

  pi.on("agent_end", async (_event, ctx) => {
    if (state?.status !== "active") return;

    if (goalCompleteCalled) {
      goalCompleteCalled = false;
      return;
    }

    // Budget check
    if (state.tokenBudget && state.tokensUsed >= state.tokenBudget) {
      state.status = "budget";
      persistState();
      updateStatusLine(ctx);
      disableGoalCompleteTool();
      ctx.ui.notify(
        `Token budget reached (${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}). Use /goal budget <amount> to increase budget or /goal clear to cancel.`,
        "warning",
      );
      return;
    }

    // Pending messages take priority
    if (ctx.hasPendingMessages()) return;

    maybeQueueContinuation(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role !== "assistant") return;

    const stopReason = msg.stopReason;
    if (stopReason === "aborted" || stopReason === "error") {
      if (state && state.status === "active") {
        state.status = "paused";
        resetContinuationGuard();
        persistState();
        updateStatusLine(ctx);
        disableGoalCompleteTool();
        ctx.ui.notify(
          "Goal paused due to interruption or error. Use /goal resume to continue.",
          "warning",
        );
      }
    }
  });

  // --- Tool ---

  pi.registerTool({
    name: "goal_complete",
    label: "Goal Complete",
    description: GOAL_COMPLETE_DESCRIPTION,
    promptSnippet: GOAL_COMPLETE_PROMPT_SNIPPET,
    promptGuidelines: GOAL_COMPLETE_PROMPT_GUIDELINES,
    parameters: GOAL_COMPLETE_PARAMETERS,
    renderResult: renderGoalCompleteResult,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (state?.status !== "active") {
        return {
          content: [{ type: "text", text: "No active goal to complete." }],
          details: { error: "no_active_goal" },
          terminate: true,
        };
      }

      goalCompleteCalled = true;
      state.status = "complete";
      persistState();
      updateStatusLine(ctx);
      disableGoalCompleteTool();
      resetContinuationGuard();
      clearCompletionStatus(ctx);

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

      return {
        content: [
          {
            type: "text",
            text: params.summary ? `Goal completed: ${params.summary}` : "Goal completed.",
          },
        ],
        details: { status: "complete", summary: params.summary },
        terminate: true,
      };
    },
  });

  // --- Command ---

  pi.registerCommand("goal", {
    description:
      "Run a goal to completion: /goal [--tokens 100k] <objective> | /goal budget <amount> | /goal pause|resume|clear|edit|status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseGoalArgs(args);

      if (parsed.error) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      switch (parsed.subcommand) {
        case "status": {
          if (!state) {
            ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "info");
            return;
          }
          const elapsed = formatElapsed(getElapsedMs(state));
          const budget = state.tokenBudget
            ? ` | Budget: ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}`
            : "";
          const iter = ` | Iterations: ${state.iteration}`;
          ctx.ui.notify(
            `Goal: ${state.objective} | Status: ${state.status} | Elapsed: ${elapsed}${budget}${iter}`,
            "info",
          );
          return;
        }

        case "start": {
          const objective = parsed.objective;
          if (!objective) {
            ctx.ui.notify("Please provide a goal objective.", "error");
            return;
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
            lastTurnTimestamp: Date.now(),
          };
          if (parsed.budget !== undefined) {
            state.tokenBudget = parsed.budget;
          }

          clearCompletionStatus(ctx);
          resetContinuationGuard();
          persistState();
          updateStatusLine(ctx);
          enableGoalCompleteTool();

          pi.sendUserMessage(buildStartPrompt(state), { deliverAs: "followUp" });

          const budgetMsg = parsed.budget ? ` (budget: ${formatTokens(parsed.budget)})` : "";
          ctx.ui.notify(`Goal started${budgetMsg}: ${parsed.objective}`, "info");
          return;
        }

        case "edit": {
          const objective = parsed.objective;
          if (!objective) {
            ctx.ui.notify("Please provide an updated goal objective.", "error");
            return;
          }
          const validationError = validateObjective(objective);
          if (validationError) {
            ctx.ui.notify(validationError, "warning");
            return;
          }
          if (!state) {
            ctx.ui.notify("No active goal to edit. Use /goal <objective> to start one.", "error");
            return;
          }

          state.objective = objective;
          persistState();
          updateStatusLine(ctx);
          ctx.ui.notify(`Goal updated: ${objective}`, "info");

          if (state.status === "active") {
            pi.sendUserMessage(buildObjectiveUpdatedPrompt(state), { deliverAs: "followUp" });
          }
          return;
        }

        case "pause": {
          if (state?.status !== "active") {
            ctx.ui.notify("No active goal to pause.", "info");
            return;
          }
          state.status = "paused";
          resetContinuationGuard();
          persistState();
          updateStatusLine(ctx);
          disableGoalCompleteTool();
          ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
          return;
        }

        case "resume": {
          if (!state) {
            ctx.ui.notify("No goal to resume. Use /goal <objective> to start one.", "info");
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
          if (state.tokenBudget && state.tokensUsed >= state.tokenBudget) {
            ctx.ui.notify(
              `Cannot resume: token budget reached (${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}). Use /goal budget <amount> to increase budget or /goal clear to cancel.`,
              "warning",
            );
            return;
          }

          state.status = "active";
          state.lastTurnTimestamp = Date.now();
          clearCompletionStatus(ctx);
          resetContinuationGuard();
          persistState();
          updateStatusLine(ctx);
          enableGoalCompleteTool();

          pi.sendUserMessage(buildResumePrompt(state), { deliverAs: "followUp" });

          ctx.ui.notify("Goal resumed.", "info");
          return;
        }

        case "budget": {
          if (!state) {
            ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "info");
            return;
          }
          const budget = parsed.budget;
          if (budget === undefined) {
            ctx.ui.notify("Usage: /goal budget <amount>", "warning");
            return;
          }
          state.tokenBudget = budget;
          persistState();
          updateStatusLine(ctx);

          if (state.status === "budget" && state.tokensUsed < budget) {
            state.status = "active";
            state.lastTurnTimestamp = Date.now();
            resetContinuationGuard();
            persistState();
            enableGoalCompleteTool();
            pi.sendUserMessage(buildResumePrompt(state), { deliverAs: "followUp" });
            ctx.ui.notify(`Goal budget set to ${formatTokens(budget)}. Goal resumed.`, "info");
          } else {
            ctx.ui.notify(`Goal budget set to ${formatTokens(budget)}.`, "info");
          }
          return;
        }

        case "clear": {
          if (!state) {
            ctx.ui.notify("No goal to clear.", "info");
            return;
          }

          state = null;
          resetContinuationGuard();
          persistState();
          updateStatusLine(ctx);
          clearCompletionStatus(ctx);
          disableGoalCompleteTool();

          ctx.ui.notify("Goal cleared.", "info");
          return;
        }
      }
    },
  });
}
