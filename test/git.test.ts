import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { excludeFromGit } from "../lib/git.ts";

const execFileAsync = promisify(execFile);

let tmp: string | undefined;

afterEach(async () => {
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function initRepo(): Promise<string> {
  tmp = await mkdtemp(join(os.tmpdir(), "git-exclude-test-"));
  const cwd = tmp;
  await execFileAsync("git", ["init", "-q"], { cwd });
  return cwd;
}

describe("excludeFromGit", () => {
  it("creates .git/info when a template-less init left it missing", async () => {
    // Alpine guests ship git without templates: `git init` produces no
    // .git/info at all, and excludeFromGit used to die on appendFile ENOENT
    // (field probe: session_start hooks failing in-guest).
    const cwd = await initRepo();
    await rm(join(cwd, ".git", "info"), { recursive: true, force: true });

    expect(await excludeFromGit(cwd, ".pi/probe-state/")).toBe(true);
    const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".pi/probe-state/");
  });

  it("is idempotent: a second append of the same pattern returns false", async () => {
    const cwd = await initRepo();
    expect(await excludeFromGit(cwd, ".pi/missions/")).toBe(true);
    expect(await excludeFromGit(cwd, ".pi/missions/")).toBe(false);
    const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === ".pi/missions/")).toHaveLength(1);
  });

  it("is a no-op outside a repository", async () => {
    tmp = await mkdtemp(join(os.tmpdir(), "git-exclude-nonrepo-"));
    expect(await excludeFromGit(tmp, ".pi/state/")).toBe(false);
  });
});
