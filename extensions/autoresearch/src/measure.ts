/** Measurement and git operations for the autoresearch loop. */

import { exec as execCb } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanGitEnv, runGit } from "../../../lib/git.ts";

const execAsync = promisify(execCb);

// --- Constants ---

export const MEASURE_TIMEOUT_MS = 600_000;
export const CHECKS_TIMEOUT_MS = 300_000;

// --- Metric parsing ---

/**
 * Parse the configured metric out of measure output. Recognized forms:
 * - `METRIC name=value` lines (anywhere in output)
 * - `name=value` where name matches the configured metric
 * - fallback: the last bare number in the output
 */
export function parseMetric(output: string, metric: string): number | undefined {
  const lines = output.split("\n");
  for (const line of lines) {
    const tagged = line.match(/^\s*METRIC\s+(.+)$/);
    if (tagged?.[1]) {
      const pair = tagged[1].split("=");
      if (pair.length === 2 && pair[1] !== undefined) {
        const value = Number.parseFloat(pair[1].trim());
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
  const numbers = output.match(/-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g);
  if (numbers && numbers.length > 0) {
    const last = numbers[numbers.length - 1];
    if (last !== undefined) {
      const value = Number.parseFloat(last);
      if (Number.isFinite(value)) return value;
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
 * existed before the experiment — unrelated tracked edits or untracked state —
 * are never staged. Returns the short commit id.
 */
export async function commitExperiment(
  cwd: string,
  message: string,
  baselineUntracked?: string[],
): Promise<string> {
  const { tracked, untracked } = await changedFiles(cwd);
  const baseline = new Set(baselineUntracked ?? []);
  const paths = [...new Set([...tracked, ...untracked.filter((p) => !baseline.has(p))])];
  if (paths.length === 0) throw new Error("No experiment changes to commit.");
  await runGit(cwd, ["add", "--", ...paths]);
  // Message passed via env to avoid shell-quoting bugs. Git env must be
  // sanitized: inherited GIT_INDEX_FILE (e.g. under lint-staged) makes this
  // commit build its tree from the outer repo's index.
  await execAsync('git commit -q -m "$AR_MSG"', {
    cwd,
    env: { ...cleanGitEnv(), AR_MSG: message },
  });
  const id = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return id.trim();
}

/**
 * Revert the current experiment: tracked changes are restored from HEAD, and
 * untracked files created after the campaign's baseline snapshot are removed.
 * Pre-existing work — unrelated tracked edits or untracked files captured in
 * the baseline — is never touched. A missing snapshot (legacy campaigns)
 * leaves untracked files alone for the same reason.
 */
export async function discardExperiment(cwd: string, baselineUntracked?: string[]): Promise<void> {
  const { tracked, untracked } = await changedFiles(cwd);
  if (tracked.length > 0) {
    // Restore both index and worktree so an experiment that staged a new file
    // is discarded just as safely as an unstaged edit or deletion.
    await runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  }
  if (baselineUntracked === undefined) return;
  const baseline = new Set(baselineUntracked);
  for (const rel of untracked) {
    if (!baseline.has(rel)) await rm(join(cwd, rel), { force: true });
  }
}
