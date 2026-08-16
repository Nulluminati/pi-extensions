/**
 * Context Extension
 *
 * Claude Code-style /context for Pi: shows what is consuming the context
 * window — system prompt (with per-file AGENTS.md/CLAUDE.md breakdown, skills,
 * and tool definitions), conversation messages, free space, and the
 * compaction reserve — plus session token/cost totals and the largest
 * messages by estimated size.
 *
 * Usage:
 *   /context
 *
 * The used total comes from `ctx.getContextUsage()` (last provider usage plus
 * trailing estimates); the category rows are estimates using pi's chars/4
 * heuristic, so they read as relative sizes, not exact counts.
 */

// --- Imports ---
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { measureContext } from "./src/measure.ts";
import { buildPlainText, showContextModal } from "./src/view.ts";

// --- Extension ---
export default async function contextExtension(pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description:
      "Show what is consuming the context window (system prompt, tools, messages, free space)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const breakdown = measureContext(pi, ctx);

      if (!ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "context",
            content: [{ type: "text", text: buildPlainText(breakdown) }],
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      await showContextModal(ctx, breakdown);
    },
  });

  // The /context breakdown is only meaningful in the moment it's requested.
  // Hiding the custom message from the transcript UI keeps unavailable-UI
  // print/json output from persisting as a large block on reload.
  pi.registerMessageRenderer("context", () => undefined);
}
