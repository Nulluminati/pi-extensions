/**
 * Git worktree helpers for worker isolation. Each isolated worker gets its
 * own branch (`workers/<workerId>`) and directory (`.pi/worktrees/<workerId>`)
 * created from HEAD, so parallel workers never collide on files. Worktrees
 * provide *isolation*, not security: workers still run with user privileges.
 */

import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit } from "../../../lib/git.ts";
import { isProjectStatePath, projectStateDir } from "../../../lib/paths.ts";
import { assertWorkerId } from "./ids.ts";
import type { WorkerRecord } from "./types.ts";

// --- Constants ---

/** Marker file in the worktree's private git dir holding its fork point. */
const BASE_COMMIT_FILE = "workers-base";
/** The project hook creates temporary paths with eight random characters. */
const PROVISION_SCRATCH = /^provision-tmp-[A-Za-z0-9]{8}$/;
/** Untracked paths per `git add` invocation, bounded for argv limits. */
const UNTRACKED_ADD_BATCH = 64;
/** Blocking paths named by the dirty-tree refusal before the rest collapse into a count. */
const MAX_NAMED_BLOCKERS = 5;

// --- Helpers ---

export function worktreesDir(cwd: string): string {
  return projectStateDir(cwd, "worktrees");
}

export function worktreePath(cwd: string, workerId: string): string {
  return join(worktreesDir(cwd), assertWorkerId(workerId));
}

export function worktreeBranch(workerId: string): string {
  return `workers/${assertWorkerId(workerId)}`;
}

// --- Operations ---

/** Refusal before any worker worktree or process exists. */
export class DirtyWorktreeError extends Error {}

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
 * The path a porcelain status line names (the `XY ` prefix is three
 * characters), without Git's C-style surrounding quotes. Git quotes paths
 * with spaces, so the strip is what makes names like `src notes.md` whole.
 * Inner escape sequences are shown as Git emits them.
 */
function statusLinePath(line: string): string {
  const path = line.slice(3);
  return path.startsWith('"') && path.endsWith('"') && path.length >= 2 ? path.slice(1, -1) : path;
}

/**
 * Untracked files under the config dir — messenger inboxes, mission records,
 * worker registries — are tooling state, not work. They never enter the
 * worktree (branched from HEAD) and never appear in the captured patch, so
 * counting them only self-blocks delegation in repos that do not gitignore
 * the config dir. Tracked modifications under it still refuse: a HEAD-based
 * worktree would be missing those committed-then-edited files.
 */
function blockingStatusLines(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      if (!line.startsWith("?? ")) return true;
      return !isProjectStatePath(statusLinePath(line));
    });
}

