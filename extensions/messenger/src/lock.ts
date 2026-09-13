/**
 * Cross-process advisory file lock for messenger state files.
 *
 * Reservation updates and mailbox compaction are read-modify-write cycles;
 * two sessions doing them at once would otherwise save stale maps over each
 * other's changes. Every mutation takes a lock file created with
 * `open(path, "wx")` — an atomic create-or-fail on every platform we target.
 * Waiters poll until the holder unlinks the file, and a lock whose mtime has
 * not moved for `LOCK_STALE_MS` is treated as abandoned by a crashed holder
 * and reclaimed.
 */

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// --- Constants ---

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

// --- Helpers ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function acquireFileLock(lockPath: string): Promise<FileHandle> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
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
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await acquireFileLock(lockPath);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
