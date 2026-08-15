/**
 * Plan Mode Extension
 *
 * Strict read-only planning with an approval gate, Claude-Code style.
 * /plan (or Ctrl+Alt+P, or --plan at startup) enters plan mode: the edit and
 * write tools are removed and hard-blocked, bash is restricted to a read-only
 * allowlist, and a plan-context message tells the model to research and call
 * the plan_submit tool. plan_submit shows the proposed plan in an overlay and
 * lets the user approve it (execution begins) or keep planning. Approved
 * steps become the shared todo list (lib/todos.ts); the agent checks items
 * off with the todo tool, and the mode ends when every step is completed.
 */

// --- Imports ---

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  getTodoItems,
  reconstructTodos,
  setTodoItems,
  TODOS_CHANGED_EVENT,
} from "../../lib/todos.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { promptPlanApproval } from "./src/approval.ts";
import {
  ENTRY_TYPE,
  EXECUTION_CONTEXT_TYPE,
  MUTATING_TOOLS,
  PLAN_COMPLETE_TYPE,
  PLAN_CONTEXT_TYPE,
  PLAN_MODE_EVENT,
  PLAN_SUBMIT_TOOL,
  STATUS_KEY,
} from "./src/constants.ts";
import { buildPlanModeTools, isSafeBashCommand } from "./src/enforcement.ts";
import {
  buildExecutionContext,
  buildKickoffMessage,
  buildPlanCompleteMessage,
  buildPlanModeContext,
} from "./src/prompts.ts";
import { completedStepCount, isPlanComplete, reconstructState } from "./src/state.ts";
import type { Plan, PlanState } from "./src/types.ts";

// --- Extension ---

