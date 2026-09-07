/** Measurement and git operations for the autoresearch loop. */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { runGit } from "../../../lib/git.ts";

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
  output: string;
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
    return {
      ok: true,
      output: `${stdout}${stderr}`.trim(),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      output: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim(),
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

/** Stage everything and commit; returns the short commit id. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await runGit(cwd, ["add", "-A"]);
  // Message passed via env to avoid shell-quoting bugs.
  await execAsync('git commit -q -m "$AR_MSG"', {
    cwd,
    env: { ...process.env, AR_MSG: message },
  });
  const id = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return id.trim();
}

/** Revert all uncommitted changes, including newly created files. */
export async function discardAll(cwd: string): Promise<void> {
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["reset", "--hard", "HEAD"]);
}
