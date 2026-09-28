import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";

describe("json-atomic", () => {
  let dir: string;

  const tmpLeftovers = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "json-atomic-"));
  });

  afterEach(async () => {
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
});
