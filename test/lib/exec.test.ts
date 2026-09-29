import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execPlatformHint, runExec } from "../../lib/exec.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

describe("execPlatformHint", () => {
  it("is empty on linux", () => {
    stubPlatform("linux");
    expect(execPlatformHint()).toBe("");
  });

  it("explains the macOS shell when running on darwin", () => {
    stubPlatform("darwin");
    expect(execPlatformHint()).toMatch(/darwin/);
    expect(execPlatformHint()).toMatch(/POSIX/);
  });
});

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runExec", () => {
  it("captures stdout and stderr from a successful command", async () => {
    const out = await runExec("printf stdout-text; printf stderr-text >&2", {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(out.ok).toBe(true);
    expect(out.stdout).toBe("stdout-text");
    expect(out.stderr).toBe("stderr-text");
    expect(out.error).toBeUndefined();
    expect(typeof out.durationMs).toBe("number");
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs the command in the given directory", async () => {
    const dir = await tempDir("exec-cwd-");
    const out = await runExec('basename "$PWD"', { cwd: dir, timeoutMs: 10_000 });

    expect(out.ok).toBe(true);
    expect(out.stdout.trim()).toBe(dir.split("/").pop());
  });

  it("resolves with ok: false and partial output on a non-zero exit", async () => {
    const out = await runExec("printf partial-out; printf partial-err >&2; exit 3", {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(out.ok).toBe(false);
    expect(out.stdout).toBe("partial-out");
    expect(out.stderr).toBe("partial-err");
    expect(out.error).toContain("Command failed");
  });

  it("kills the command at the timeout and resolves with a failure", async () => {
    const out = await runExec("sleep 30", { cwd: process.cwd(), timeoutMs: 200 });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("Command failed");
    // The kill fires at the timeout, not at the child's natural end.
    expect(out.durationMs).toBeLessThan(5_000);
  });

  it("fails with truncated output when maxBuffer is exceeded", async () => {
    const out = await runExec("printf abcdefghij", {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxBuffer: 4,
    });

    expect(out.ok).toBe(false);
    expect(out.stdout).toBe("abcd");
    expect(out.error).toContain("maxBuffer");
  });

  it("surfaces a missing-cwd failure instead of throwing", async () => {
    const out = await runExec("echo hi", { cwd: "/definitely/not/a/dir", timeoutMs: 10_000 });

    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
