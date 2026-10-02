/**
 * Approval Mode
 *
 * Hard denies remain active when main-session Jev review is disabled.
 * Workers follow their parent's live Jev mode and request approval through its UI.
 * Read-only workers also need a read-only OS sandbox.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import {
  connectWorkerApprovalChannel,
  WORKER_APPROVAL_EVENT,
  WORKER_APPROVAL_FD_ENV_VAR,
  type WorkerApprovalEvent,
} from "../../lib/worker-approval.ts";
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
  let parentContext: ExtensionContext | undefined;
  let stopListening: (() => void) | undefined;
  let dialogAbort = new AbortController();
  let channel: ReturnType<typeof connectWorkerApprovalChannel> | undefined;

  // Tool calls and worker requests share one queue. No approval is persisted.
  async function approve(
    ctx: ExtensionContext,
    command: string,
    decision: "reject" | "uncertain",
    reason: string,
    source?: string,
  ): Promise<boolean> {
    const signal = AbortSignal.any([dialogAbort.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = pendingApproval;
    pendingApproval = next;
    await previous;
    try {
      if (ctx.signal?.aborted) return false;
      if (!enabled) return true;
      if (signal.aborted || !ctx.hasUI) return false;
      const choice = await promptApproval({ ...ctx, signal }, command, decision, reason, source);
      if (ctx.signal?.aborted) return false;
      return !enabled || (!signal.aborted && choice === "Approve once");
    } finally {
      release();
    }
  }

  function receiveWorkerRequest(data: unknown): void {
    const event = data as WorkerApprovalEvent;
    const ctx = parentContext;
    if (!ctx || event.signal.aborted) {
      event.respond({ approved: false });
      return;
    }
    if (event.request.kind === "mode") {
      event.respond({ enabled });
      return;
    }
    const request = event.request;
    if (
      (request.toolName !== "background" && resolve(request.cwd) !== resolve(event.worker.cwd)) ||
      classifyCommand(request.command, request.cwd) === "hard-deny"
    ) {
      event.respond({ approved: false });
      return;
    }
    const source = `Worker: ${event.worker.name} (${event.worker.id})\nDirectory: ${request.cwd}\nTool: ${request.toolName}`;
    void approve(
      { ...ctx, signal: event.signal },
      request.command,
      request.decision,
      request.reason,
      source,
    )
      .then((approved) => event.respond({ approved }))
      .catch(() => event.respond({ approved: false }));
  }

  pi.registerFlag("worker-readonly", {
    description: "Enforce investigation-only tools in a read-only worker",
    type: "boolean",
    default: false,
  });

  function publish(ctx: ExtensionContext) {
    pi.events.emit(STATE_EVENT, { enabled });
    if (ctx.hasUI)
      ctx.ui.setStatus(STATUS_KEY, enabled || worker ? undefined : "Approval Mode off");
  }

  pi.on("session_start", async (_event, ctx) => {
    dialogAbort.abort();
    dialogAbort = new AbortController();
    channel?.close();
    channel = undefined;
    parentContext = worker ? undefined : ctx;
    if (!worker && !stopListening) {
      stopListening = pi.events.on(WORKER_APPROVAL_EVENT, receiveWorkerRequest);
    }
    const fd = process.env[WORKER_APPROVAL_FD_ENV_VAR];
    if (worker && fd === "3") {
      channel = connectWorkerApprovalChannel(3);
    }
    readOnly =
      worker && (process.env.PI_WORKER_READONLY === "1" || pi.getFlag("worker-readonly") === true);
    enabled = true;
    if (readOnly) pi.setActiveTools(pi.getActiveTools().filter((name) => READONLY_TOOLS.has(name)));
    publish(ctx);
    if (!worker && ctx.hasUI) {
      const available = await ctx.modelRegistry.getAvailableOfType("classifier").catch(() => []);
      if (available.length === 0) {
        ctx.ui.notify(
          "Approval Mode: no Jev classifier is available. Jev-reviewed commands will be blocked.",
          "warning",
        );
      }
    }
  });

  pi.registerCommand("approval-mode", {
    description:
      "Show or change Jev command approval for this session and its workers (on, off, status)",
    handler: async (args, ctx) => {
      if (worker || !ctx.hasUI) return;
      const action = args.trim();
      if (action !== "on" && action !== "off" && action !== "" && action !== "status") {
        ctx.ui.notify("Use /approval-mode on, off, or status.", "warning");
        return;
      }
      if (action === "on" || action === "off") {
        enabled = action === "on";
        if (!enabled) {
          dialogAbort.abort();
          dialogAbort = new AbortController();
        }
      }
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
    if (worker && channel && classification !== "known-safe") {
      const mode = await channel.request({ kind: "mode" }, ctx.signal);
      if (!("enabled" in mode) || ctx.signal?.aborted) {
        return {
          block: true,
          reason: "Approval Mode blocked: parent approval channel unavailable.",
        };
      }
      enabled = mode.enabled;
    }
    if (!enabled || classification === "known-safe") return undefined;
    const result = await judgeCommand({
      command,
      cwd,
      modelRegistry: ctx.modelRegistry,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.decision === "allow") return undefined;
    if (result.decision === "unavailable" || ctx.signal?.aborted) {
      return { block: true, reason: `Approval Mode blocked: ${result.reason}.` };
    }
    if (worker) {
      const reply = await channel?.request(
        {
          kind: "approval",
          command,
          cwd,
          toolName: event.toolName,
          decision: result.decision,
          reason: result.reason,
        },
        ctx.signal,
      );
      if (reply && "approved" in reply && reply.approved && !ctx.signal?.aborted) return undefined;
      return { block: true, reason: `Approval Mode blocked: ${result.reason}.` };
    }
    if (await approve(ctx, command, result.decision, result.reason)) return undefined;
    return { block: true, reason: `Approval Mode blocked: ${result.reason}.` };
  });

  pi.on("session_shutdown", async () => {
    parentContext = undefined;
    dialogAbort.abort();
    channel?.close();
    channel = undefined;
    stopListening?.();
    stopListening = undefined;
  });
}
