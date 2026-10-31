/** Shared exec-with-timeout runner: promisified `child_process.exec` with a
 *  cwd, a hard timeout, and a bounded capture buffer. Resolves (never
 *  throws) with the raw stdout/stderr parts plus the failure message, so
 *  each consumer composes its own user-facing output string.
 *
 *  Scope: pipe-captured one-shot commands. Process runners that stream
 *  output to files, kill a detached process group, or finalize from disk
 *  artifacts (workers/src/runner.ts) have different semantics and do not
 *  share this mechanism. */

import { type ChildProcess, type ExecException, exec as execCb } from "node:child_process";

// --- Types ---

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Maximum bytes captured from stdout and stderr (Node default: 1 MiB). */
  maxBuffer?: number;
}

export interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Why the command failed: non-zero exit, timeout kill, buffer overflow,
   *  or spawn error. Undefined on success. */
  error?: string;
  durationMs: number;
}

// --- Exec ---

/** One-line platform note for shell-command failure output, or "" when the
 *  platform needs no note. `child_process.exec` runs commands under /bin/sh,
 *  which is bash 3.2 on macOS — commands authored with bash-4 or GNU-only
 *  tool flags fail there and can otherwise be misread as a genuine fault. */
export function execPlatformHint(): string {
  if (process.platform !== "darwin") return "";
  return "Platform: darwin (commands run under /bin/sh, bash 3.2). Use POSIX-sh syntax and BSD-compatible tool flags, then re-run.";
}

/** How long a timed-out command gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 1_000;

/** Run one shell command with a timeout and a bounded capture buffer.
 *  At the timeout the child gets SIGTERM, then SIGKILL after a short grace
 *  period. A command that outlives the timeout always fails, even when it
 *  later exits 0, and the call settles at most one grace period past the
 *  deadline even when a grandchild keeps the output pipes open. Whatever
 *  the command produced before the kill or the buffer overflow is still
 *  returned. */
export function runExec(command: string, options: ExecOptions): Promise<ExecOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (err: ExecException | null, stdout: string, stderr: string): void => {
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      const durationMs = Date.now() - started;
      if (timedOut) {
        const error = `Command timed out after ${options.timeoutMs} ms: ${command}`;
        resolve({ ok: false, stdout, stderr, error, durationMs });
      } else if (err) {
        resolve({ ok: false, stdout, stderr, error: err.message, durationMs });
      } else {
        resolve({ ok: true, stdout, stderr, durationMs });
      }
    };

    let child: ChildProcess;
    try {
      child = execCb(
        command,
        {
          cwd: options.cwd,
          ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
        },
        finish,
      );
    } catch (err) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      });
      return;
    }

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        // A grandchild that inherited the pipes can hold them open after
        // the shell dies; closing our ends lets exec report now.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, KILL_GRACE_MS);
    }, options.timeoutMs);
  });
}
