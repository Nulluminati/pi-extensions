/**
 * Cross-process advisory file lock.
 *
 * Read-modify-write cycles over shared state files need mutual exclusion
 * across sessions; two sessions doing them at once would otherwise save
 * stale maps over each other's changes. Every acquisition stages its
 * `<pid> <token>` ownership record in a unique temp sibling and links it
 * onto the lock pathname, so the lock carries its owner from the first
 * instant it exists and a waiter never observes an ownerless lock. Waiters
 * poll until the holder unlinks the file, and a lock whose mtime has not
 * moved for `staleMs` is treated as abandoned by a crashed holder and
 * reclaimed. The holder refreshes the mtime on an interval while it works,
 * so a long critical section is never mistaken for a crashed holder.
 *
 * Consumption model: the record is placed with `link(tempPath, lockPath)` —
 * an all-or-nothing create on every platform we target. The token binds the
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
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
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

/** An acquired lock: the still-open handle to the lock inode and the token
 *  recorded in its ownership content. */
interface AcquiredLock {
  handle: FileHandle;
  token: string;
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

/**
 * One atomic create-with-content attempt: the `<pid> <token>` ownership
 * record is staged in a private temp sibling and linked onto the lock
 * pathname, so the lock carries its owner from its first observable instant
 * and a waiter never sees an ownerless lock it could mistake for abandoned.
 * Returns the still-open handle when this caller won the pathname, or
 * undefined when it was already taken (EEXIST). Any other failure
 * propagates. The temp directory entry never survives this function.
 */
async function createLockFile(lockPath: string): Promise<AcquiredLock | undefined> {
  const token = randomBytes(8).toString("hex");
  const tempPath = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${process.pid} ${token}\n`, "utf8");
    try {
      await link(tempPath, lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      // The pathname is taken: close the staging handle and let the caller
      // fall into its waiter logic.
      await handle.close().catch(() => {});
      handle = undefined;
      return undefined;
    }
    return { handle, token };
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    throw error;
  } finally {
    // After a win the temp entry is a redundant hard link to the lock inode
    // (the open handle keeps the inode alive); after a loss it is staging
    // garbage. Either way the name must go.
    await unlink(tempPath).catch(() => {});
  }
}

async function acquireFileLock(
  lockPath: string,
  staleMs: number,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<AcquiredLock> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const acquired = await createLockFile(lockPath);
    if (acquired !== undefined) return acquired;
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
  let refresh: ReturnType<typeof setInterval> | undefined;
  try {
    // Keep the lock's mtime fresh while held so waiters never reclaim the
    // lock from a live holder whose critical section outlasts the stale
    // window. The write goes through the original handle — the inode this
    // holder created — so it updates our own lock even if the pathname was
    // replaced, and can never touch a replacement created by someone else.
    const buffer = Buffer.from(`${process.pid} ${token}\n`, "utf8");
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
