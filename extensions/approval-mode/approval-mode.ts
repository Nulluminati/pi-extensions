/**
 * Approval Mode
 *
 * Hard denies remain active when main-session Jev review is disabled.
 * Main sessions take their initial review state from the --approval-mode on|off
 * flag; an unusable value keeps review on. Workers follow their parent's live
 * Jev mode and request approval through its UI.
 * Read-only workers also need a read-only OS sandbox.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyCommand } from "../../lib/command-policy.ts";
import { COMMAND_REVIEW_EVENT, type CommandReviewRequest } from "../../lib/command-review.ts";
import {
  connectWorkerApprovalChannel,
  WORKER_APPROVAL_EVENT,
  WORKER_APPROVAL_FD_ENV_VAR,
  type WorkerApprovalEvent,
} from "../../lib/worker-approval.ts";
import { promptApproval } from "./src/dialog.ts";
import { judgeCommand } from "./src/jev.ts";

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

// --- Helpers ---

/**
 * Map the --approval-mode flag value to review on (true) or off (false).
 * A missing value keeps the default; anything that is not on or off is invalid.
 */
function parseApprovalFlag(value: string | boolean | undefined): boolean | "invalid" {
  if (value === undefined) return true;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text === "on") return true;
  if (text === "off") return false;
  return "invalid";
}

// --- Extension ---

export default async function approvalMode(pi: ExtensionAPI) {
  const worker = process.env.PI_WORKER === "1";
  let readOnly = worker && process.env.PI_WORKER_READONLY === "1";
  let enabled = true;
  let pendingApproval: Promise<void> = Promise.resolve();
  let parentContext: ExtensionContext | undefined;
  let stopListening: (() => void) | undefined;
  let stopReviewListening: (() => void) | undefined;
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
      const reportBlocked = ctx.mode === "tui";
      if (reportBlocked) pi.events.emit("herdr:blocked", { active: true, label: "Approval Mode" });
      let choice: Awaited<ReturnType<typeof promptApproval>>;
      try {
        choice = await promptApproval({ ...ctx, signal }, command, decision, reason, source);
      } finally {
        if (reportBlocked) pi.events.emit("herdr:blocked", { active: false });
      }
      if (ctx.signal?.aborted) return false;
      return !enabled || (!signal.aborted && choice === "Approve once");
    } finally {
      release();
    }
  }

  /**
   * Apply hard denies, Jev review, and approval to one command. Resolves the
   * block reason, or undefined when the command may run. `source` labels a
   * request that did not come from a tool call in the approval dialog.
   */
  async function gate(
    ctx: ExtensionContext,
    command: string,
    cwd: string,
    toolName: string,
    source?: string,
  ): Promise<string | undefined> {
    const classification = classifyCommand(command, cwd);
    if (classification === "hard-deny") {
      return "Approval Mode hard deny: this command cannot be approved by Jev.";
    }
    if (worker && channel && classification !== "known-safe") {
      const mode = await channel.request({ kind: "mode" }, ctx.signal);
      if (!("enabled" in mode) || ctx.signal?.aborted) {
        return "Approval Mode blocked: parent approval channel unavailable.";
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
      return `Approval Mode blocked: ${result.reason}.`;
    }
    if (worker) {
      const reply = await channel?.request(
        {
          kind: "approval",
          command,
          cwd,
          toolName,
          decision: result.decision,
          reason: result.reason,
        },
        ctx.signal,
      );
      if (reply && "approved" in reply && reply.approved && !ctx.signal?.aborted) return undefined;
      return `Approval Mode blocked: ${result.reason}.`;
    }
    if (await approve(ctx, command, result.decision, result.reason, source)) return undefined;
    return `Approval Mode blocked: ${result.reason}.`;
  }

  /** Review a command another extension runs outside the command tools. The
   * worker approval channel carries only tool calls, so workers refuse. */
  function receiveCommandReview(data: unknown): void {
    const request = data as CommandReviewRequest;
    request.claim();
    if (worker || readOnly) {
      request.respond({
        approved: false,
        reason: "Approval Mode blocked: workers cannot run extension commands.",
      });
      return;
    }
    void gate(
      request.ctx,
      request.command,
      request.cwd,
      "bash",
      `${request.source}\nDirectory: ${request.cwd}`,
    )
      .then((reason) =>
        request.respond(reason === undefined ? { approved: true } : { approved: false, reason }),
      )
      .catch(() =>
        request.respond({ approved: false, reason: "Approval Mode blocked: review failed." }),
      );
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

  pi.registerFlag("approval-mode", {
    description: "Start Jev command review off or on in a main session (default on)",
    type: "string",
    default: "on",
  });

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
    if (!stopReviewListening) {
      stopReviewListening = pi.events.on(COMMAND_REVIEW_EVENT, receiveCommandReview);
    }
    const fd = process.env[WORKER_APPROVAL_FD_ENV_VAR];
    if (worker && fd === "3") {
      channel = connectWorkerApprovalChannel(3);
    }
    readOnly =
      worker && (process.env.PI_WORKER_READONLY === "1" || pi.getFlag("worker-readonly") === true);
    enabled = true;
    if (readOnly) pi.setActiveTools(pi.getActiveTools().filter((name) => READONLY_TOOLS.has(name)));
    if (!worker) {
      const requested = pi.getFlag("approval-mode");
      const parsed = parseApprovalFlag(requested);
      if (parsed === "invalid") {
        // Fail closed: an unusable value keeps review on instead of disabling it.
        const message = `Approval Mode: unknown --approval-mode value "${String(requested)}". Use on or off. Jev review stays on.`;
        if (!ctx.hasUI) throw new Error(message);
        ctx.ui.notify(message, "error");
      } else {
        enabled = parsed;
      }
    }
    publish(ctx);
    if (!worker && enabled && ctx.hasUI) {
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
    const input: Record<string, unknown> | undefined = event.input;
    const command = typeof input?.command === "string" ? input.command : "";
    if (!command.trim()) return { block: true, reason: "Command is empty." };
    const cwd =
      event.toolName === "background" && typeof input?.cwd === "string"
        ? resolve(ctx.cwd, input.cwd)
        : ctx.cwd;
    const reason = await gate(ctx, command, cwd, event.toolName);
    return reason === undefined ? undefined : { block: true, reason };
  });

  pi.on("session_shutdown", async () => {
    parentContext = undefined;
    dialogAbort.abort();
    channel?.close();
    channel = undefined;
    stopListening?.();
    stopListening = undefined;
    stopReviewListening?.();
    stopReviewListening = undefined;
  });
}
