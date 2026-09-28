/** `.pi/autoresearch/` file storage: config.json and the append-only log.jsonl. The
 * `.pi/autoresearch/` directory is excluded locally from git during init so keep/revert
 * cycles can never destroy the experiment record. */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { excludeFromGit } from "../../../lib/git.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir, projectStateRelative } from "../../../lib/paths.ts";
import type { AutoConfig, RunEntry } from "./types.ts";

// --- Paths ---

const GIT_EXCLUDE_PATTERN = `${projectStateRelative("autoresearch")}/`;

export function autoDir(cwd: string): string {
  return projectStateDir(cwd, "autoresearch");
}

export function configPath(cwd: string): string {
  return join(autoDir(cwd), "config.json");
}

export function logPath(cwd: string): string {
  return join(autoDir(cwd), "log.jsonl");
}

export function promptPath(cwd: string): string {
  return join(autoDir(cwd), "prompt.md");
}

// --- Config ---

function isActiveConfig(value: unknown): value is AutoConfig {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<AutoConfig>;
  return (
    typeof c.objective === "string" &&
    typeof c.metric === "string" &&
    (c.direction === "lower" || c.direction === "higher") &&
    typeof c.measure === "string"
  );
}

/** Read a state file, distinguishing "absent" from "broken": only ENOENT (or
 *  ENOTDIR, i.e. a missing parent directory) returns undefined. A corrupt or
 *  unreadable file must fail visibly — treating it as absent would let a
 *  re-init silently overwrite an existing campaign. */
async function readStateFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw new Error(`autoresearch state file ${path} is unreadable: ${String(error)}`);
  }
}

export async function saveConfig(cwd: string, config: AutoConfig): Promise<void> {
  await writeJsonAtomic(configPath(cwd), config);
}

export async function loadConfig(cwd: string): Promise<AutoConfig | undefined> {
  const raw = await readStateFile(configPath(cwd));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `autoresearch config ${configPath(cwd)} is corrupt (invalid JSON): ${String(error)}`,
    );
  }
  // A foreign shape (older version, hand-edited) is not corruption: treat it
  // as absent rather than failing every subsequent call.
  return isActiveConfig(parsed) ? parsed : undefined;
}

export async function requireActiveConfig(
  cwd: string,
  sessionId: string | undefined,
): Promise<AutoConfig> {
  const config = await loadConfig(cwd);
  if (!config) {
    throw new Error(
      "No autoresearch session. Use action=init with objective, metric, direction, and measure command.",
    );
  }
  if (config.stopped) {
    throw new Error("This autoresearch session is stopped. Re-init to start a new one.");
  }
  if (config.ownerSessionId !== undefined && config.ownerSessionId !== sessionId) {
    throw new Error(
      "This autoresearch campaign is owned by another session. Only its owner can run, log, or stop it; recover an abandoned campaign manually.",
    );
  }
  return config;
}

// --- Log ---

function isRunEntry(value: unknown): value is RunEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RunEntry>;
  return (
    Number.isSafeInteger(entry.run) &&
    (entry.run as number) > 0 &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    ["baseline", "keep", "discard", "checks_failed", "invalid"].includes(entry.status ?? "") &&
    typeof entry.description === "string" &&
    (entry.hypothesis === undefined || typeof entry.hypothesis === "string") &&
    (entry.metric === undefined ||
      (typeof entry.metric === "number" && Number.isFinite(entry.metric))) &&
    (entry.durationMs === undefined ||
      (typeof entry.durationMs === "number" &&
        Number.isFinite(entry.durationMs) &&
        entry.durationMs >= 0)) &&
    (entry.commit === undefined || typeof entry.commit === "string") &&
    (entry.checksFailed === undefined || typeof entry.checksFailed === "boolean")
  );
}

export async function readLog(cwd: string): Promise<RunEntry[]> {
  const raw = await readStateFile(logPath(cwd));
  if (raw === undefined) return [];
  const entries: RunEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `autoresearch log ${logPath(cwd)} line ${index + 1} is corrupt (invalid JSON): ${String(error)}`,
      );
    }
    if (!isRunEntry(parsed)) {
      throw new Error(
        `autoresearch log ${logPath(cwd)} line ${index + 1} is corrupt (invalid run entry).`,
      );
    }
    entries.push(parsed);
  }
  return entries;
}

export async function appendLog(cwd: string, entry: RunEntry): Promise<void> {
  await mkdir(autoDir(cwd), { recursive: true });
  await appendFile(logPath(cwd), `${JSON.stringify(entry)}\n`, "utf8");
}

/** Move the current campaign log aside so a new campaign starts clean. */
export async function archiveLog(cwd: string): Promise<void> {
  try {
    await rename(logPath(cwd), join(autoDir(cwd), `log.${Date.now()}.jsonl`));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export function nextRunNumber(entries: RunEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.run), 0) + 1;
}

// --- prompt.md ---

export async function savePrompt(
  cwd: string,
  config: AutoConfig,
  extraNotes?: string,
): Promise<void> {
  await mkdir(autoDir(cwd), { recursive: true });
  const lines = [
    `# Autoresearch: ${config.objective}`,
    "",
    `- Metric: ${config.metric}${config.unit ? ` (${config.unit})` : ""} — ${config.direction === "lower" ? "lower is better" : "higher is better"}`,
    `- Measure command: \`${config.measure}\``,
    config.checks
      ? `- Correctness checks: \`${config.checks}\``
      : "- Correctness checks: none configured",
    config.maxIterations
      ? `- Iteration cap: ${config.maxIterations}`
      : "- Iteration cap: unlimited",
    "",
    extraNotes?.trim() ? `## Notes\n\n${extraNotes.trim()}\n` : "",
  ];
  await writeFile(promptPath(cwd), `${lines.join("\n")}\n`, "utf8");
}

// --- Git hygiene ---

/** Ensure the autoresearch state directory never enters a commit, without
 * touching .gitignore. */
export function excludeAutoFromGit(cwd: string): Promise<boolean> {
  return excludeFromGit(cwd, GIT_EXCLUDE_PATTERN);
}

// --- Untracked baseline snapshot ---

function untrackedSnapshotPath(cwd: string): string {
  return join(autoDir(cwd), "untracked-snapshot.json");
}

/** Untracked files present when the experiment base was captured: discards
 * never remove these and keeps never stage them. Written atomically (tmp +
 * rename) like config.json — a partial snapshot would parse as garbage and
 * let a keep absorb pre-existing untracked work into its commit. */
export async function saveUntrackedSnapshot(cwd: string, files: string[]): Promise<void> {
  await writeJsonAtomic(untrackedSnapshotPath(cwd), files);
}

/** Load the untracked baseline snapshot, or undefined when no snapshot file
 * exists (legacy campaigns). A file that exists but cannot be parsed is a
 * hard error: keeps and discards scope themselves from the snapshot, so
 * guessing a baseline could commit pre-existing work or delete files it
 * should never touch. */
export async function loadUntrackedSnapshot(cwd: string): Promise<string[] | undefined> {
  const path = untrackedSnapshotPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Untracked snapshot ${path} is corrupt (invalid JSON): ${detail}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Untracked snapshot ${path} is corrupt (expected a JSON array of file paths).`);
  }
  return parsed;
}
