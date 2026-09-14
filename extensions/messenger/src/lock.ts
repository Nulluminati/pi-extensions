/**
 * Cross-process advisory file lock for messenger state files.
 *
 * Reservation updates and mailbox compaction are read-modify-write cycles;
 * two sessions doing them at once would otherwise save stale maps over each
 * other's changes. Every mutation takes a lock file created with
 * `open(path, "wx")` — an atomic create-or-fail on every platform we target.
 * Waiters poll until the holder unlinks the file, and a lock whose mtime has
 * not moved for `LOCK_STALE_MS` is treated as abandoned by a crashed holder
 * and reclaimed. The holder refreshes the mtime on an interval while it
 * works, so a long critical section is never mistaken for a crashed holder.
 */

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

// --- Constants ---

const LOCK_RETRY_MS = 10;
/** Waiter timeout; must stay >= LOCK_STALE_MS so a waiter never declares a
 *  live (refreshing) lock stale and steals it while still waiting. */
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 15_000;
const LOCK_REFRESH_MS = 5_000;

// --- Types ---

export interface FileLockOptions {
  /** Lock whose mtime is older than this is treated as abandoned by a
   *  crashed holder and reclaimed by waiters. Defaults to LOCK_STALE_MS. */
  staleMs?: number;
  /** How often the holder refreshes the lock mtime while held. Defaults to
   *  LOCK_REFRESH_MS. */
  refreshMs?: number;
}

// --- Helpers ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function acquireFileLock(lockPath: string, staleMs: number): Promise<FileHandle> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs >= staleMs) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for messenger lock ${lockPath}.`);
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
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await acquireFileLock(lockPath, staleMs);
  let refresh: ReturnType<typeof setInterval> | undefined;
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    // Keep the mtime fresh while held so waiters never reclaim the lock from
    // a live holder whose critical section outlasts the stale window.
    refresh = setInterval(() => {
      void utimes(lockPath, new Date(), new Date()).catch(() => {
        // Best-effort: a failed refresh (e.g. the lock was already reclaimed
        // and unlinked) must not abort fn(); the finally below cleans up.
      });
    }, refreshMs);
    return await fn();
  } finally {
    if (refresh !== undefined) clearInterval(refresh);
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
