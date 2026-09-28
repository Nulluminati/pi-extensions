import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Git stores a linked worktree's index and objects in its parent's .git
 * directory. Expose that metadata to sandboxed Git commands read-only.
 */
export function worktreeGitCommonDir(cwd) {
  const pointer = join(cwd, ".git");
  if (!statSync(pointer, { throwIfNoEntry: false })?.isFile()) return undefined;
  const match = /^gitdir: (.+)\r?\n?$/i.exec(readFileSync(pointer, "utf8").trim());
  if (!match) throw new Error("Invalid linked worktree Git pointer");
  const gitdir = realpathSync(resolve(cwd, match[1]));
  const common = realpathSync(resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()));
  const location = relative(common, gitdir).split(sep);
  if (basename(common) !== ".git" || location.length !== 2 || location[0] !== "worktrees" || !location[1]) {
    throw new Error("Linked worktree Git pointer does not resolve under the common .git directory");
  }
  const back = readFileSync(join(gitdir, "gitdir"), "utf8").trim();
  const backPath = isAbsolute(back) ? back : resolve(gitdir, back);
  if (realpathSync(backPath) !== realpathSync(pointer)) {
    throw new Error("Linked worktree Git pointer does not match its back pointer");
  }
  return common;
}
