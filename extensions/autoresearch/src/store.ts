/** `.pi/autoresearch/` file storage: config.json and the append-only log.jsonl. The
 * `.pi/autoresearch/` directory is excluded locally from git during init so keep/revert
 * cycles can never destroy the experiment record. */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  await mkdir(autoDir(cwd), { recursive: true });
  const tmp = `${configPath(cwd)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await rename(tmp, configPath(cwd));
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

/** Ensure `.pi/autoresearch/` never enters a commit, without touching .gitignore. */
export async function excludeAutoFromGit(cwd: string): Promise<void> {
  const exclude = join(cwd, ".git", "info", "exclude");
  let current = "";
  try {
    current = await readFile(exclude, "utf8");
  } catch {
    // File may not exist yet; appendFile creates it (.git/info always exists).
  }
  if (current.split("\n").includes(GIT_EXCLUDE_PATTERN)) return;
  await appendFile(exclude, `${GIT_EXCLUDE_PATTERN}\n`, "utf8");
}

// --- JSON file helpers ---

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// --- Untracked baseline snapshot ---

function untrackedSnapshotPath(cwd: string): string {
  return join(autoDir(cwd), "untracked-snapshot.json");
}

/** Files untracked when the campaign was initialized: discard never touches these. */
export async function saveUntrackedSnapshot(cwd: string, files: string[]): Promise<void> {
  await writeJson(untrackedSnapshotPath(cwd), files);
}

export async function loadUntrackedSnapshot(cwd: string): Promise<string[] | undefined> {
  return (await readJson<string[]>(untrackedSnapshotPath(cwd))) ?? undefined;
}
