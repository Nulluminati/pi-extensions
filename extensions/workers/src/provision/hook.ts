import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, projectStateRelative } from "../../../../lib/paths.ts";
// Documented exception: the repository's only cross-extension src import.
// startWorkerSandbox resolves ./broker.mjs through import.meta.url, so the
// client and broker must stay together in worker-sandbox/src/; see
// extensions/worker-sandbox/README.md ("Cross-Extension Use").
import { startWorkerSandbox } from "../../../worker-sandbox/src/client.ts";

const HOOK_PATH = projectStateRelative("provision-worktree");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DETAIL_LENGTH = 400;

export interface HookResult {
  exitCode: number;
  detail: string;
  ms: number;
  logPath: string;
}

/** Thrown when the caller's abort signal cancels setup; distinct from the internal timeout, which resolves. */
export class SetupHookCancelled extends Error {
  constructor(reason: string) {
    super(`worktree setup was cancelled: ${reason}`);
    this.name = "SetupHookCancelled";
  }
}

/** One-line reason for a caller's abort, from the signal's reason; the
 *  caller supplies the fallback for a reason that carries no usable text. */
export function abortReason(signal: AbortSignal | undefined, fallback: string): string {
  const reason = signal?.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return fallback;
}

/** Check the executable before reserving a worker slot or creating a worktree. */
export async function assertSetupHook(cwd: string): Promise<void> {
  const file = join(cwd, HOOK_PATH);
  const entry = await stat(file).catch(() => null);
  if (!entry?.isFile()) throw new Error(`worktree setup hook is missing: ${file}`);
  if ((entry.mode & 0o111) === 0) throw new Error(`worktree setup hook is not executable: ${file}`);
}

/** Run the project-owned script once, inside the same OS sandbox as worker tools.
 * Rejects with SetupHookCancelled when externalSignal aborts before or during the run.
 * A failed sandbox cleanup remains visible even during cancellation; the
 * internal timeout still resolves with a HookResult instead of throwing. */
export async function runSetupHook(
  worktree: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<HookResult> {
  if (externalSignal?.aborted)
    throw new SetupHookCancelled(abortReason(externalSignal, "caller aborted setup"));
  await assertSetupHook(worktree);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("worktree setup timeout must be positive");
  }
  const logDir = join(cacheDir("provision"), "runs");
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${Date.now()}-${randomUUID()}.log`);
  const started = Date.now();
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  let cancelReason = "caller aborted setup";
  const cancel = () => {
    cancelled = true;
    cancelReason = abortReason(externalSignal, "caller aborted setup");
    controller.abort();
  };
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  try {
    const client = await startWorkerSandbox(worktree);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let exitCode = -1;
    let failure: unknown;
    let cleanupFailure: unknown;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      if (cancelled) throw new SetupHookCancelled(cancelReason);
      const result = await client.runShell(`./${HOOK_PATH}`, {
        cwd: worktree,
        signal: controller.signal,
        timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
        onData(chunk) {
          if (bytes >= MAX_LOG_BYTES) {
            truncated = true;
            return;
          }
          const kept = chunk.subarray(0, MAX_LOG_BYTES - bytes);
          chunks.push(kept);
          bytes += kept.length;
          if (kept.length < chunk.length) truncated = true;
        },
      });
      exitCode = result.exitCode ?? -1;
    } catch (error) {
      if (!timedOut && !cancelled) failure = error;
    } finally {
      clearTimeout(timer);
      try {
        await client.close();
      } catch (error) {
        cleanupFailure = error;
        if (!cancelled) {
          failure =
            failure === undefined
              ? error
              : new AggregateError([failure, error], "Setup and sandbox cleanup failed");
        }
      }
    }
    const output = Buffer.concat(chunks).toString("utf8");
    await writeFile(logPath, truncated ? `${output}\n[output truncated]\n` : output, {
      mode: 0o600,
      flag: "wx",
    });
    if (cancelled) {
      const cancellation = new SetupHookCancelled(cancelReason);
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [cancellation, cleanupFailure],
          "Setup cancellation and sandbox cleanup failed",
        );
      }
      throw cancellation;
    }
    if (failure !== undefined) throw failure;
    const detail = timedOut
      ? `command aborted after ${timeoutMs}ms`
      : output.trim().slice(-DETAIL_LENGTH) ||
        (exitCode === 0 ? "" : `exit ${exitCode}: no output`);
    return {
      exitCode: timedOut ? -1 : exitCode,
      detail,
      ms: Date.now() - started,
      logPath,
    };
  } finally {
    externalSignal?.removeEventListener("abort", cancel);
  }
}
