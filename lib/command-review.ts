/**
 * In-process command review for extensions that run shell commands outside
 * the `bash` tool. Approval Mode answers these requests with the same hard
 * denies, Jev judgment, and dialog it applies to `bash`. Without a reviewer,
 * the hard-deny list still refuses catastrophic commands, which matches what
 * the `bash` tool allows when Approval Mode is not loaded.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyCommand } from "./command-policy.ts";

// --- Constants ---

export const COMMAND_REVIEW_EVENT = "approval-mode:command-review";

// --- Types ---

export interface CommandReviewReply {
  approved: boolean;
  /** Why the command was refused; absent on approval. */
  reason?: string;
}

/** The event payload a reviewer receives. A reviewer calls `claim` before
 * returning from the listener, then `respond` once it has a decision. */
export interface CommandReviewRequest {
  ctx: ExtensionContext;
  command: string;
  cwd: string;
  /** Who asks for the command, shown in the approval dialog. */
  source: string;
  claim(): void;
  respond(reply: CommandReviewReply): void;
}

// --- Request ---

/** Ask the loaded reviewer whether `command` may run. Resolves (never throws)
 * with a refusal on cancellation or reviewer failure. */
export function requestCommandReview(
  events: { emit(event: string, data: unknown): void },
  request: { ctx: ExtensionContext; command: string; cwd: string; source: string },
): Promise<CommandReviewReply> {
  const signal = request.ctx.signal;
  if (signal?.aborted) {
    return Promise.resolve({ approved: false, reason: "Command review cancelled." });
  }
  return new Promise((resolve) => {
    let settled = false;
    let claimed = false;
    const finish = (reply: CommandReviewReply) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve(reply);
    };
    const cancel = () => finish({ approved: false, reason: "Command review cancelled." });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      events.emit(COMMAND_REVIEW_EVENT, {
        ...request,
        claim: () => {
          claimed = true;
        },
        respond: finish,
      } satisfies CommandReviewRequest);
    } catch (error) {
      finish({
        approved: false,
        reason: `Command review failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (claimed) return;
    if (classifyCommand(request.command, request.cwd) === "hard-deny") {
      finish({ approved: false, reason: "Hard deny: this command is never run automatically." });
      return;
    }
    finish({ approved: true });
  });
}
