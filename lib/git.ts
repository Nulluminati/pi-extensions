/** Shared git helpers: child-process environment hygiene, exec, and local
 * exclude management. Tools that spawn child git processes must strip
 * inherited index/worktree variables — under lint-staged-style hooks,
 * GIT_INDEX_FILE points at a temporary index in the host repo and silently
 * corrupts git calls made from tests and tools. */

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

// --- Constants ---

const INHERITED_GIT_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

// --- Environment ---

export function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of INHERITED_GIT_KEYS) delete copy[key];
  return copy;
}

// --- Exec ---

export const gitExecFile = promisify(execFile);

/** Run a git command with a clean git environment and a bounded buffer. */
export async function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await gitExecFile("git", args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}

// --- Local excludes ---

/**
 * Append `pattern` to the repository's local exclude file (`.git/info/exclude`)
 * so project-local state never dirties `git status`, without touching the
 * tracked `.gitignore`. Idempotent, and a no-op outside a repository. The
 * exclude path is resolved through git so linked worktrees — where `.git` is a
 * file, not a directory — work correctly. Returns true when it appended.
 */
export async function excludeFromGit(cwd: string, pattern: string): Promise<boolean> {
  let reported: string;
  try {
    reported = (await runGit(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim();
  } catch {
    // Not a repository (or git is unavailable): there is nothing to exclude
    // from, and callers treat this as best-effort hygiene.
    return false;
  }
  const exclude = isAbsolute(reported) ? reported : resolve(cwd, reported);

  let current = "";
  try {
    current = await readFile(exclude, "utf8");
  } catch (error) {
    // The file may not exist yet; appendFile creates it. Its parent may be
    // missing too: a template-less git (Alpine guests) creates no .git/info
    // on init, so create the directory rather than assuming it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split("\n").includes(pattern)) return false;

  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(exclude, `${pattern}\n`, "utf8");
  return true;
}
