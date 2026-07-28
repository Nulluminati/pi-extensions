/**
 * LSP Extension
 *
 * Language-agnostic code intelligence via the Language Server Protocol.
 * Config-driven: users define LSP servers in JSON config files,
 * and the extension auto-detects servers by file extension.
 */

// --- Imports ---

import type { ExtensionAPI } from "pi";
import { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./src/constants.ts";
import { renderLspResult } from "./src/renderer.ts";
import { createLspRuntime } from "./src/runtime.ts";
import {
  LSP_TOOL_PARAMETERS,
  type LspToolParams,
  PROMPT_GUIDELINES,
  TOOL_DESCRIPTION,
} from "./src/tool.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR };

// --- Extension ---

export default async function lspExtension(pi: ExtensionAPI) {
  const runtime = createLspRuntime();

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    await runtime.sessionStart(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await runtime.sessionShutdown();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "lsp") {
      runtime.refreshStatus(ctx.ui);
    }
  });

  // --- Tool ---

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: LSP_TOOL_PARAMETERS,
    renderResult: renderLspResult,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return runtime.execute(params as LspToolParams);
    },
  });

  // --- Commands ---

  pi.registerCommand("lsp", {
    description: "Show LSP server status, detected servers, and their extensions",
    handler: async (_args, ctx) => {
      await runtime.showStatus(ctx);
    },
  });

  pi.registerCommand("lsp-restart", {
    description: "Stop all LSP servers (they reinitialize on next tool use)",
    handler: async (_args, ctx) => {
      await runtime.restart(ctx);
    },
  });
}
