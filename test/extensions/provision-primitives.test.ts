import { existsSync, statSync } from "node:fs";
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  carryPaths,
  copyTreeShared,
  pruneProvisionCache,
} from "../../extensions/agents/src/provision/primitives.ts";

// --- Fixtures ---

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Every tmpdir created by the current test; removed in afterEach. */
const created: string[] = [];

async function fixtureDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pi-provision-${label}-`));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = created.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// --- carryPaths ---

describe("carryPaths", () => {
  it("carries plain files preserving project-relative layout", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await mkdir(join(sourceRoot, "config/deep"), { recursive: true });
    await writeFile(join(sourceRoot, "app.config.json"), "{}");
    await writeFile(join(sourceRoot, "config/deep/settings.toml"), "a = 1");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["app.config.json", "config/deep/settings.toml"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual(["app.config.json", "config/deep/settings.toml"]);
    expect(result.skipped).toEqual([]);
    expect(await readFile(join(worktree, "app.config.json"), "utf8")).toBe("{}");
    expect(await readFile(join(worktree, "config/deep/settings.toml"), "utf8")).toBe("a = 1");
  });

  it("carries a directory tree recursively", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await mkdir(join(sourceRoot, ".cache/http"), { recursive: true });
    await writeFile(join(sourceRoot, ".cache/http/a"), "one");
    await writeFile(join(sourceRoot, ".cache/b"), "two");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: [".cache"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual([".cache"]);
    expect(await readFile(join(worktree, ".cache/http/a"), "utf8")).toBe("one");
    expect(await readFile(join(worktree, ".cache/b"), "utf8")).toBe("two");
  });

  it.each([
    [".env", ".env exact"],
    [".env.local", ".env.* glob"],
    ["server.pem", "*.pem glob"],
    ["private.key", "*.key glob"],
    ["id_rsa", "id_rsa exact"],
    ["id_rsa.pub", "id_rsa.* glob"],
    ["id_ed25519", "id_ed25519 exact"],
    ["id_ed25519.pub", "id_ed25519.* glob"],
    ["aws-credentials.txt", "*credentials* substring"],
    ["credentials.json", "*credentials* prefix"],
  ])("denies secret-shaped basename %s (%s)", async (name) => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await writeFile(join(sourceRoot, name), "secret-content");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: [name],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual([]);
    expect(result.skipped).toEqual([
      {
        path: name,
        reason: "secret-shaped; set carryUnsafe in .pi/provision.local.json",
      },
    ]);
    await expect(stat(join(worktree, name))).rejects.toThrow();
  });

  it.each([
    ["env.example", "does not start with .env"],
    [".envrc", "needs a dot after env"],
    ["pem.txt", "suffix is not the extension"],
    ["ssh-keys.md", "key substring is not the extension"],
  ])("carries non-secret basename %s (%s)", async (name) => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await writeFile(join(sourceRoot, name), "safe");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: [name],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual([name]);
    expect(result.skipped).toEqual([]);
  });

  it("matches secret patterns against the basename, not the dirname", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await mkdir(join(sourceRoot, "credentials"), { recursive: true });
    await writeFile(join(sourceRoot, "credentials/README.md"), "docs");
    await mkdir(join(sourceRoot, "config"), { recursive: true });
    await writeFile(join(sourceRoot, "config/.env"), "SECRET=1");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["credentials/README.md", "config/.env"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual(["credentials/README.md"]);
    expect(result.skipped).toEqual([
      {
        path: "config/.env",
        reason: "secret-shaped; set carryUnsafe in .pi/provision.local.json",
      },
    ]);
  });

  it("carries secret-shaped paths when allowUnsafe is set", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await writeFile(join(sourceRoot, ".env"), "TOKEN=1");
    await writeFile(join(sourceRoot, "server.pem"), "key");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: [".env", "server.pem"],
      allowUnsafe: true,
    });

    expect(result.carried).toEqual([".env", "server.pem"]);
    expect(result.skipped).toEqual([]);
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("TOKEN=1");
    expect(await readFile(join(worktree, "server.pem"), "utf8")).toBe("key");
  });

  it("skips a symlink whose target escapes sourceRoot and leaves the target intact", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    const outside = await fixtureDir("outside");
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(join(outside, "secret.txt"), join(sourceRoot, "link.txt"));

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["link.txt"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual([]);
    expect(result.skipped).toEqual([{ path: "link.txt", reason: "symlink escapes project root" }]);
    await expect(stat(join(worktree, "link.txt"))).rejects.toThrow();
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("s");
  });

  it("carries an inside-root symlink as copied content, not as a link", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    await writeFile(join(sourceRoot, "real.txt"), "shared");
    await symlink("real.txt", join(sourceRoot, "alias.txt"));

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["alias.txt"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual(["alias.txt"]);
    const copied = await lstat(join(worktree, "alias.txt"));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    expect(await readFile(join(worktree, "alias.txt"), "utf8")).toBe("shared");
  });

  it("skips missing source paths as not found", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["absent.env", "gone.txt"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "absent.env", reason: "not found" },
      { path: "gone.txt", reason: "not found" },
    ]);
  });

  it("sorts each path into exactly one bucket in a single call", async () => {
    const sourceRoot = await fixtureDir("src");
    const worktree = await fixtureDir("wt");
    const outside = await fixtureDir("outside");
    await writeFile(join(outside, "target.txt"), "t");
    await symlink(join(outside, "target.txt"), join(sourceRoot, "escape.txt"));
    await writeFile(join(sourceRoot, ".env"), "SECRET=1");
    await writeFile(join(sourceRoot, "keep.txt"), "k");

    const result = await carryPaths({
      worktree,
      sourceRoot,
      paths: ["keep.txt", ".env", "escape.txt", "missing.txt"],
      allowUnsafe: false,
    });

    expect(result.carried).toEqual(["keep.txt"]);
    expect(result.skipped).toEqual([
      {
        path: ".env",
        reason: "secret-shaped; set carryUnsafe in .pi/provision.local.json",
      },
      { path: "escape.txt", reason: "symlink escapes project root" },
      { path: "missing.txt", reason: "not found" },
    ]);
    expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("k");
  });
});

// --- copyTreeShared ---

describe("copyTreeShared", () => {
  it("copies a small tree with equal content using a shared-safe mode", async () => {
    const src = await fixtureDir("src");
    const dst = await fixtureDir("dst");
    await mkdir(join(src, "nested/deep"), { recursive: true });
    await writeFile(join(src, "a.txt"), "alpha");
    await writeFile(join(src, "nested/deep/b.txt"), "beta");

    const result = await copyTreeShared(src, dst);

    expect(["reflink", "clonefile", "hardlink", "copy"]).toContain(result.mode);
    if (process.platform === "linux") {
      // This host: reflink on btrfs/xfs/zfs, hardlink elsewhere.
      expect(["reflink", "hardlink"]).toContain(result.mode);
    }
    expect(await readFile(join(dst, "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(dst, "nested/deep/b.txt"), "utf8")).toBe("beta");
  });

  it("throws a descriptive error naming the path when src is missing", async () => {
    const src = await fixtureDir("src");
    const dst = await fixtureDir("dst");
    const missing = join(src, "nope");

    await expect(copyTreeShared(missing, dst)).rejects.toThrow(missing);
  });

  it("breaks writable spots: dst copies are fresh and empty, writes do not travel", async () => {
    const src = await fixtureDir("src");
    const dst = await fixtureDir("dst");
    await mkdir(join(src, ".vite"), { recursive: true });
    await mkdir(join(src, "pkg"), { recursive: true });
    await writeFile(join(src, ".vite/x"), "cached");
    await writeFile(join(src, ".package-lock.json"), '{"lock":1}');
    await writeFile(join(src, "pkg/index.js"), "console.log(1)");

    const result = await copyTreeShared(src, dst);

    expect(result.mode).toBeDefined();
    expect(await readdir(join(dst, ".vite"))).toEqual([]);
    expect(await readFile(join(dst, ".package-lock.json"), "utf8")).toBe("");

    // Broken spots no longer share inodes with the source tree.
    expect(statSync(join(dst, ".vite")).ino).not.toBe(statSync(join(src, ".vite")).ino);
    expect(statSync(join(dst, ".package-lock.json")).ino).not.toBe(
      statSync(join(src, ".package-lock.json")).ino,
    );

    // A write into the worktree copy must not appear in the parent tree.
    await writeFile(join(dst, ".vite/newfile"), "n");
    await expect(stat(join(src, ".vite/newfile"))).rejects.toThrow();

    // Ordinary content is still copied faithfully.
    expect(await readFile(join(dst, "pkg/index.js"), "utf8")).toBe("console.log(1)");
  });
});

// --- pruneProvisionCache ---

describe("pruneProvisionCache", () => {
  it("no-ops when the cache dir is missing", async () => {
    const missing = join(tmpdir(), `pi-provision-missing-${Date.now()}`);

    const result = await pruneProvisionCache(missing);

    expect(result).toEqual({ removed: [], freedBytes: 0 });
  });

  it("deletes oldest-first until under the byte bound", async () => {
    const cacheDir = await fixtureDir("cache");
    const old = join(cacheDir, "old.tar");
    const mid = join(cacheDir, "mid.tar");
    const fresh = join(cacheDir, "fresh.tar");
    await writeFile(old, "x".repeat(100));
    await writeFile(mid, "x".repeat(200));
    await writeFile(fresh, "x".repeat(300));
    const now = Date.now();
    await utimes(old, new Date(now - 3 * HOUR_MS), new Date(now - 3 * HOUR_MS));
    await utimes(mid, new Date(now - 2 * HOUR_MS), new Date(now - 2 * HOUR_MS));
    await utimes(fresh, new Date(now - 1 * HOUR_MS), new Date(now - 1 * HOUR_MS));

    const result = await pruneProvisionCache(cacheDir, { maxBytes: 350 });

    expect(result.removed).toEqual([old, mid]);
    expect(result.freedBytes).toBe(300);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(mid)).rejects.toThrow();
    expect((await stat(fresh)).size).toBe(300);
  });

  it("deletes entries older than an explicit maxAgeMs", async () => {
    const cacheDir = await fixtureDir("cache");
    const stale = join(cacheDir, "stale");
    const fresh = join(cacheDir, "fresh");
    await writeFile(stale, "s".repeat(10));
    await writeFile(fresh, "f".repeat(10));
    const now = Date.now();
    await utimes(stale, new Date(now - 5 * DAY_MS), new Date(now - 5 * DAY_MS));
    await utimes(fresh, new Date(now - 1 * HOUR_MS), new Date(now - 1 * HOUR_MS));

    const result = await pruneProvisionCache(cacheDir, { maxAgeMs: 2 * DAY_MS });

    expect(result.removed).toEqual([stale]);
    expect(result.freedBytes).toBe(10);
    expect(existsSync(fresh)).toBe(true);
  });

  it("applies the default bounds: 2 GiB bytes and 14 days age", async () => {
    const cacheDir = await fixtureDir("cache");
    const stale = join(cacheDir, "stale");
    const recent = join(cacheDir, "recent");
    await writeFile(stale, "s");
    await writeFile(recent, "r");
    const now = Date.now();
    await utimes(stale, new Date(now - 15 * DAY_MS), new Date(now - 15 * DAY_MS));
    await utimes(recent, new Date(now - 13 * DAY_MS), new Date(now - 13 * DAY_MS));

    const result = await pruneProvisionCache(cacheDir);

    expect(result.removed).toEqual([stale]);
    expect(existsSync(recent)).toBe(true);
  });

  it("removes an aged directory entry recursively", async () => {
    const cacheDir = await fixtureDir("cache");
    const sub = join(cacheDir, "subdir");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "inner"), "z".repeat(10));
    const now = Date.now();
    await utimes(sub, new Date(now - 20 * DAY_MS), new Date(now - 20 * DAY_MS));

    const result = await pruneProvisionCache(cacheDir, { maxAgeMs: DAY_MS });

    expect(result.removed).toEqual([sub]);
    expect(existsSync(sub)).toBe(false);
  });

  it("never follows symlinks out of the cache dir", async () => {
    const cacheDir = await fixtureDir("cache");
    const outside = await fixtureDir("outside");
    const nested = join(outside, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "inner.txt"), "precious");
    await writeFile(join(outside, "flat.txt"), "also-precious");
    const escapeFile = join(cacheDir, "escape-file");
    const escapeDir = join(cacheDir, "escape-dir");
    await symlink(join(outside, "flat.txt"), escapeFile);
    await symlink(nested, escapeDir);
    const now = Date.now();
    // lutimes stamps the link itself (utimes would follow the link and stamp
    // the target), matching the lstat view the implementation prunes by.
    await lutimes(escapeFile, new Date(now - 2 * HOUR_MS), new Date(now - 2 * HOUR_MS));
    await lutimes(escapeDir, new Date(now - 1 * HOUR_MS), new Date(now - 1 * HOUR_MS));

    const result = await pruneProvisionCache(cacheDir, { maxBytes: 1 });

    // The links themselves are inside cacheDir and are removed (not followed).
    expect(result.removed).toEqual([escapeFile, escapeDir]);
    // Targets outside cacheDir survive untouched.
    expect(await readFile(join(outside, "flat.txt"), "utf8")).toBe("also-precious");
    expect(await readFile(join(nested, "inner.txt"), "utf8")).toBe("precious");
    expect(existsSync(nested)).toBe(true);
  });
});
