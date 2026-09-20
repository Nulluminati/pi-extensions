/**
 * Cross-process advisory file lock.
 *
 * Read-modify-write cycles over shared state files need mutual exclusion
 * across sessions; two sessions doing them at once would otherwise save
 * stale maps over each other's changes. Every acquisition creates the lock
 * file with `open(path, "wx")` — an atomic create-or-fail on every platform
 * we target. Waiters poll until the holder unlinks the file, and a lock
 * whose mtime has not moved for `staleMs` is treated as abandoned by a
 * crashed holder and reclaimed. The holder refreshes the mtime on an
 * interval while it works, so a long critical section is never mistaken for
 * a crashed holder.
 *
 * Consumption model: every acquisition creates the lock file with
 * `open(path, "wx")` — an atomic create-or-fail on every platform we target —
 * and writes a `<pid> <token>` ownership record into it. The token binds the
 * holder to the exact inode it created: refreshes go through the original
 * file handle (never the pathname), and release verifies ownership before
 * unlinking, so a lock that was reclaimed and recreated by a waiter is never
 * refreshed or deleted by the old holder. Waiters poll until the holder
 * unlinks the file; a lock whose mtime has not moved for `staleMs` is
 * reclaimed only when the recorded pid is no longer alive, so a live holder
 * that merely stalled past the stale window is never robbed.
 */

import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// --- Constants ---

const LOCK_RETRY_MS = 10;
/** Waiter timeout; must stay >= the stale window so a waiter never declares
 *  a live (refreshing) lock stale and steals it while still waiting. */
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 15_000;
const LOCK_REFRESH_MS = 5_000;

// --- Types ---

interface LockOwnership {
  pid: number;
  token: string | undefined;
}

export interface FileLockOptions {
  /** Lock whose mtime is older than this is treated as abandoned by a
   *  crashed holder and reclaimed by waiters. Defaults to 15s. */
  staleMs?: number;
  /** How often the holder refreshes the lock mtime while held. Defaults to
   *  5s. */
  refreshMs?: number;
  /** Total time a waiter spends before giving up. Must be >= staleMs.
   *  Defaults to 30s. */
  timeoutMs?: number;
  /** Overrides the timeout error message for consumers whose errors name
   *  their domain (e.g. a mission save naming the mission id). */
  timeoutMessage?: string;
}

// --- Helpers ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Best-effort liveness probe: signal 0 throws ESRCH for a dead pid and
 *  EPERM for a live one we cannot signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function parseLockOwner(content: string): LockOwnership | undefined {
  const [pidField, tokenField] = content.trim().split(/\s+/);
  const pid = Number.parseInt(pidField ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, token: tokenField };
}

async function readLockOwner(lockPath: string): Promise<LockOwnership | undefined> {
  const content = await readFile(lockPath, "utf8").catch(() => undefined);
  return content === undefined ? undefined : parseLockOwner(content);
}

async function acquireFileLock(
  lockPath: string,
  staleMs: number,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<{ handle: FileHandle; token: string }> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return { handle: await open(lockPath, "wx", 0o600), token: randomBytes(8).toString("hex") };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs >= staleMs) {
        // Reclaim only when the recorded holder is gone. A live process that
        // stalled past the stale window must never be robbed of its lock,
        // and the pid is the only signal that survives an mtime race.
        const owner = await readLockOwner(lockPath);
        if (owner === undefined || !isProcessAlive(owner.pid)) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(timeoutMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

// --- Lock ---

/** Run `fn` while holding the lock file at `lockPath`. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const refreshMs = options.refreshMs ?? LOCK_REFRESH_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? `Timed out waiting for lock ${lockPath}.`;
  await mkdir(dirname(lockPath), { recursive: true });
  const { handle, token } = await acquireFileLock(lockPath, staleMs, timeoutMs, timeoutMessage);
  const content = `${process.pid} ${token}\n`;
  let refresh: ReturnType<typeof setInterval> | undefined;
  try {
    await handle.writeFile(content, "utf8");
    // Keep the lock's mtime fresh while held so waiters never reclaim the
    // lock from a live holder whose critical section outlasts the stale
    // window. The write goes through the original handle — the inode this
    // holder created — so it updates our own lock even if the pathname was
    // replaced, and can never touch a replacement created by someone else.
    const buffer = Buffer.from(content, "utf8");
    refresh = setInterval(() => {
      void handle.write(buffer, 0, buffer.length, 0).catch(() => {
        // Best-effort: a failed refresh (e.g. the handle was closed by an
        // in-flight release) must not abort fn(); the finally below cleans up.
      });
    }, refreshMs);
    return await fn();
  } finally {
    if (refresh !== undefined) clearInterval(refresh);
    await handle.close().catch(() => {});
    // Unlink only when the pathname still holds our own lock. After a
    // reclaim, the file at lockPath was recreated by another holder; deleting
    // it by pathname would let a third process into the critical section
    // while that holder is still active.
    const owner = await readLockOwner(lockPath);
    if (owner !== undefined && owner.pid === process.pid && owner.token === token) {
      await unlink(lockPath).catch(() => {});
    }
  }
}
