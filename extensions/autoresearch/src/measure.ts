/** Measurement and git operations for the autoresearch loop. */

import { exec as execCb } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanGitEnv, runGit } from "../../../lib/git.ts";
import { isProjectStatePath } from "../../../lib/paths.ts";

const execAsync = promisify(execCb);

// --- Constants ---

export const MEASURE_TIMEOUT_MS = 600_000;
export const CHECKS_TIMEOUT_MS = 300_000;

// --- Metric parsing ---

/**
 * Parse the configured metric out of measure output. Recognized forms:
 * - `METRIC name=value` lines (anywhere in output)
 * - `name=value` where name matches the configured metric
 * - fallback: the last bare number in the output, but only when the output
 *   contains no METRIC-tagged lines at all
 */
export function parseMetric(output: string, metric: string): number | undefined {
  const lines = output.split("\n");
  for (const line of lines) {
    const tagged = line.match(/^\s*METRIC\s+(.+)$/);
    if (tagged?.[1]) {
      // Split on the first "=" only: values may carry further "=" signs or
      // trailing unit text ("METRIC time=42 ms"). Only a line whose name
      // matches the configured metric exactly (case-sensitive) counts —
      // `METRIC memory=500` must not be read as the latency metric, and a
      // name that merely extends it ("latencyness") must not match either.
      const eq = tagged[1].indexOf("=");
      if (eq === -1) continue;
      const name = tagged[1].slice(0, eq).trim();
      if (name !== metric) continue;
      const rest = tagged[1].slice(eq + 1);
      const numeric = rest.match(/^\s*([-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/);
      if (numeric?.[1]) {
        const value = Number.parseFloat(numeric[1]);
        if (Number.isFinite(value)) return value;
      }
    }
  }
  for (const line of lines) {
    const re = new RegExp(
      `^\\s*${metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(-?[0-9.eE+]+)`,
    );
    const m = line.match(re);
    if (m?.[1]) {
      const value = Number.parseFloat(m[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  // The last-number fallback only applies when the output carries no METRIC
  // tags: if tagged lines exist but none matches the configured metric,
  // guessing an unrelated number would corrupt the campaign log.
  if (!lines.some((line) => /^\s*METRIC\b/.test(line))) {
    const numbers = output.match(/-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g);
    if (numbers && numbers.length > 0) {
      const last = numbers[numbers.length - 1];
      if (last !== undefined) {
        const value = Number.parseFloat(last);
        if (Number.isFinite(value)) return value;
      }
    }
  }
  return undefined;
}

// --- Command execution ---

export interface CommandOutcome {
  ok: boolean;
  /** Full diagnostic output, including the process error when execution fails. */
  output: string;
  /** Process stdout and stderr only; safe to inspect for a reported metric. */
  metricOutput: string;
  durationMs: number;
}

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Keep stdout and stderr as separate lines: concatenating them can merge
    // a stdout metric with digits at the start of stderr.
    const metricOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      ok: true,
      output: metricOutput,
      metricOutput,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const metricOutput = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    return {
      ok: false,
      output: [metricOutput, e.message].filter(Boolean).join("\n").trim(),
      metricOutput,
      durationMs: Date.now() - started,
    };
  }
}

// --- Git ---

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const stdout = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export interface ChangedFiles {
  tracked: string[];
  untracked: string[];
}

/**
 * Worktree paths with uncommitted changes (modified, renamed, deleted, or
 * untracked files), NUL-safe and relative to cwd. Ignored files — including
 * the campaign's own `.pi/autoresearch/` when locally excluded — are not
 * reported.
 */
export async function changedFiles(cwd: string): Promise<ChangedFiles> {
  const out = await runGit(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const tokens = out.split("\0");
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (status === "??") untracked.add(path);
    else tracked.add(path);
    // Renames and copies carry the original path as the next NUL token.
    if (status.includes("R") || status.includes("C")) {
      i += 1;
      const original = tokens[i];
      if (original) tracked.add(original);
    }
  }
  return {
    tracked: [...tracked].sort(),
    untracked: [...untracked].sort(),
  };
}

/**
 * Untracked files (file-level, NUL-safe) relative to cwd.
 */
export async function listUntracked(cwd: string): Promise<string[]> {
  return (await changedFiles(cwd)).untracked;
}

/**
 * Commit the current experiment's changes only: tracked worktree changes plus
 * untracked files created after the campaign's baseline snapshot. Files that
 * existed before the experiment — unrelated tracked edits, untracked state, or
 * tracked files already dirty when the campaign started (`dirtyAtInit`) — are
 * never staged. Returns the short commit id.
 */
export async function commitExperiment(
  cwd: string,
  message: string,
  baselineUntracked?: string[],
  dirtyAtInit?: string[],
): Promise<string> {
  const { tracked, untracked } = await changedFiles(cwd);
  const baseline = new Set(baselineUntracked ?? []);
  const preExisting = new Set(dirtyAtInit ?? []);
  const paths = [
    ...new Set([
      ...tracked.filter((p) => !preExisting.has(p)),
      // Project state created mid-campaign (.pi/...) is infrastructure, not
      // an experiment change; init already exempts it from the clean-tree
      // check, so a keep must not commit it either.
      ...untracked.filter((p) => !baseline.has(p) && !isProjectStatePath(p)),
    ]),
  ];
  if (paths.length === 0) throw new Error("No experiment changes to commit.");
  await runGit(cwd, ["add", "--", ...paths]);
  // Message passed via env to avoid shell-quoting bugs. Git env must be
  // sanitized: inherited GIT_INDEX_FILE (e.g. under lint-staged) makes this
  // commit build its tree from the outer repo's index. The timeout keeps a
  // hanging pre-commit hook from stalling the tool forever.
  await execAsync('git commit -q -m "$AR_MSG"', {
    cwd,
    env: { ...cleanGitEnv(), AR_MSG: message },
    timeout: CHECKS_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const id = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return id.trim();
}

/**
 * Revert the current experiment: tracked changes are restored from HEAD, and
 * untracked files created after the campaign's baseline snapshot are removed.
 * Pre-existing work — unrelated tracked edits, untracked files captured in
 * the baseline, or tracked files already dirty when the campaign started
 * (`dirtyAtInit`) — is never touched. A missing snapshot (legacy campaigns)
 * leaves untracked files alone for the same reason.
 */
export async function discardExperiment(
  cwd: string,
  baselineUntracked?: string[],
  dirtyAtInit?: string[],
): Promise<void> {
  const { tracked, untracked } = await changedFiles(cwd);
  const preExisting = new Set(dirtyAtInit ?? []);
  const restore = tracked.filter((p) => !preExisting.has(p));
  if (restore.length > 0) {
    // Restore both index and worktree so an experiment that staged a new file
    // is discarded just as safely as an unstaged edit or deletion.
    await runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore]);
  }
  if (baselineUntracked === undefined) return;
  const baseline = new Set(baselineUntracked);
  for (const rel of untracked) {
    if (!baseline.has(rel)) await rm(join(cwd, rel), { force: true });
  }
}
