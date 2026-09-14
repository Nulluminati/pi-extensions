/** `.pi/autoresearch/` file storage: config.json and the append-only log.jsonl. The
 * `.pi/autoresearch/` directory is excluded locally from git during init so keep/revert
 * cycles can never destroy the experiment record. */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runGit } from "../../../lib/git.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import type { AutoConfig, RunEntry } from "./types.ts";

// --- Paths ---

const GIT_EXCLUDE_PATTERN = ".pi/autoresearch/";

export function autoDir(cwd: string): string {
  return join(cwd, ".pi", "autoresearch");
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

export async function saveConfig(cwd: string, config: AutoConfig): Promise<void> {
  await writeJsonAtomic(configPath(cwd), config);
}

export async function loadConfig(cwd: string): Promise<AutoConfig | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(cwd), "utf8"));
    return isActiveConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// --- Log ---

export async function readLog(cwd: string): Promise<RunEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath(cwd), "utf8");
  } catch {
    return [];
  }
  const entries: RunEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RunEntry);
    } catch {
      // Skip malformed lines; the log stays append-only.
    }
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

/** Ensure `.pi/autoresearch/` never enters a commit, without touching .gitignore.
 * The exclude path is resolved through git so linked worktrees — where `.git`
 * is a file, not a directory — work correctly. */
export async function excludeAutoFromGit(cwd: string): Promise<void> {
  const reported = (await runGit(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const exclude = isAbsolute(reported) ? reported : resolve(cwd, reported);
  let current = "";
  try {
    current = await readFile(exclude, "utf8");
  } catch {
    // File may not exist yet; appendFile creates it (.git/info always exists).
  }
  if (current.split("\n").includes(GIT_EXCLUDE_PATTERN)) return;
  await appendFile(exclude, `${GIT_EXCLUDE_PATTERN}\n`, "utf8");
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
