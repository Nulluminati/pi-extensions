import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AllowRule, checkCommand, parseAllowList } from "../../lib/bash-allow.ts";

// --- Constants ---

const SHELL_TOOLS = new Set(["bash", "background", "monitor"]);

// --- Extension ---

export default async function bashAllowExtension(pi: ExtensionAPI): Promise<void> {
  let rules: AllowRule[] | undefined;
  let listError: string | undefined;

  pi.registerFlag("bash-allow", {
    type: "string",
    description: "Comma-separated bash command allow list; every other shell call is blocked",
  });

  pi.on("session_start", (_event, ctx) => {
    // Pi applies CLI flag values after extension factories run.
    const flag = pi.getFlag("bash-allow");
    const value = typeof flag === "string" ? flag : process.env.PI_BASH_ALLOW;
    rules = undefined;
    listError = undefined;
    if (value === undefined) return;
    const parsed = parseAllowList(value);
    rules = parsed.rules;
    if (parsed.error) {
      listError = `bash-allow could not read its list: ${parsed.error}`;
      if (ctx.hasUI) ctx.ui.notify(listError, "error");
    }
  });

  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    if (listError) return { block: true, reason: listError };
    if (rules === undefined) return;
    const command = "command" in event.input ? event.input.command : undefined;
    if (typeof command !== "string" || !command.trim()) {
      return { block: true, reason: "Command is empty." };
    }
    const result = checkCommand(command, rules);
    if (!result.allowed) return { block: true, reason: result.reason };
  });
}
