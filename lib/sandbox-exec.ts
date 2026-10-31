/**
 * In-process sandboxed execution for extensions that run shell commands
 * outside the `bash` tool. worker-sandbox claims these requests while a
 * session or worker sandbox is active; with no claim, the caller runs the
 * command itself.
 */

// --- Constants ---

export const SANDBOX_EXEC_EVENT = "worker-sandbox:exec-request";

// --- Types ---

export interface SandboxExecOutcome {
  ok: boolean;
  /** Captured output on failure, bounded to `maxOutputBytes`, plus the cause. */
  output: string;
}

export interface SandboxExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** The event payload a sandbox receives. A sandbox calls `claim` before
 * returning from the listener, then `respond` once the command ends. */
export interface SandboxExecRequest extends SandboxExecOptions {
  claim(): void;
  respond(outcome: SandboxExecOutcome): void;
}

// --- Request ---

/** Run `command` in the active sandbox. Resolves undefined when no sandbox
 * claims the request; never throws. */
export function requestSandboxExec(
  events: { emit(event: string, data: unknown): void },
  options: SandboxExecOptions,
): Promise<SandboxExecOutcome | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let claimed = false;
    const signal = options.signal;
    const finish = (outcome: SandboxExecOutcome | undefined) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    const cancel = () => finish({ ok: false, output: "Sandboxed command cancelled." });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      events.emit(SANDBOX_EXEC_EVENT, {
        ...options,
        claim: () => {
          claimed = true;
        },
        respond: finish,
      } satisfies SandboxExecRequest);
    } catch (error) {
      // A claimed sandbox that fails never falls back to host execution.
      const message = error instanceof Error ? error.message : String(error);
      finish(claimed ? { ok: false, output: `Sandboxed command failed: ${message}` } : undefined);
      return;
    }
    if (!claimed) finish(undefined);
  });
}
