/**
 * Filesystem case-behavior probing.
 *
 * The default macOS volume (APFS) folds path case; Linux filesystems do not.
 * Anything that derives uniqueness from names (agent identity, reservations,
 * shard files) must measure the actual volume instead of inferring it from
 * the OS — Linux installs on folding volumes exist, and macOS can run
 * case-sensitive volumes. The probe writes a temp file and stats its
 * uppercased twin; results are cached briefly per directory because a probe
 * costs one file create per TTL window.
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CASE_PROBE_TTL_MS = 60_000;
// Module-level `let` by exemption: this memo caches a filesystem measurement,
// not session or coordination state. Pi instances probing the same directory
// share its volume's case behavior. A result only applies to its own directory
// and expires after CASE_PROBE_TTL_MS; changes to volume behavior within that
// interval can temporarily affect case-folded reservation conflicts. Tests in
// test/extensions/messenger.test.ts pin directory scoping and expiry.
let caseProbeCache: { dir: string; insensitive: boolean; at: number } | undefined;

/**
 * Whether the filesystem backing `dir` treats names differing only by case as
 * one file. Probes by creating a uniquely named file and looking for its
 * case-flipped twin; a failed probe folds case to avoid missing a held path.
 * Cached briefly per directory: a probe costs one file create per TTL window.
 */
export function isCaseInsensitiveVolume(dir: string): boolean {
  const now = Date.now();
  if (caseProbeCache && caseProbeCache.dir === dir && now - caseProbeCache.at < CASE_PROBE_TTL_MS) {
    return caseProbeCache.insensitive;
  }
  let insensitive = true;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = `case-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
    const handle = openSync(join(dir, probe), "wx", 0o600);
    try {
      try {
        statSync(join(dir, probe.toUpperCase()));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") insensitive = false;
        else throw error;
      }
    } finally {
      closeSync(handle);
      unlinkSync(join(dir, probe));
    }
  } catch {
    insensitive = true;
  }
  caseProbeCache = { dir, insensitive, at: now };
  return insensitive;
}
