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

/**
 * Serialize `data` as pretty-printed JSON and atomically replace `path`:
 * writes `${path}.${pid}.${random}.tmp` next to it, then renames the temp
 * file into place. Creates parent directories as needed.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}
