/**
 * Clear Alias Extension
 *
 * Aliases `/clear` to Pi's built-in `/new` command. Useful for users coming
 * from Claude Code, terminal `clear`, or any other tool where `clear` is the
 * muscle-memory verb for starting a fresh session.
 *
 * Usage:
 *   /clear
 *
 * Notes:
 *   - Both `/clear` and `/new` remain registered; this extension does not
 *     unregister any built-in command.
 *   - Confirmation is handled by `newSession()` itself when there is content
 *     in the current branch, matching `/new`'s behavior.
 */

// --- Imports ---

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { confirmModal } from "../../lib/input-modal.ts";

// --- Extension ---

export default async function clearExtension(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a fresh Pi session (alias for /new)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (ctx.hasUI) {
        const confirmed = await confirmModal(ctx, {
          title: "Start a fresh session?",
          body: "This replaces the current session. The old session stays in your history.",
        });
        if (!confirmed) return;
      }
      await ctx.newSession();
    },
  });
}
