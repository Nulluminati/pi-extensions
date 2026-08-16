/**
 * Todo List Extension
 *
 * A persistent todo list the LLM manages with the `todo` tool and the user
 * inspects with /todos. The list renders as a ☐/☑ widget above the editor and
 * survives reloads. State lives in lib/todos.ts (shared store + persistence +
 * todos:changed events), so extensions like plan can populate or read the
 * list without depending on this extension.
 */

// --- Imports ---

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  addTodoItems,
  clearTodoItems,
  getTodoItems,
  markTodoItems,
  reconstructTodos,
  TODOS_CHANGED_EVENT,
} from "../../lib/todos.ts";
import { buildWidgetLines } from "./src/widget.ts";

// --- Constants ---

const WIDGET_KEY = "todos";

// --- Extension ---

export default async function todosExtension(pi: ExtensionAPI) {
  // Session-scoped UI context for widget updates triggered by the event bus
  // (including mutations made by other extensions via lib/todos.ts).
  let uiCtx: ExtensionContext | undefined;

  function updateWidget(ctx: ExtensionContext | undefined) {
    if (!ctx?.hasUI) return;
    const items = getTodoItems(pi);
    ctx.ui.setWidget(
      WIDGET_KEY,
      items.length > 0 ? buildWidgetLines(ctx.ui.theme, items) : undefined,
    );
  }

  pi.events.on(TODOS_CHANGED_EVENT, () => {
    updateWidget(uiCtx);
  });

  // --- Tool ---

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Maintain a todo list shown as a widget above the editor. Actions: add new items, check or uncheck items by 1-based number (matching the displayed list), list current items, or clear the list.",
    promptSnippet: "Track multi-step work with a visible todo list",
    promptGuidelines: [
      "Use todo with action add to create a checklist for multi-step tasks so progress stays visible in the UI.",
      "Use todo with action check to mark items complete as you finish them; item numbers are 1-based and match the displayed list.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "check", "uncheck", "clear", "list"],
          description: "Operation to perform",
        },
        items: {
          type: "array",
          items: { type: "string", description: "Text of a new todo item" },
          description: "Items to add (required for action add)",
        },
        ids: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "1-based item numbers to check or uncheck (required for check/uncheck)",
        },
      },
      required: ["action"],
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = typeof params.action === "string" ? params.action : "";
      const listText = () =>
        getTodoItems(pi)
          .map((item, index) => `${index + 1}. ${item.completed ? "☑" : "☐"} ${item.text}`)
          .join("\n");

      if (action === "add") {
        const texts = Array.isArray(params.items)
          ? params.items.filter((text: unknown): text is string => typeof text === "string")
          : [];
        const added = addTodoItems(pi, texts);
        if (added === 0) {
          return {
            content: [
              { type: "text", text: "No items to add: provide at least one non-empty item." },
            ],
            details: { error: "no_items" },
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `Added ${added} item(s):\n${listText()}` }],
          details: { items: getTodoItems(pi) },
        };
      }

      if (action === "check" || action === "uncheck") {
        const ids = Array.isArray(params.ids)
          ? params.ids.filter((id: unknown): id is number => typeof id === "number")
          : [];
        if (ids.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No item numbers provided for action ${action}. Provide ids matching the displayed list.`,
              },
            ],
            details: { error: "no_ids" },
            terminate: true,
          };
        }
        const matched = markTodoItems(pi, ids, action === "check");
        return {
          content: [
            {
              type: "text",
              text:
                matched === 0
                  ? `No items matched the given numbers:\n${listText()}`
                  : `Marked ${matched} item(s):\n${listText()}`,
            },
          ],
          details: { items: getTodoItems(pi) },
        };
      }

      if (action === "clear") {
        clearTodoItems(pi);
        return {
          content: [{ type: "text", text: "Todo list cleared." }],
          details: { items: [] },
        };
      }

      if (action === "list") {
        const items = getTodoItems(pi);
        return {
          content: [
            {
              type: "text",
              text: items.length === 0 ? "Todo list is empty." : listText(),
            },
          ],
          details: { items },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Unknown todo action: ${action}. Use add, check, uncheck, clear, or list.`,
          },
        ],
        details: { error: "unknown_action" },
        terminate: true,
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("todos", {
    description: "Show the current todo list",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const items = getTodoItems(pi);
      if (items.length === 0) {
        ctx.ui.notify("Todo list is empty.", "info");
        return;
      }
      ctx.ui.notify(
        items
          .map((item, index) => `${index + 1}. ${item.completed ? "☑" : "☐"} ${item.text}`)
          .join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("todos:clear", {
    description: "Clear the todo list",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      clearTodoItems(pi);
      ctx.ui.notify("Todo list cleared.", "info");
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    reconstructTodos(pi, ctx.sessionManager.getBranch());
    updateWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    reconstructTodos(pi, ctx.sessionManager.getBranch());
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    uiCtx = undefined;
  });
}
