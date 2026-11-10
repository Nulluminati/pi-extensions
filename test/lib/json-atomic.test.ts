import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic, writeTextAtomic } from "../../lib/json-atomic.ts";

// randomBytes is wrapped (not replaced) so collision tests can pin the temp
// suffix while every other test keeps real randomness.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { randomBytes: vi.fn(actual.randomBytes) };
});

import { randomBytes } from "node:crypto";

// Spied (calls through by default) so failure tests can wrap the staging
// file handle and inject a write, sync, or close error.
vi.mock("node:fs/promises", { spy: true });

const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

type HandleStep = "writeFile" | "sync" | "close";

/** Make the next `open` return a real handle whose `step` fails with
 *  ENOSPC. A failing `writeFile` writes partial bytes first, the way a
 *  full disk does. */
function failNextHandle(step: HandleStep): void {
  vi.mocked(fs.open).mockImplementationOnce((async (...args: Parameters<typeof fs.open>) => {
    const handle = await realFs.open(...args);
    const enospc = () =>
      Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return {
      writeFile: async (text: string, encoding: BufferEncoding) => {
        if (step !== "writeFile") return handle.writeFile(text, encoding);
        await handle.write("PARTIAL");
        throw enospc();
      },
      sync: async () => {
        if (step === "sync") throw enospc();
        return handle.sync();
      },
      close: async () => {
        await handle.close();
        if (step === "close") throw enospc();
      },
    };
  }) as unknown as typeof fs.open);
}

describe("json-atomic", () => {
  let dir: string;

  const tmpLeftovers = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "json-atomic-"));
  });

  afterEach(async () => {
    vi.mocked(randomBytes).mockRestore();
    vi.mocked(fs.open).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes pretty-printed JSON to the target path", async () => {
    const path = join(dir, "data.json");

    await writeJsonAtomic(path, { b: 2, a: 1 });

    expect(await readFile(path, "utf8")).toBe('{\n  "b": 2,\n  "a": 1\n}');
  });

  it("creates missing parent directories", async () => {
    const path = join(dir, "nested", "deeper", "data.json");

    await writeJsonAtomic(path, ["x"]);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(["x"]);
  });

  it("writes the file with the requested mode", async () => {
    const path = join(dir, "secret.json");

    await writeJsonAtomic(path, { token: "x" }, { mode: 0o600 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file and leaves no temp files behind", async () => {
    const path = join(dir, "data.json");

    await writeJsonAtomic(path, { n: 1 });
    await writeJsonAtomic(path, { n: 2 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 2 });
    expect(await tmpLeftovers()).toEqual([]);
  });

  it("lands one of two concurrent payloads with no temp leftovers", async () => {
    const path = join(dir, "data.json");

    await Promise.all([
      writeJsonAtomic(path, { writer: "a" }),
      writeJsonAtomic(path, { writer: "b" }),
    ]);

    // Last-writer-wins: the final content is exactly one of the payloads.
    const final = JSON.parse(await readFile(path, "utf8"));
    expect([{ writer: "a" }, { writer: "b" }]).toContainEqual(final);
    expect(await tmpLeftovers()).toEqual([]);
  });

  it("writeTextAtomic writes text verbatim to the target path", async () => {
    const path = join(dir, "inbox.jsonl");

    await writeTextAtomic(path, '{"id":"m1"}\n{"id":"m2"}\n');

    expect(await readFile(path, "utf8")).toBe('{"id":"m1"}\n{"id":"m2"}\n');
    expect(await tmpLeftovers()).toEqual([]);
  });

  it("writeTextAtomic writes the file with the requested mode", async () => {
    const path = join(dir, "secret.jsonl");

    await writeTextAtomic(path, "x\n", { mode: 0o600 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("writeTextAtomic removes the temp file and rethrows when the rename fails", async () => {
    // Renaming a file onto a directory fails, leaving the staged temp behind
    // unless the helper cleans it up.
    const path = join(dir, "blocker");
    await mkdir(path);

    await expect(writeTextAtomic(path, "x")).rejects.toThrow();
    expect(await tmpLeftovers()).toEqual([]);
  });

  it.each<HandleStep>(["writeFile", "sync", "close"])(
    "writeTextAtomic removes the temp file and rethrows when %s fails",
    async (step) => {
      const path = join(dir, "state.json");
      failNextHandle(step);

      await expect(writeTextAtomic(path, "x".repeat(100))).rejects.toThrow(/ENOSPC/);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it("reuses the existing file's mode on rewrites when no mode is passed", async () => {
    const path = join(dir, "secret.json");

    await writeJsonAtomic(path, { token: "x" }, { mode: 0o600 });
    await writeJsonAtomic(path, { token: "y" });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("an explicit mode still wins over the existing file's mode", async () => {
    const path = join(dir, "secret.jsonl");

    await writeTextAtomic(path, "one\n", { mode: 0o600 });
    await writeTextAtomic(path, "two\n", { mode: 0o644 });

    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("a mode change applies to new files only when omitted", async () => {
    const path = join(dir, "fresh.json");

    await writeJsonAtomic(path, { n: 1 });

    // Platform default for new files; the exact value is umask-dependent,
    // so only assert it was created (mode coverage lives above).
    expect((await stat(path)).mode & 0o777).toBeGreaterThan(0);
  });

  it("retries with a fresh temp name instead of truncating a colliding temp", async () => {
    const path = join(dir, "shared.json");
    const pinned = Buffer.from("deadbeefdeadbeef", "hex");
    const collidingTemp = `${path}.${process.pid}.${pinned.toString("hex")}.tmp`;
    // Another writer's in-flight temp at the name we are about to draw.
    await writeFile(collidingTemp, "other-writer-in-flight");
    let call = 0;
    vi.mocked(randomBytes).mockImplementation((size: number) => {
      call += 1;
      return call === 1 ? pinned : Buffer.alloc(size, 7);
    });

    await writeJsonAtomic(path, { writer: "me" });

    // Our write landed and the other writer's temp is untouched.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ writer: "me" });
    expect(await readFile(collidingTemp, "utf8")).toBe("other-writer-in-flight");
  });

  it("gives up with a clear error when temp names stay occupied", async () => {
    const path = join(dir, "shared.json");
    const pinned = Buffer.alloc(8, 9);
    const collidingTemp = `${path}.${process.pid}.${pinned.toString("hex")}.tmp`;
    await writeFile(collidingTemp, "other-writer-in-flight");
    vi.mocked(randomBytes).mockImplementation((size: number) => Buffer.alloc(size, 9));

    await expect(writeJsonAtomic(path, { writer: "me" })).rejects.toThrow(/temp file/i);

    // The other writer's temp survives; our target was never created.
    expect(await readFile(collidingTemp, "utf8")).toBe("other-writer-in-flight");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
