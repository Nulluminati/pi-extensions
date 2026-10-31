/** Shared exec-with-timeout runner: a `/bin/sh` command with a cwd, a hard
 *  timeout that kills the command's process group, and a bounded capture
 *  buffer. Resolves (never
 *  throws) with the raw stdout/stderr parts plus the failure message, so
 *  each consumer composes its own user-facing output string.
 *
 *  Scope: pipe-captured one-shot commands. Process runners that stream
 *  output to files, outlive the caller, or finalize from disk artifacts
 *  (workers/src/runner.ts) have different semantics and do not share this
 *  mechanism. */

import { type ChildProcess, spawn } from "node:child_process";

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
 *  platform needs no note. `runExec` runs commands under /bin/sh,
 *  which is bash 3.2 on macOS — commands authored with bash-4 or GNU-only
 *  tool flags fail there and can otherwise be misread as a genuine fault. */
export function execPlatformHint(): string {
  if (process.platform !== "darwin") return "";
  return "Platform: darwin (commands run under /bin/sh, bash 3.2). Use POSIX-sh syntax and BSD-compatible tool flags, then re-run.";
}

/** How long a timed-out command gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 1_000;

/** Capture cap per stream when the caller sets none (matches Node's exec). */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Run one shell command with a timeout and a bounded capture buffer.
 *  The command runs under /bin/sh in its own process group. At the
 *  timeout the whole group gets SIGTERM, then SIGKILL after a short grace
 *  period, so descendants do not outlive the call. A command that outlives
 *  the timeout always fails, even when it later exits 0, and the call
 *  settles at most one grace period past the deadline even when a process
 *  outside the group keeps the output pipes open. Whatever the command
 *  produced before the kill or the buffer overflow is still returned. */
export function runExec(command: string, options: ExecOptions): Promise<ExecOutcome> {
  const started = Date.now();
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  // Windows has no process groups; there the kill reaches the shell only.
  const ownGroup = process.platform !== "win32";
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let failure: string | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const captured = { stdout: new Capture(maxBuffer), stderr: new Capture(maxBuffer) };

    const settle = (outcome: Omit<ExecOutcome, "stdout" | "stderr" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      resolve({
        ...outcome,
        stdout: captured.stdout.text(),
        stderr: captured.stderr.text(),
        durationMs: Date.now() - started,
      });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        detached: ownGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const signal = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(ownGroup ? -pid : pid, sig);
      } catch {
        // The group is already gone.
      }
    };

    /** SIGTERM the group now; SIGKILL it and release the pipes after the
     *  grace period. Safe to call twice. */
    const terminate = (): void => {
      if (graceTimer) return;
      signal("SIGTERM");
      graceTimer = setTimeout(() => {
        signal("SIGKILL");
        // A process that left the group can still hold the pipes open;
        // closing our ends lets "close" fire now.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, KILL_GRACE_MS);
    };

    for (const name of ["stdout", "stderr"] as const) {
      child[name]?.on("data", (chunk: Buffer) => {
        if (captured[name].push(chunk) || failure || timedOut) return;
        failure = `${name} maxBuffer length exceeded`;
        terminate();
      });
    }

    child.on("error", (err) => settle({ ok: false, error: err.message }));

    child.on("close", (code, sig) => {
      // The first cause wins: an overflow kill can finish after the deadline.
      if (failure) {
        settle({ ok: false, error: failure });
      } else if (timedOut) {
        settle({ ok: false, error: `Command timed out after ${options.timeoutMs} ms: ${command}` });
      } else if (code === 0) {
        settle({ ok: true });
      } else {
        const stderr = captured.stderr.text();
        const cause = sig ? ` (killed by ${sig})` : "";
        settle({ ok: false, error: `Command failed${cause}: ${command}\n${stderr}`.trimEnd() });
      }
    });

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
  });
}

/** Byte-capped capture of one output stream. */
class Capture {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  /** Append a chunk, truncated at the limit. False once the limit is passed. */
  push(chunk: Buffer): boolean {
    const room = this.limit - this.bytes;
    if (room > 0) {
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(kept);
      this.bytes += kept.length;
    }
    return chunk.length <= room;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