/** The bounded blocker list for the refusal: names, plus a count of the rest. */
function blockingPathSummary(lines: string[]): string {
  const named = lines.slice(0, MAX_NAMED_BLOCKERS).map(statusLinePath);
  const rest = lines.length - named.length;
  return rest > 0 ? `${named.join(", ")} (and ${rest} more)` : named.join(", ");
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
  const blocking = blockingStatusLines(status);
  if (blocking.length > 0) {
    throw new DirtyWorktreeError(
      `Refusing to create a worker worktree from a dirty tree. Blocking paths: ${blockingPathSummary(blocking)}. ` +
        "Commit or stash first so the worker's patch captures a clean baseline.",
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
 * The working tree the patch will be applied to at collect time, when it can
 * be located: a linked worktree's common git dir sits inside the parent
 * checkout. Bare repositories, ancient git, and unknown layouts return
 * undefined — capture then stores the patch unvalidated rather than refusing
 * valid work. Note that collect may run `git apply` from a subdirectory of
 * this tree when the session started there; validation from the root is
 * optimistic in that layout.
 */
async function parentWorktreePath(worktreePath: string): Promise<string | undefined> {
  let commonDir: string;
  try {
    commonDir = (
      await runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
  } catch {
    return undefined;
  }
  if (commonDir === "") return undefined;
  const parent = dirname(commonDir);
  const inside = await runGit(parent, ["rev-parse", "--is-inside-work-tree"]).then(
    (out) => out.trim() === "true",
    () => false,
  );
  return inside ? parent : undefined;
}

/**
 * Capture everything the worker changed (including new files and commits)
 * relative to the worktree's fork point as a patch.
 *
 * Staging is policy-driven instead of `add -A`: tracked changes stage
 * directly, and untracked files stage only where the project's Git ignore
 * policy permits them, minus extension runtime state under the config dir.
 * Artifact directories the project ignores (`.npm-cache`, `node_modules`,
 * build output) therefore never enter the patch. The diff is binary-safe so
 * legitimate binary changes stay applicable, and the patch is validated with
 * `git apply --check` against the parent working tree before being stored —
 * an inapplicable patch refuses at capture, while the worktree still exists,
 * instead of surfacing at collect.
 */
export async function captureWorktreePatch(worktreePath: string, outFile: string): Promise<void> {
  // A killed setup hook cannot run its EXIT trap. Remove its temporary
  // paths before Git stages worker changes, even if no session-start
  // exclude was installed in this repository.
  const stateRoot = projectStateDir(worktreePath, "");
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (PROVISION_SCRATCH.test(entry.name)) {
      await rm(join(stateRoot, entry.name), { recursive: true, force: true });
    }
  }

  // Tracked modifications and deletions stage regardless of ignore policy.
  await runGit(worktreePath, ["add", "-u"]);
  // Untracked files stage only where the project's ignore policy permits.
  // Runtime state under the config dir is tooling, never worker work.
  const others = await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = others.split("\0").filter((path) => path !== "" && !isProjectStatePath(path));
  for (let i = 0; i < untracked.length; i += UNTRACKED_ADD_BATCH) {
    await runGit(worktreePath, ["add", "--", ...untracked.slice(i, i + UNTRACKED_ADD_BATCH)]);
  }

  const base = await worktreeBaseCommit(worktreePath);
  const diff = await runGit(worktreePath, ["diff", "--binary", "--full-index", "--cached", base]);

  await mkdir(join(outFile, ".."), { recursive: true });
  // The patch is only stored once it is known to apply: a refused capture
  // leaves neither a broken patch for collect to trip over nor a validation
  // leftover behind.
  const staged = `${outFile}.tmp`;
  await writeFile(staged, diff, "utf8");
  const parent = await parentWorktreePath(worktreePath);
  if (parent !== undefined && diff.trim() !== "") {
    try {
      await runGit(parent, ["apply", "--check", resolve(staged)]);
    } catch (error) {
      await rm(staged, { force: true });
      throw new Error(
        `Refusing to store the worker patch: it does not apply to the parent tree at ${parent}. ` +
          `The worktree keeps the changes for recovery. Git said: ${(error as Error).message}`,
      );
    }
  }
  await rename(staged, outFile);
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

/** Outcome of a worktree discard attempt. */
export type WorktreeDiscard = "removed" | "absent" | "kept" | "failed";

/**
 * Remove a worker's worktree and branch when its captured work is durably
 * saved elsewhere (or no patch was ever captured — the failed/cancelled
 * case that otherwise rots forever). Returns "kept" without touching
 * anything when the record references a patch file that no longer exists:
 * the worktree would be the only remaining copy of the worker's changes.
 */
export async function discardWorktree(
  cwd: string,
  record: Pick<WorkerRecord, "id" | "worktree" | "patchPath">,
): Promise<WorktreeDiscard> {
  if (record.worktree === undefined) return "absent";
  if (record.patchPath !== undefined) {
    const patchMissing = await access(record.patchPath).then(
      () => false,
      () => true,
    );
    if (patchMissing) return "kept";
  }
  await removeWorktree(cwd, record.id);
  return existsSync(worktreePath(cwd, record.id)) ? "failed" : "removed";
}

/** Apply a worker patch file onto the main working tree. */
export async function applyPatch(cwd: string, patchPath: string): Promise<void> {
  await runGit(cwd, ["apply", patchPath]);
}
