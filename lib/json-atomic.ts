/**
 * Atomic JSON file writes.
 *
 * A crash mid-write must never leave a truncated or half-written file behind,
 * so every write lands in a temp sibling first and is renamed over the target
 * (rename is atomic on the platforms we target). Consumers: messenger
 * reservations, missions, autoresearch, the agents worker registry, and
 * presence shards.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteJsonAtomicOptions {
  /** Mode for the freshly created file. Omitted, the platform default applies. */
  mode?: number;
}

/**
 * Serialize `data` as pretty-printed JSON and atomically replace `path`:
 * writes `${path}.${pid}.${random}.tmp` next to it, then renames the temp
 * file into place. Creates parent directories as needed.
 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  await rename(tmp, path);
}
