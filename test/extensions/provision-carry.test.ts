import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  carryIncludedPaths,
  readIncludePatterns,
} from "../../extensions/agents/src/provision/carry.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree include carry", () => {
  it("uses Git ignore syntax, including negations, without copying unlisted files", async () => {
    const { source, worktree } = project();
    mkdirSync(join(source, "cache"));
    writeFileSync(join(source, "cache", "good.txt"), "GOOD");
    writeFileSync(join(source, "cache", "excluded.txt"), "EXCLUDED");
    writeFileSync(join(source, "unlisted"), "UNLISTED");
    writeFileSync(join(source, ".worktreeinclude"), "cache/*\n!cache/excluded.txt\n");

    const result = await carryIncludedPaths(source, worktree);
    expect(result.carried).toEqual(["cache/good.txt"]);
    expect(readFileSync(join(worktree, "cache", "good.txt"), "utf8")).toBe("GOOD");
    expect(existsSync(join(worktree, "cache", "excluded.txt"))).toBe(false);
    expect(existsSync(join(worktree, "unlisted"))).toBe(false);
  });

  it("does not dereference nested symlinks outside the checkout", async () => {
    const { source, worktree } = project();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "private"), "SECRET");
    mkdirSync(join(source, "cache"));
    symlinkSync(join(outside, "private"), join(source, "cache", "link"));
    writeFileSync(join(source, "cache", "safe"), "SAFE");
    writeFileSync(join(source, ".worktreeinclude"), "cache/\n");

    const result = await carryIncludedPaths(source, worktree);
    expect(result.carried).toEqual(["cache/safe"]);
    expect(result.skipped).toContainEqual({
      path: "cache/link",
      reason: "symlink escapes project root",
    });
    expect(existsSync(join(worktree, "cache", "link"))).toBe(false);
  });

  it("rejects secret names anywhere in the carried path", async () => {
    const { source, worktree } = project();
    mkdirSync(join(source, "cache", ".ssh"), { recursive: true });
    writeFileSync(join(source, "cache", ".ssh", "config"), "SECRET");
    writeFileSync(join(source, "cache", ".env"), "SECRET");
    writeFileSync(join(source, "cache", "safe"), "SAFE");
    writeFileSync(join(source, ".worktreeinclude"), "cache/\n");

    const result = await carryIncludedPaths(source, worktree);
    expect(result.carried).toEqual(["cache/safe"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "cache/.env", reason: "secret-shaped" },
        { path: "cache/.ssh/config", reason: "secret-shaped" },
      ]),
    );
  });

  it("refuses include rules that leave the checkout", async () => {
    const { source, worktree } = project();
    writeFileSync(join(source, ".worktreeinclude"), "../private\n");
    await expect(readIncludePatterns(source)).rejects.toThrow(/invalid include path/);
    await expect(carryIncludedPaths(source, worktree)).rejects.toThrow(/invalid include path/);
  });

  it("does not write through a destination symlink", async () => {
    const { source, worktree } = project();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "safe"), "PARENT");
    mkdirSync(join(source, "cache"));
    writeFileSync(join(source, "cache", "safe"), "WORKER");
    symlinkSync(outside, join(worktree, "cache"));
    writeFileSync(join(source, ".worktreeinclude"), "cache/safe\n");

    await expect(carryIncludedPaths(source, worktree)).rejects.toThrow(
      /destination escapes worktree/,
    );
    expect(readFileSync(join(outside, "safe"), "utf8")).toBe("PARENT");
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "provision-carry-"));
  roots.push(root);
  return root;
}

function project(): { source: string; worktree: string } {
  const source = temporaryDirectory();
  const worktree = temporaryDirectory();
  execFileSync("git", ["init", "-q"], { cwd: source });
  return { source, worktree };
}
