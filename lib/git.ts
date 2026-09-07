/** Shared git helper: run git with a clean environment. Tools that spawn
 * child git processes must strip inherited index/worktree variables — under
 * lint-staged-style hooks, GIT_INDEX_FILE points at a temporary index in the
 * host repo and silently corrupts git calls made from tests and tools. */

import { execFile } from "node:child_process";
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
