import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecycledPid, parsePsLstart, processStartTime } from "../../lib/process-identity.ts";

const children: ReturnType<typeof spawn>[] = [];
const dirs: string[] = [];

function spawnSleeper(): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    child.on("spawn", () => resolve(child));
    child.on("error", reject);
  });
}

beforeEach(async () => {
  dirs.push(await mkdtemp(join(tmpdir(), "process-identity-")));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("processStartTime", () => {
  it("answers for a live process and matches /proc on linux", async () => {
    const self = await processStartTime(process.pid);
    expect(self).toBeDefined();
    expect(self!.length).toBeGreaterThan(0);
    if (process.platform === "linux") {
      const stat = await readFile("/proc/self/stat", "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Field 22 (starttime) sits at index 19 after pid(1) and comm(2).
      expect(self).toBe(afterComm[19]);
    }
  });

  it("answers for a spawned child and goes undefined once it exits", async () => {
    const child = await spawnSleeper();
    const stamp = await processStartTime(child.pid!);
    expect(stamp).toBeDefined();
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(processStartTime(child.pid!)).resolves.toBeUndefined();
  });

  it("returns undefined for a pid that cannot exist", async () => {
    await expect(processStartTime(999_999_999)).resolves.toBeUndefined();
  });
});

describe("isRecycledPid", () => {
  it("flags a live pid whose start time differs from the stamp", async () => {
    const child = await spawnSleeper();
    // Simulates a recycled pid: the record's stamp predates the current
    // occupant of the pid.
    await expect(isRecycledPid(child.pid!, "Mon Jan  2 03:04:05 2001")).resolves.toBe(true);
  });

  it("keeps a live pid whose start time matches the stamp", async () => {
    const child = await spawnSleeper();
    const stamp = await processStartTime(child.pid!);
    await expect(isRecycledPid(child.pid!, stamp)).resolves.toBe(false);
  });

  it("treats a stampless record as never recycled (legacy behavior)", async () => {
    const child = await spawnSleeper();
    await expect(isRecycledPid(child.pid!, undefined)).resolves.toBe(false);
  });

  it("treats an unreadable start time as not recycled (conservative)", async () => {
    // A dead pid reads no start time; liveness is the caller's first check,
    // but the conservative verdict must hold here too.
    await expect(isRecycledPid(999_999_999, "Mon Jan  2 03:04:05 2001")).resolves.toBe(false);
  });
});

describe("parsePsLstart", () => {
  it("normalizes BSD ps lstart output", () => {
    expect(parsePsLstart("Mon Jan  2 03:04:05 2023\n")).toBe("Mon Jan 2 03:04:05 2023");
  });

  it("returns undefined for empty or garbage output", () => {
    expect(parsePsLstart("")).toBeUndefined();
    expect(parsePsLstart("no such process")).toBeUndefined();
  });
});
