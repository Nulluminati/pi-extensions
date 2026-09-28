/**
 * Approval Mode
 *
 * Hard denies remain active when main-session Jev review is disabled.
 * Workers cannot disable the gate; read-only workers also need a read-only OS sandbox.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { promptApproval } from "./src/dialog.ts";
import { judgeCommand } from "./src/jev.ts";
import { classifyCommand } from "./src/policy.ts";

const STATE_EVENT = "approval-mode:state";
const STATUS_KEY = "approval-mode";
const COMMAND_TOOLS = new Set(["bash", "background", "monitor"]);
const READONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "messenger",
  "report_blocker",
  "code_search",
  "context7_resolve_library_id",
  "context7_get_library_docs",
  "context7_get_cached_doc_raw",
  "web_search",
  "web_fetch",
]);

// --- Extension ---

export default async function approvalMode(pi: ExtensionAPI) {
  const worker = process.env.PI_WORKER === "1";
  let readOnly = worker && process.env.PI_WORKER_READONLY === "1";
  let enabled = true;
  let pendingApproval: Promise<void> = Promise.resolve();

  pi.registerFlag("worker-readonly", {
    description: "Enforce investigation-only tools in a read-only worker",
    type: "boolean",
    default: false,
  });

  function publish(ctx: ExtensionContext) {
    pi.events.emit(STATE_EVENT, { enabled: worker || enabled });
    if (ctx.hasUI)
      ctx.ui.setStatus(STATUS_KEY, enabled || worker ? undefined : "Approval Mode off");
  }

  pi.on("session_start", async (_event, ctx) => {
    readOnly =
      worker && (process.env.PI_WORKER_READONLY === "1" || pi.getFlag("worker-readonly") === true);
    enabled = true;
    if (readOnly) pi.setActiveTools(pi.getActiveTools().filter((name) => READONLY_TOOLS.has(name)));
    publish(ctx);
    if (!worker && ctx.hasUI && !process.env.TYPESAFEAI_API_KEY) {
      ctx.ui.notify(
        "Approval Mode: TYPESAFEAI_API_KEY is missing. Jev-reviewed commands will be blocked.",
        "warning",
      );
    }
  });

  pi.registerCommand("approval-mode", {
    description: "Show or change main-session Jev command approval (on, off, status)",
    handler: async (args, ctx) => {
      if (worker || !ctx.hasUI) return;
      const action = args.trim();
      if (action !== "on" && action !== "off" && action !== "" && action !== "status") {
        ctx.ui.notify("Use /approval-mode on, off, or status.", "warning");
        return;
      }
      if (action === "on" || action === "off") enabled = action === "on";
      publish(ctx);
      ctx.ui.notify(
        enabled ? "Approval Mode is on." : "Approval Mode is off. Hard denies remain active.",
        "info",
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (readOnly && !READONLY_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Read-only worker cannot use ${event.toolName}.` };
    }
    if (!COMMAND_TOOLS.has(event.toolName)) return undefined;
    if (readOnly && event.toolName !== "bash") {
      return { block: true, reason: "Read-only workers cannot start detached commands." };
    }
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (!command.trim()) return { block: true, reason: "Command is empty." };
    const cwd =
      event.toolName === "background" && typeof event.input?.cwd === "string"
        ? resolve(ctx.cwd, event.input.cwd)
        : ctx.cwd;
    const classification = classifyCommand(command, cwd);
    if (classification === "hard-deny") {
      return {
        block: true,
        reason: "Approval Mode hard deny: this command cannot be approved by Jev.",
      };
    }
    if (!worker && !enabled) return undefined;
    if (classification === "known-safe") return undefined;
    const result = await judgeCommand({
      command,
      cwd,
      apiKey: process.env.TYPESAFEAI_API_KEY,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.decision === "allow") return undefined;
    if (result.decision === "unavailable" || worker || !ctx.hasUI || ctx.signal?.aborted) {
      return { block: true, reason: `Approval Mode blocked: ${result.reason}.` };
    }
    // Tool calls can run in parallel. Serialize local dialogs, but never persist an approval.
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = pendingApproval;
    pendingApproval = next;
    await previous;
    try {
      if (ctx.signal?.aborted) return { block: true, reason: "Approval cancelled." };
      const choice = await promptApproval(ctx, command, result.decision, result.reason);
      if (ctx.signal?.aborted || choice !== "Approve once") {
        return { block: true, reason: `Approval Mode blocked: ${result.reason}.` };
      }
      return undefined;
    } finally {
      release();
    }
  });
}
