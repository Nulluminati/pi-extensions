/** Browse the current repository's open pull requests with /github. */

import type { ExtensionAPI } from "pi";
import { PANEL_OVERLAY_OPTIONS } from "../../lib/overlay-options.ts";
import { buildActionPrompt, type GitHubActionSelection } from "./src/actions.ts";
import { createGitHubClient } from "./src/client.ts";
import { createGitHubOverlay } from "./src/overlay.ts";

// --- Extension ---

export default async function githubExtension(pi: ExtensionAPI) {
  let open = false;

  pi.registerCommand("github", {
    description: "Browse repository pull requests, approvals, CI, comments, and agent actions",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") return;
      if (open) return;
      open = true;
      try {
        const client = createGitHubClient(
          (command, args, options) => pi.exec(command, args, options),
          ctx.cwd,
        );
        const selected = await ctx.ui.custom<GitHubActionSelection | null>(
          (tui, theme, keybindings, done) =>
            createGitHubOverlay({
              client,
              tui,
              theme,
              keybindings,
              done,
              onError: (message) => ctx.ui.notify(`GitHub: ${message}`, "error"),
            }),
          {
            overlay: true,
            overlayOptions: PANEL_OVERLAY_OPTIONS,
            onHandle: (handle) => handle.focus(),
          },
        );
        if (!selected) return;
        if (!ctx.model) {
          ctx.ui.notify("GitHub: Select a model before starting an agent action.", "error");
          return;
        }
        pi.sendUserMessage(buildActionPrompt(selected), { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`GitHub: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        open = false;
      }
    },
  });
}
