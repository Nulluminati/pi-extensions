/**
 * Goal Extension
 *
 * Provides /goal command and goal_complete tool for goal-oriented
 * auto-continuation mode with Codex-like persistence instructions.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";

// --- Constants ---

// Status-bar indicator: a Nerd Font checkered-flag icon in a distinct hue with
// a greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf023c); // nf-md-flag-checkered
export const ICON_COLOR = "mdHeading";
export const TEXT_COLOR = "muted";

const GOAL_MAX_LENGTH = 4000;
const STATUS_KEY = "goal";
const COMPLETION_STATUS_DURATION = 8000;

// --- Types ---

interface GoalState {
  id: string;
  objective: string;
  status: "active" | "paused" | "budget" | "complete";
  startTime: number;
  elapsedMs: number;
  iteration: number;
  tokensUsed: number;
  baselineTokens: number;
  tokenBudget?: number;
  lastTurnTimestamp?: number;
}

// --- Utilities ---

function generateGoalId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseTokenBudget(input: string): number | undefined {
  const match = input.match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  const value = Number.parseFloat(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === "k") return Math.round(value * 1000);
  if (suffix === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

function getElapsedMs(state: GoalState): number {
  if (state.status !== "active") return state.elapsedMs;
  const lastTs = state.lastTurnTimestamp ?? state.startTime;
  return state.elapsedMs + Math.max(0, Date.now() - lastTs);
}

function buildStatusLine(state: GoalState): string {
  if (state.status === "complete") return "complete";
  if (state.status === "paused") return "paused";
  if (state.status === "budget") {
    const b = state.tokenBudget;
    if (b === undefined) return "budget";
    return `budget ${formatTokens(state.tokensUsed)}/${formatTokens(b)}`;
  }
  if (state.tokenBudget) {
    return `active ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}`;
  }
  return `active ${formatElapsed(getElapsedMs(state))}`;
}

function goalObjectiveBlock(objective: string): string {
  return `<goal_objective>\n${escapeXmlText(objective)}\n</goal_objective>`;
}

function goalPersistenceRules(goalLabel: string): string {
  return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified.`;
}

function buildGoalSystemPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\n- Respect the goal token budget (${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used).`;
  return `Active /goal:\n${goalObjectiveBlock(goal.objective)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${budgetLine}`;
}

function buildStartPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokens(goal.tokenBudget)}.`;
  return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

function buildResumePrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

function buildObjectiveUpdatedPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

function buildContinuePrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  const iterLabel = goal.iteration > 99 ? "100+" : String(goal.iteration);
  return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\nThis is automatic continuation #${iterLabel}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}`;
}

// --- Command parsing ---

interface ParsedGoalArgs {
  subcommand: "status" | "start" | "edit" | "pause" | "resume" | "clear" | "budget";
  objective?: string;
  budget?: number;
  error?: string;
}

function parseGoalArgs(raw: string): ParsedGoalArgs {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return { subcommand: "status" };

  const [first, ...rest] = tokens;
  if (first === "pause")
    return rest.length === 0
      ? { subcommand: "pause" }
      : { subcommand: "status", error: "Usage: /goal pause" };
  if (first === "resume")
    return rest.length === 0
      ? { subcommand: "resume" }
      : { subcommand: "status", error: "Usage: /goal resume" };
  if (first === "clear")
    return rest.length === 0
      ? { subcommand: "clear" }
      : { subcommand: "status", error: "Usage: /goal clear" };
  if (first === "budget") {
    const rawBudget = rest[0];
    if (!rawBudget || rest.length > 1)
      return { subcommand: "status", error: "Usage: /goal budget <amount>" };
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === undefined)
      return { subcommand: "status", error: `Invalid token budget: ${rawBudget}` };
    return { subcommand: "budget", budget: parsedBudget };
  }
  if (first === "edit") {
    const objective = rest.join(" ").trim();
    return objective
      ? { subcommand: "edit", objective }
      : { subcommand: "status", error: "Usage: /goal edit <objective>" };
  }

  return parseObjectiveStart(tokens);
}

function parseObjectiveStart(tokens: string[]): ParsedGoalArgs {
  let tokenBudget: number | undefined;
  const objectiveTokens = [...tokens];

  if (objectiveTokens[0] === "--tokens") {
    const rawBudget = objectiveTokens[1];
    if (!rawBudget)
      return { subcommand: "status", error: "Usage: /goal --tokens 100k <objective>" };
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === undefined)
      return { subcommand: "status", error: `Invalid token budget: ${rawBudget}` };
    tokenBudget = parsedBudget;
    objectiveTokens.splice(0, 2);
  }

  const objective = objectiveTokens.join(" ").trim();
  if (!objective) return { subcommand: "status", error: "Usage: /goal <objective>" };
  const result: ParsedGoalArgs = { subcommand: "start", objective };
  if (tokenBudget !== undefined) {
    result.budget = tokenBudget;
  }
  return result;
}

function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return "Usage: /goal <objective>";
  if (trimmed.length > GOAL_MAX_LENGTH) {
    return `Goal objective is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
  }
  return undefined;
}

// --- State management ---

function isGoal(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<GoalState>;
  return (
    typeof goal.id === "string" &&
    typeof goal.objective === "string" &&
    ["active", "paused", "budget", "complete"].includes(String(goal.status)) &&
    typeof goal.startTime === "number" &&
    typeof goal.elapsedMs === "number" &&
    typeof goal.iteration === "number" &&
    typeof goal.tokensUsed === "number" &&
    typeof goal.baselineTokens === "number"
  );
}

function reconstructState(ctx: ExtensionContext): GoalState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === "goal-state") {
      const data = entry.data as { goal?: GoalState | null } | null;
      return isGoal(data?.goal) && data.goal.status !== "complete" ? data.goal : null;
    }
  }
  return null;
}

// --- Extension factory ---

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
        : `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, text)}`,
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
    if (!state || state.status !== "active") return;
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
    if (!state || state.status !== "active") return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(state)}`,
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!state || state.status !== "active") return;

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
    if (!state || state.status !== "active") return;

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
    description:
      "Call this tool when the current goal has been fully completed and verified. Provide a brief summary of what was accomplished.",
    promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it",
    promptGuidelines: [
      "When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
      "Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
      "Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains.",
    ],
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Brief summary of what was accomplished",
        },
      },
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state || state.status !== "active") {
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
        `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "complete")}`,
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
          if (!state || state.status !== "active") {
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
