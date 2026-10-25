import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AllowRule,
  BASH_ALLOW_REQUEST_EVENT,
  checkCommand,
  parseAllowList,
} from "../../lib/bash-allow.ts";

// --- Constants ---

const SHELL_TOOLS = new Set(["bash", "background", "monitor"]);
const SUPPORTED_SHELL_NAMES = new Set(["bash", "sh", "bash.exe", "sh.exe"]);

// --- Helpers ---

function shellRefusal(pi: ExtensionAPI): string | undefined {
  const shellPath = pi.getSettings().shellPath;
  if (!shellPath) return;
  const shellName = shellPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (!SUPPORTED_SHELL_NAMES.has(shellName)) {
    return `bash-allow requires bash or sh. Unsupported shellPath: ${shellPath}. Restart Pi with a supported shell.`;
  }
}

// --- Extension ---

export default async function bashAllowExtension(pi: ExtensionAPI): Promise<void> {
  let configuredList: string | undefined;
  let rules: AllowRule[] | undefined;
  let listError: string | undefined;
  let startupShellError: string | undefined;
  let stopListening: (() => void) | undefined;

  pi.registerFlag("bash-allow", {
    type: "string",
    description: "Comma-separated bash command allow list; every other shell call is blocked",
  });

  pi.on("session_shutdown", () => {
    stopListening?.();
    stopListening = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    stopListening?.();
    stopListening = pi.events.on(BASH_ALLOW_REQUEST_EVENT, (request) => {
      if (
        request &&
        typeof request === "object" &&
        "reply" in request &&
        typeof request.reply === "function"
      ) {
        request.reply(configuredList);
      }
    });
    // Pi applies CLI flag values after extension factories run.
    const flag = pi.getFlag("bash-allow");
    const value = typeof flag === "string" ? flag : process.env.PI_BASH_ALLOW;
    configuredList = value;
    rules = undefined;
    listError = undefined;
    startupShellError = undefined;
    if (value === undefined) return;
    const parsed = parseAllowList(value);
    rules = parsed.rules;
    if (parsed.error) {
      listError = `bash-allow could not read its list: ${parsed.error}`;
      if (ctx.hasUI) ctx.ui.notify(listError, "error");
      return;
    }
    startupShellError = shellRefusal(pi);
    if (startupShellError && ctx.hasUI) ctx.ui.notify(startupShellError, "error");
  });

  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    if (listError) return { block: true, reason: listError };
    if (rules === undefined) return;
    // Built-in tools capture their shell configuration when Pi creates them.
    // A settings change alone must not clear an unsupported startup shell.
    const shellError = startupShellError ?? shellRefusal(pi);
    if (shellError) return { block: true, reason: shellError };
    if (event.toolName === "background") {
      const env = "env" in event.input ? event.input.env : undefined;
      if (
        env !== undefined &&
        (env === null || typeof env !== "object" || Object.keys(env).length > 0)
      ) {
        return {
          block: true,
          reason:
            "bash-allow blocks background environment overrides. Use the inherited environment.",
        };
      }
      if ("cwd" in event.input && event.input.cwd !== undefined) {
        return {
          block: true,
          reason:
            "bash-allow blocks background working directory overrides. Use the session working directory.",
        };
      }
    }
    const command = "command" in event.input ? event.input.command : undefined;
    if (typeof command !== "string" || !command.trim()) {
      return { block: true, reason: "Command is empty." };
    }
    const result = checkCommand(command, rules);
    if (!result.allowed) return { block: true, reason: result.reason };
  });
}
