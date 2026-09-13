/**
 * Git worktree helpers for worker isolation. Each isolated worker gets its
 * own branch (`agents/<workerId>`) and directory (`.pi/worktrees/<workerId>`)
 * created from HEAD, so parallel workers never collide on files. Worktrees
 * provide *isolation*, not security: workers still run with user privileges.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../../../lib/git.ts";

// --- Constants ---

/** Marker file in the worktree's private git dir holding its fork point. */
const BASE_COMMIT_FILE = "agents-base";

// --- Helpers ---

export function worktreesDir(cwd: string): string {
  return join(cwd, ".pi", "worktrees");
}

export function worktreePath(cwd: string, workerId: string): string {
  return join(worktreesDir(cwd), workerId);
}

export function worktreeBranch(workerId: string): string {
  return `agents/${workerId}`;
}

// --- Operations ---

/** True when the directory is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Create an isolated worktree from HEAD. Rejects when the tree is dirty —
 * workers must branch from committed state, otherwise the captured patch
 * would silently miss uncommitted work.
 */
export async function createWorktree(
  cwd: string,
  workerId: string,
): Promise<{ path: string; branch: string }> {
  const status = await runGit(cwd, ["status", "--porcelain"]);
  if (status.trim() !== "") {
    throw new Error(
      "Refusing to create a worker worktree from a dirty tree. Commit or stash first so the worker's patch captures a clean baseline.",
    );
  }
  const branch = worktreeBranch(workerId);
  const path = worktreePath(cwd, workerId);
  await mkdir(worktreesDir(cwd), { recursive: true });
  await runGit(cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);
  // Record the fork point inside the worktree's private git dir so patch
  // capture can diff against it even after the worker commits.
  const base = (await runGit(path, ["rev-parse", "HEAD"])).trim();
  const gitDir = (await runGit(path, ["rev-parse", "--absolute-git-dir"])).trim();
  await writeFile(join(gitDir, BASE_COMMIT_FILE), `${base}\n`, "utf8");
  return { path, branch };
}

/**
 * Capture everything the worker changed (including new files and commits)
 * relative to the worktree's fork point as a patch.
 */
export async function captureWorktreePatch(worktreePath: string, outFile: string): Promise<void> {
  await runGit(worktreePath, ["add", "-A"]);
  const base = await worktreeBaseCommit(worktreePath);
  const diff = await runGit(worktreePath, ["diff", "--cached", base]);
  await mkdir(join(outFile, ".."), { recursive: true });
  await writeFile(outFile, diff, "utf8");
}

/**
 * The commit the worktree branched from, recorded by createWorktree. Worktrees
 * created before the marker existed fall back to HEAD, which only captures
 * uncommitted changes.
 */
async function worktreeBaseCommit(worktreePath: string): Promise<string> {
  try {
    const gitDir = (await runGit(worktreePath, ["rev-parse", "--absolute-git-dir"])).trim();
    const base = (await readFile(join(gitDir, BASE_COMMIT_FILE), "utf8")).trim();
    if (base !== "") return base;
  } catch {
    // No marker (or unreadable git dir): fall back to HEAD.
  }
  return "HEAD";
}

/** Remove a worktree and its branch after the patch has been captured. */
export async function removeWorktree(cwd: string, workerId: string): Promise<void> {
  const path = worktreePath(cwd, workerId);
  await runGit(cwd, ["worktree", "remove", "--force", path]).catch(() => {});
  await runGit(cwd, ["branch", "-D", worktreeBranch(workerId)]).catch(() => {});
}

/** Apply a worker patch file onto the main working tree. */
export async function applyPatch(cwd: string, patchPath: string): Promise<void> {
  await runGit(cwd, ["apply", patchPath]);
}
