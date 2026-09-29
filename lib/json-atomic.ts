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
 * Consumers: messenger reservations, missions, autoresearch, the workers
 * worker registry, and presence shards. `writeTextAtomic` is the text-level
 * primitive beneath `writeJsonAtomic`; messenger also uses it directly for
 * JSONL mailbox rewrites.
 */

import { randomBytes } from "node:crypto";
import { type FileHandle, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteAtomicOptions {
  /** Mode for the freshly created file. When omitted, an existing target
   *  keeps its mode across rewrites and a new file gets the platform
   *  default. An explicit mode always wins. */
  mode?: number;
}

/** Attempts to draw an unoccupied temp name before giving up. The 8-byte
 *  random suffix makes collisions vanishingly rare; the bound only matters
 *  under a pathological pile-up of concurrent writers. */
const TEMP_NAME_ATTEMPTS = 3;

/**
 * Atomically replace `path` with `text`: writes
 * `${path}.${pid}.${random}.tmp` next to it, fsyncs it, then renames the
 * temp file into place. The temp file is created exclusively (O_EXCL), so
 * two concurrent writers never truncate each other's staging file — a
 * colliding name is redrawn, bounded, before failing. Creates parent
 * directories as needed. Use this for plain-text formats such as JSONL;
 * use `writeJsonAtomic` for JSON documents.
 */
export async function writeTextAtomic(
  path: string,
  text: string,
  options: WriteAtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = options.mode ?? (await existingMode(path));
  let handle: FileHandle | undefined;
  let tmp = "";
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt++) {
    tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      // "wx" = exclusive create: never truncates an existing temp file.
      handle = await open(tmp, "wx", mode);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === TEMP_NAME_ATTEMPTS - 1) break;
    }
  }
  if (!handle) {
    throw new Error(
      `Could not create a temp file for ${path}: ${TEMP_NAME_ATTEMPTS} exclusive-create attempts all hit an existing file`,
    );
  }
  try {
    await handle.writeFile(text, "utf8");
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

/** Mode of the existing target, so a rewrite never widens a narrowed file
 *  (rename replaces the inode, carrying the temp file's mode with it). */
async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Serialize `data` as pretty-printed JSON and atomically replace `path`.
 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  options: WriteAtomicOptions = {},
): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(data, null, 2), options);
}