export default async function planExtension(pi: ExtensionAPI) {
  let state: PlanState = { mode: "off", plan: null, toolsBeforePlan: undefined };
  // Session-scoped UI context for status refreshes from the todos event bus.
  let uiCtx: ExtensionContext | undefined;

  // --- State persistence ---

  function persistState() {
    pi.appendEntry(ENTRY_TYPE, { state });
  }

  function publishMode() {
    pi.events.emit(PLAN_MODE_EVENT, { mode: state.mode });
  }

  // --- UI ---

  function updateStatus(ctx: ExtensionContext | undefined) {
    if (!ctx?.hasUI) return;
    if (state.mode === "executing" && state.plan) {
      const completed = completedStepCount(state.plan, getTodoItems(pi));
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatusLine(ctx.ui.theme, {
          icon: "📋",
          prefix: "Plan",
          text: `${completed}/${state.plan.steps.length}`,
        }),
      );
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  // The todo widget itself is owned by the todos extension; plan only keeps
  // the compact progress status in sync when items change.
  pi.events.on(TODOS_CHANGED_EVENT, () => {
    updateStatus(uiCtx);
  });

  // --- Tool set management ---

  function applyPlanModeTools() {
    if (state.toolsBeforePlan === undefined) {
      state.toolsBeforePlan = pi.getActiveTools();
    }
    pi.setActiveTools(buildPlanModeTools(state.toolsBeforePlan));
  }

  function restorePrePlanTools() {
    const fallback = pi
      .getActiveTools()
      .filter((name) => !MUTATING_TOOLS.has(name) && name !== PLAN_SUBMIT_TOOL);
    pi.setActiveTools(state.toolsBeforePlan ?? fallback);
  }

  // --- Mode transitions ---

  function enterPlanMode(ctx: ExtensionContext) {
    state = { mode: "plan", plan: null, toolsBeforePlan: undefined };
    applyPlanModeTools();
    persistState();
    publishMode();
    updateStatus(ctx);
  }

  function exitPlanMode(ctx: ExtensionContext) {
    restorePrePlanTools();
    state = { mode: "off", plan: null, toolsBeforePlan: undefined };
    persistState();
    publishMode();
    updateStatus(ctx);
  }

  function enterExecution(ctx: ExtensionContext, plan: Plan) {
    state = { ...state, mode: "executing", plan };
    restorePrePlanTools();
    // The approved steps become the shared todo list; the agent checks items
    // off with the todo tool (owned by the todos extension).
    setTodoItems(pi, plan.steps);
    persistState();
    publishMode();
    updateStatus(ctx);
  }

  // --- Tool gate: block mutations while planning ---

  pi.on("tool_call", async (event, _ctx) => {
    if (state.mode !== "plan") return;
    if (MUTATING_TOOLS.has(event.toolName)) {
      // No terminate: the block reason is reported to the model and the turn
      // continues, so the agent keeps working read-only instead of stopping.
      return {
        block: true,
        reason:
          "Plan mode is read-only: edit and write are blocked. Call plan_submit to propose changes or exit plan mode with /plan.",
      };
    }
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (!isSafeBashCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: bash command blocked (not on the read-only allowlist). Call plan_submit to propose changes or exit plan mode with /plan.\nCommand: ${command}`,
        };
      }
    }
    return undefined;
  });

  // --- Context: inject per-turn mode instructions, strip stale copies ---

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (state.mode === "plan") {
      return {
        message: {
          customType: PLAN_CONTEXT_TYPE,
          content: [{ type: "text", text: buildPlanModeContext() }],
          display: false,
        },
      };
    }
    if (state.mode === "executing" && state.plan) {
      return {
        message: {
          customType: EXECUTION_CONTEXT_TYPE,
          content: [{ type: "text", text: buildExecutionContext(state.plan) }],
          display: false,
        },
      };
    }
    return undefined;
  });

  // Mode instructions are re-injected fresh every turn, so stale copies from
  // earlier turns are dropped from context unconditionally.
  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message: { customType?: string }) => {
        return (
          message.customType !== PLAN_CONTEXT_TYPE && message.customType !== EXECUTION_CONTEXT_TYPE
        );
      }),
    };
  });

  // --- Completion: every plan step checked in the shared todo list ---

  pi.on("agent_end", async (_event, ctx) => {
    if (state.mode !== "executing" || !state.plan) return;
    if (!isPlanComplete(state.plan, getTodoItems(pi))) return;

    const plan = state.plan;
    pi.sendMessage({
      customType: PLAN_COMPLETE_TYPE,
      content: [{ type: "text", text: buildPlanCompleteMessage(plan) }],
      display: true,
    });
    exitPlanMode(ctx);
    ctx.ui.notify("Plan complete.", "info");
  });

  // --- Tool: plan_submit ---

  pi.registerTool({
    name: PLAN_SUBMIT_TOOL,
    label: "Plan Submit",
    description:
      "Submit a plan for user approval. Call only after researching the request in plan mode. The user approves or rejects the plan before any changes are made.",
    promptSnippet: "Submit a complete plan for user approval before making changes",
    promptGuidelines: [
      "In plan mode, research the request with read-only tools, then call plan_submit with a concise title and a numbered list of concrete steps.",
      "Do not edit, write, or run mutating commands in plan mode; plan_submit is the only way to proceed.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the plan",
        },
        steps: {
          type: "array",
          items: { type: "string", description: "One concrete step the plan will execute" },
          minItems: 1,
          description: "Ordered list of steps the plan will execute",
        },
        notes: {
          type: "string",
          description: "Optional context, risks, or open questions",
        },
      },
      required: ["title", "steps"],
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (state.mode !== "plan") {
        return {
          content: [
            {
              type: "text",
              text: "Not in plan mode. Enable plan mode first (/plan command or --plan flag).",
            },
          ],
          details: { error: "not_in_plan_mode" },
          terminate: true,
        };
      }

      const title = typeof params.title === "string" ? params.title.trim() : "";
      const steps = Array.isArray(params.steps)
        ? params.steps
            .map((step: unknown) => (typeof step === "string" ? step.trim() : ""))
            .filter((step: string) => step.length > 0)
        : [];
      if (!title || steps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Invalid plan: a non-empty title and at least one non-empty step are required.",
            },
          ],
          details: { error: "invalid_plan" },
          terminate: true,
        };
      }

      const notes = typeof params.notes === "string" ? params.notes.trim() : "";
      const plan: Plan = {
        title,
        steps,
        notes: notes || undefined,
      };
      state = { ...state, plan };
      persistState();
      updateStatus(ctx);

      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Plan approval requires an interactive session. The plan has been saved; call plan_submit again when a user can review it.",
            },
          ],
          details: { status: "saved", plan: { title } },
          terminate: true,
        };
      }

      const choice = await promptPlanApproval(ctx.ui, plan);

      if (choice === "approve") {
        enterExecution(ctx, plan);
        pi.sendUserMessage(buildKickoffMessage(plan), { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `Plan approved: ${plan.title}.` }],
          details: {
            status: "approved",
            plan: { title: plan.title, steps: plan.steps },
          },
          terminate: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "The plan was not approved. Ask the user what to change, or refine the plan.",
          },
        ],
        details: { status: "cancelled" },
        terminate: true,
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only planning with approval gate)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (state.mode === "plan") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
      } else {
        const wasExecuting = state.mode === "executing";
        enterPlanMode(ctx);
        ctx.ui.notify(
          wasExecuting
            ? "Execution aborted. Plan mode enabled; file mutations are blocked."
            : "Plan mode enabled. File mutations are blocked until a plan is approved.",
          "info",
        );
      }
    },
  });

  pi.registerCommand("plan:status", {
    description: "Show plan mode status and the current plan",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (state.mode === "off") {
        ctx.ui.notify("Plan mode is off. Use /plan to enable it.", "info");
        return;
      }
      if (!state.plan) {
        ctx.ui.notify(
          state.mode === "plan"
            ? "Plan mode is on (read-only). No plan submitted yet."
            : "Executing a plan.",
          "info",
        );
        return;
      }
      const completed = completedStepCount(state.plan, getTodoItems(pi));
      ctx.ui.notify(
        `Plan mode: ${state.mode} | ${state.plan.title} | ${completed}/${state.plan.steps.length} steps done`,
        "info",
      );
    },
  });

  // --- Shortcut ---

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (state.mode === "plan") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
      } else {
        const wasExecuting = state.mode === "executing";
        enterPlanMode(ctx);
        ctx.ui.notify(
          wasExecuting
            ? "Execution aborted. Plan mode enabled; file mutations are blocked."
            : "Plan mode enabled. File mutations are blocked until a plan is approved.",
          "info",
        );
      }
    },
  });

  // --- Flag ---

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only planning)",
    type: "boolean",
    default: false,
  });

  // --- Lifecycle ---

  function applyRestoredToolState() {
    if (state.mode === "plan") {
      applyPlanModeTools();
    } else if (state.mode === "executing") {
      restorePrePlanTools();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    state = reconstructState(ctx.sessionManager.getBranch()) ?? {
      mode: "off",
      plan: null,
      toolsBeforePlan: undefined,
    };

    if (state.mode === "off" && pi.getFlag("plan") === true) {
      state = { mode: "plan", plan: null, toolsBeforePlan: undefined };
    }

    // Rebuild the shared todo store so completion checks work without the
    // todos extension being loaded (idempotent with its own reconstruction).
    reconstructTodos(pi, ctx.sessionManager.getBranch());
    applyRestoredToolState();
    publishMode();
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    state = reconstructState(ctx.sessionManager.getBranch()) ?? {
      mode: "off",
      plan: null,
      toolsBeforePlan: undefined,
    };
    reconstructTodos(pi, ctx.sessionManager.getBranch());
    applyRestoredToolState();
    publishMode();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    uiCtx = undefined;
    persistState();
  });
}
