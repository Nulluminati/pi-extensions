/**
 * Process identity: a pid plus its start time.
 *
 * A pid alone is not an identity. After a process dies the operating system
 * reassigns its pid — quickly on macOS, whose pid space is small — so a
 * record stamped only with a pid can misclassify a recycled pid as the
 * original owner. The start time disambiguates: /proc/<pid>/stat field 22
 * (starttime, clock ticks) on Linux, `ps -o lstart=` on macOS, both
 * normalized to a comparable string. Verification only ever *keeps* an
 * alive verdict when the start time cannot be read: absence of evidence is
 * treated as the legacy pid-only behavior, never as proof of recycling.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isNodeError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** Collapse whitespace so Linux tick strings and BSD `lstart` output compare
 *  equal against their own re-reads (`Mon Jan  2` vs `Mon Jan 2`). */
function normalizeStamp(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Parse `ps -p <pid> -o lstart=` output ("Mon Jan  2 03:04:05 2023"). */
export function parsePsLstart(stdout: string): string | undefined {
  const normalized = normalizeStamp(stdout);
  if (!normalized) return undefined;
  // `ps` prints exactly one line for an existing pid and nothing (or a
  // notice on stderr) for a dead one; anything without a digit is noise.
  if (!/\d/.test(normalized)) return undefined;
  return normalized;
}

/** The process's start time in a platform-stable normalized string, or
 *  undefined when the process is gone or the value is unreadable. */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // comm (field 2) may contain spaces and parentheses; everything after
      // the last ')' restarts the field count at state (field 3), so
      // starttime (field 22) sits at index 19.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = afterComm[19];
      return ticks === undefined ? undefined : normalizeStamp(ticks);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return undefined;
      }
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    return parsePsLstart(stdout);
  } catch {
    return undefined;
  }
}

let selfStamp: Promise<string | undefined> | undefined;

/** This process's start time (cached: it never changes). */
export function currentProcessStartTime(): Promise<string | undefined> {
  selfStamp ??= processStartTime(process.pid);
  return selfStamp;
}

/**
 * True when `pid` currently belongs to a process that started *after* the
 * recorded owner — the recycled-pid signature. Conservative by design:
 * a missing stamp (legacy record), an unreadable start time, or a match all
 * return false, so only a positively observed mismatch flags recycling.
 */
export async function isRecycledPid(pid: number, startedAt?: string): Promise<boolean> {
  if (startedAt === undefined) return false;
  const current = await processStartTime(pid);
  if (current === undefined) return false;
  return current !== startedAt;
}
