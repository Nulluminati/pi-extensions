// Git metadata resolution for sandboxed worktree workers.
//
// A linked git worktree's `.git` is a file, not a directory: it holds a
// `gitdir: <absolute path>` line pointing at the main checkout's
// `.git/worktrees/<id>` directory. That gitdir's `commondir` file holds a
// relative path (usually `../..`) pointing at the main `.git` directory,
// which owns HEAD, config, refs, and objects. A sandboxed worker's `/workspace`
// mount only covers the worktree root, so both directories must be mounted at
// their absolute host paths for git's resolution chain to work in-guest.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface WorktreeGitDirs {
  /** Per-worktree gitdir parsed from the `.git` pointer file (absolute path). */
  gitdir: string;
  /** Main checkout `.git` directory resolved from the gitdir's `commondir` file (absolute path). */
  mainGitDir: string;
}

const GITDIR_PREFIX = "gitdir: ";

/**
 * Resolve the two git metadata directories a sandboxed worktree worker needs
 * mounted: the worktree gitdir and the main checkout `.git`. Returns undefined
 * when the checkout is not a linked worktree (`.git` missing or a real
 * directory) or when the metadata is unparseable — the caller then keeps its
 * base mount set. Never throws.
 */
export async function resolveWorktreeGitDirs(cwd: string): Promise<WorktreeGitDirs | undefined> {
  try {
    const gitdir = parseGitdirPointer(await readFile(path.join(cwd, ".git"), "utf8"));
    if (!gitdir) return undefined;
    const commondir = (await readFile(path.join(gitdir, "commondir"), "utf8")).trim();
    if (!commondir) return undefined;
    const mainGitDir = path.resolve(gitdir, commondir);
    const mainGitStat = await stat(mainGitDir);
    if (!mainGitStat.isDirectory()) return undefined;
    return { gitdir, mainGitDir };
  } catch {
    // Missing or unreadable metadata is not fatal: the worker keeps its base
    // mount set instead.
    return undefined;
  }
}

/** Parse the `gitdir:` pointer from a worktree `.git` file. Absolute targets only. */
function parseGitdirPointer(content: string): string | undefined {
  const line = content.split("\n").find((candidate) => candidate.startsWith(GITDIR_PREFIX));
  if (!line) return undefined;
  const target = line.slice(GITDIR_PREFIX.length).trim();
  if (!target || !path.isAbsolute(target)) return undefined;
  return path.normalize(target);
}
