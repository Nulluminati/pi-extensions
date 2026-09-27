import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeWorker } from "../../extensions/agents/src/runner.ts";
import { stderrLogPath } from "../../extensions/agents/src/store.ts";
import type { WorkerRecord } from "../../extensions/agents/src/types.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(readFile).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("worker stderr finalization", () => {
  it("reads a bounded stderr tail without loading the full capture", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worker-stderr-tail-"));
    roots.push(cwd);
    await mkdir(join(cwd, CONFIG_DIR_NAME, "workers", "streams"), { recursive: true });
    const stderrPath = stderrLogPath(cwd, "w-stderr");
    await writeFile(stderrPath, `${"noise\n".repeat(200_000)}last failure reason\n`);
    const record: WorkerRecord = {
      id: "w-stderr",
      name: "stderr",
      task: "fail",
      model: "test-model",
      cwd,
      status: "running",
      startedAt: Date.now(),
    };

    const finalized = await finalizeWorker({ cwd, record });

    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("last failure reason");
    expect(vi.mocked(readFile).mock.calls.some(([path]) => path === stderrPath)).toBe(false);
  });
});
