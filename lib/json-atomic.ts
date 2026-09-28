/**
 * Atomic JSON file writes.
 *
 * A crash mid-write must never leave a truncated or half-written file behind,
 * so every write lands in a temp sibling first and is renamed over the target
 * (rename is atomic on the platforms we target). The temp file is fsynced
 * before the rename, so after a crash the target is either the previous file
 * or the complete new one — never a page-cache-only file that vanished with
 * the machine. (Directory entries are not fsynced, so a power loss can still
 * roll the rename itself back; the invariant is no torn content.)
 *
 * Consumers: messenger reservations, missions, autoresearch, the agents
 * worker registry, and presence shards.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteJsonAtomicOptions {
  /** Mode for the freshly created file. Omitted, the platform default applies. */
  mode?: number;
}

/**
 * Serialize `data` as pretty-printed JSON and atomically replace `path`:
 * writes `${path}.${pid}.${random}.tmp` next to it, fsyncs it, then renames
 * the temp file into place. Creates parent directories as needed.
 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  const handle = await open(tmp, "w", options.mode);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
