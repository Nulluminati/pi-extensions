import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanGitEnv, excludeFromGit, runGit } from "../../lib/git.ts";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: cleanGitEnv() });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "# base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-qm", "init"]);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runGit", () => {
  it("tags the error when the git binary is missing from PATH", async () => {
    const empty = await tempDir("git-missing-path-");
    vi.stubEnv("PATH", empty);
    const dir = await tempDir("git-anywhere-");

    await expect(runGit(dir, ["status"])).rejects.toMatchObject({
      code: "GIT_BINARY_MISSING",
      message: expect.stringMatching(/git not found on PATH/),
    });
  });

  it("keeps git's own failure for a non-repository directory", async () => {
    const dir = await tempDir("git-norepo-");

    const error = (await runGit(dir, ["status"]).catch((e) => e)) as NodeJS.ErrnoException;

    expect(error).toBeInstanceOf(Error);
    expect(error.code).not.toBe("GIT_BINARY_MISSING");
    expect(error.message).not.toMatch(/not found on PATH/);
  });
});

describe("excludeFromGit", () => {
  it("appends the pattern to the repository's local exclude file", async () => {
    const repo = await tempDir("git-exclude-");
    await initRepo(repo);

    expect(await excludeFromGit(repo, ".pi/messenger/")).toBe(true);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".pi/messenger/");
  });

  it("is idempotent", async () => {
    const repo = await tempDir("git-exclude-");
    await initRepo(repo);

    expect(await excludeFromGit(repo, ".pi/missions/")).toBe(true);
    expect(await excludeFromGit(repo, ".pi/missions/")).toBe(false);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === ".pi/missions/")).toHaveLength(1);
  });

  it("keeps excluded state out of git status", async () => {
    const repo = await tempDir("git-exclude-");
    await initRepo(repo);
    await excludeFromGit(repo, ".pi/messenger/");
    await mkdir(join(repo, ".pi", "messenger"), { recursive: true });
    await writeFile(join(repo, ".pi", "messenger", "state.json"), "{}\n");

    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("writes to the shared exclude file from a linked worktree", async () => {
    const repo = await tempDir("git-exclude-");
    await initRepo(repo);
    const linked = join(repo, "..", `git-exclude-linked-${Date.now()}`);
    tempDirs.push(linked);
    await git(repo, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);

    expect(await excludeFromGit(linked, ".pi/workers/")).toBe(true);

    // `.git` is a file in a linked worktree; the entry lands in the main repo.
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".pi/workers/");
  });

  it("is a no-op outside a repository", async () => {
    const dir = await tempDir("git-exclude-plain-");
    await expect(excludeFromGit(dir, ".pi/messenger/")).resolves.toBe(false);
  });
});
