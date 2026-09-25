import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeGitCommonDir } from "../../extensions/worker-sandbox/src/git-metadata.mjs";

describe("worker worktree Git metadata", () => {
  it("grants only the common Git directory for an authentic linked worktree", () => {
    const fixture = mkdtempSync(join(tmpdir(), "worker-git-metadata-"));
    const parent = join(fixture, "repo");
    const worker = join(fixture, "worker");
    try {
      mkdirSync(parent);
      git(parent, "init", "-q");
      git(
        parent,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      );
      git(parent, "worktree", "add", "-q", "--detach", worker);
      expect(worktreeGitCommonDir(worker)).toBe(resolve(parent, ".git"));
      expect(worktreeGitCommonDir(parent)).toBeUndefined();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses an unrelated Git directory even when the worktree pointer exists", () => {
    const fixture = mkdtempSync(join(tmpdir(), "worker-git-metadata-"));
    const worker = join(fixture, "worker");
    const fake = join(fixture, "private", ".git", "worktrees", "worker");
    try {
      mkdirSync(worker);
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(worker, ".git"), `gitdir: ${fake}\n`);
      writeFileSync(join(fake, "commondir"), "../..\n");
      writeFileSync(join(fixture, "other"), "not the worker pointer\n");
      writeFileSync(join(fake, "gitdir"), join(fixture, "other"));
      expect(() => worktreeGitCommonDir(worker)).toThrow(/pointer/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}
