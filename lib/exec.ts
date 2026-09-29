/** Shared exec-with-timeout runner: promisified `child_process.exec` with a
 *  cwd, a hard timeout, and a bounded capture buffer. Resolves (never
 *  throws) with the raw stdout/stderr parts plus the failure message, so
 *  each consumer composes its own user-facing output string.
 *
 *  Scope: pipe-captured one-shot commands. Process runners that stream
 *  output to files, kill a detached process group, or finalize from disk
 *  artifacts (workers/src/runner.ts) have different semantics and do not
 *  share this mechanism. */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

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

const execAsync = promisify(execCb);

/** One-line platform note for shell-command failure output, or "" when the
 *  platform needs no note. `child_process.exec` runs commands under /bin/sh,
 *  which is bash 3.2 on macOS — commands authored with bash-4 or GNU-only
 *  tool flags fail there and can otherwise be misread as a genuine fault. */
export function execPlatformHint(): string {
  if (process.platform !== "darwin") return "";
  return "Platform: darwin (commands run under /bin/sh, bash 3.2). Use POSIX-sh syntax and BSD-compatible tool flags, then re-run.";
}

/** Run one shell command with a timeout and a bounded capture buffer.
 *  A timeout kills the child (SIGTERM); whatever it produced before the
 *  kill or the buffer overflow is still returned. */
export async function runExec(command: string, options: ExecOptions): Promise<ExecOutcome> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    });
    return { ok: true, stdout, stderr, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: e.message,
      durationMs: Date.now() - started,
    };
  }
}
