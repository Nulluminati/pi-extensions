import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

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
    expect(out.error).toContain("timed out after 200 ms");
    // The kill fires at the timeout, not at the child's natural end.
    expect(out.durationMs).toBeLessThan(5_000);
  });

  it("fails at the timeout when the shell ignores SIGTERM", async () => {
    const out = await runExec("printf before; trap '' TERM; sleep 30", {
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(out.ok).toBe(false);
    expect(out.stdout).toBe("before");
    expect(out.error).toContain("timed out after 200 ms");
    expect(out.durationMs).toBeLessThan(5_000);
  });

  it("fails at the timeout when the child ignores SIGTERM and exits 0 later", async () => {
    const out = await runExec(
      `node -e 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'`,
      { cwd: process.cwd(), timeoutMs: 200 },
    );

    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out after 200 ms");
    expect(out.durationMs).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === "win32")(
    "kills descendants that ignore SIGTERM at the timeout",
    async () => {
      const out = await runExec("trap '' TERM; sleep 30 & echo $!; wait", {
        cwd: process.cwd(),
        timeoutMs: 200,
      });

      expect(out.ok).toBe(false);
      expect(out.error).toContain("timed out after 200 ms");
      const descendantPid = Number(out.stdout.trim());
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      // The killed descendant is reparented and reaped asynchronously.
      const gone = await waitUntil(() => !isAlive(descendantPid), 2_000);
      expect(gone).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a SIGTERM-ignoring descendant after the shell exits on SIGTERM",
    async () => {
      const dir = await tempDir("exec-descendant-");
      const pidFile = join(dir, "descendant.pid");
      // The shell dies on SIGTERM, so "close" fires before the SIGKILL is
      // due. The descendant does not hold the pipes, so only the group
      // SIGKILL can stop it.
      const out = await runExec(
        `( trap "" TERM; sleep 60 & echo $! > "${pidFile}"; wait ) >/dev/null 2>&1 & sleep 30`,
        { cwd: dir, timeoutMs: 300 },
      );

      expect(out.ok).toBe(false);
      expect(out.error).toContain("timed out after 300 ms");
      const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      const gone = await waitUntil(() => !isAlive(descendantPid), 3_000);
      expect(gone).toBe(true);
    },
  );

  it("fails when the command exits 0 on SIGTERM after the timeout", async () => {
    const out = await runExec("trap 'exit 0' TERM; sleep 30 & wait", {
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out after 200 ms");
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

  it("surfaces a command that spawn rejects synchronously instead of throwing", async () => {
    const out = await runExec("echo a\0b", { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("null bytes");
  });

  it("reports a buffer overflow even when the kill finishes after the deadline", async () => {
    // The overflow at ~100 ms sends SIGTERM, which the shell ignores; the
    // deadline at 300 ms passes before the SIGKILL at ~1.1 s.
    const out = await runExec("trap '' TERM; sleep 0.1; printf abcdefghij; sleep 30", {
      cwd: process.cwd(),
      timeoutMs: 300,
      maxBuffer: 4,
    });

    expect(out.ok).toBe(false);
    expect(out.stdout).toBe("abcd");
    expect(out.error).toContain("stdout maxBuffer length exceeded");
  });
});
