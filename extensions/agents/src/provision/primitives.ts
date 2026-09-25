/**
 * Worktree provisioning primitives: carry, share, and cache retention.
 *
 * The mechanism half of the design — extension code here carries zero
 * ecosystem knowledge. Policy (which paths to carry, how to share) lives in
 * the per-repo config; see ./types.ts for the vocabulary and sibling modules.
 *
 * - `carryPaths`          — copy declared gitignored paths into the worktree,
 *                           refusing secret-shaped basenames and symlinks
 *                           that escape the project root.
 * - `copyTreeShared`      — populate a worktree directory from the parent
 *                           checkout with the cheapest safe copy (reflink /
 *                           clonefile / hardlink), then break tool-writable
 *                           spots so writes cannot travel back through a
 *                           shared inode.
 * - `pruneProvisionCache` — retention bound for the persistent provision
 *                           cache (cacheDir("provision")).
 *
 * Design and review record: docs/issues/worktree-isolation-lacks-node-modules.md
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CarryOptions, CarryResult, CopyMode } from "./types.ts";

// --- Constants ---

/** Default deny-globs for secret-shaped carry targets (matched on basename). */
const SECRET_BASENAME_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "*credentials*",
];

const SECRET_REASON = "secret-shaped; set carryUnsafe in .pi/provision.local.json";
const SYMLINK_ESCAPE_REASON = "symlink escapes project root";
const NOT_FOUND_REASON = "not found";

/** Entries recreated fresh (never hardlink/reflink-shared) after a shared copy. */
const WRITABLE_SPOT_NAMES = new Set([".package-lock.json", ".vite", ".cache", ".npm"]);

/** Retention defaults for the persistent provision cache (review point N3). */
const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// --- Types ---

interface CpAttempt {
  cmd: string;
  args: string[];
  mode: CopyMode;
}

interface CpRun {
  ok: boolean;
  stderr: string;
}

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

interface WritableSpot {
  path: string;
  isDirectory: boolean;
}

// --- Helpers ---

/**
 * Glob matching for `*` only — enough for the deny-glob list above, with no
 * new dependencies. Everything else is a literal.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

const SECRET_BASENAME_REGEXES = SECRET_BASENAME_GLOBS.map(globToRegExp);

function isSecretShaped(name: string): boolean {
  return SECRET_BASENAME_REGEXES.some((regex) => regex.test(name));
}

/** Path containment after realpath: the root itself counts as inside. */
function isInsideRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + sep);
}

function execCp(cmd: string, args: string[]): Promise<CpRun> {
  return new Promise((resolveRun) => {
    // Arg arrays only: paths are never shell-interpolated.
    execFile(cmd, args, { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        resolveRun({ ok: true, stderr: "" });
        return;
      }
      resolveRun({ ok: false, stderr: stderr || error.message });
    });
  });
}

/**
 * After a shared (reflink / clonefile / hardlink) copy, delete and recreate
 * every writable spot under dst as a fresh empty file or directory. A write
 * through a shared inode would reach the parent checkout; a fresh entry
 * cannot.
 */
async function breakWritableSpots(root: string): Promise<void> {
  const found: WritableSpot[] = [];
  const stack: string[] = [root];
  for (;;) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable mid-walk; nothing to break here
    }
    for (const dirent of dirents) {
      const entryPath = join(dir, dirent.name);
      if (WRITABLE_SPOT_NAMES.has(dirent.name)) {
        found.push({ path: entryPath, isDirectory: dirent.isDirectory() });
      } else if (dirent.isDirectory()) {
        // withFileTypes: symlinks are never isDirectory(), so the walk never
        // leaves dst through a symlinked directory.
        stack.push(entryPath);
      }
    }
  }

  for (const spot of found) {
    await rm(spot.path, { recursive: true, force: true });
    if (spot.isDirectory) {
      await mkdir(spot.path);
    } else {
      await writeFile(spot.path, "");
    }
  }
}

async function removeCacheEntry(path: string): Promise<void> {
  // Recursive mode removes directories; for a symlink it unlinks the link
  // itself, never the target — so pruning cannot follow links out of cacheDir.
  await rm(path, { recursive: true, force: true });
}

// --- Carry ---

/**
 * Copy declared gitignored paths from sourceRoot into worktree, preserving
 * project-relative layout. Carry lists are aspirational: missing sources are
 * skipped, not errors. Secret-shaped basenames are denied unless the local
 * override opted in; symlinks are dereferenced only when their target stays
 * inside the project root.
 */
export async function carryPaths(opts: CarryOptions): Promise<CarryResult> {
  const carried: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const realRoot = await realpath(opts.sourceRoot).catch(() => resolve(opts.sourceRoot));

  for (const relPath of opts.paths) {
    if (!opts.allowUnsafe && isSecretShaped(basename(relPath))) {
      skipped.push({ path: relPath, reason: SECRET_REASON });
      continue;
    }

    const src = join(opts.sourceRoot, relPath);
    const dst = join(opts.worktree, relPath);

    const sourceStat = await lstat(src).catch(() => null);
    if (!sourceStat) {
      skipped.push({ path: relPath, reason: NOT_FOUND_REASON });
      continue;
    }

    const realSrc = await realpath(src).catch(() => null);
    if (!realSrc) {
      // Broken symlink (lstat sees it, nothing is behind it).
      skipped.push({ path: relPath, reason: NOT_FOUND_REASON });
      continue;
    }
    if (!isInsideRoot(realSrc, realRoot)) {
      skipped.push({ path: relPath, reason: SYMLINK_ESCAPE_REASON });
      continue;
    }

    await mkdir(dirname(dst), { recursive: true });
    // dereference: copy link targets as content (guard above bounded them).
    await cp(src, dst, { recursive: true, dereference: true });
    carried.push(relPath);
  }

  return { carried, skipped };
}

// --- Share ---

/**
 * Populate dst as a shared copy of the directory tree src, cheapest safe
 * strategy first per platform, then break tool-writable spots so later writes
 * cannot travel back to src through a shared inode.
 */
export async function copyTreeShared(src: string, dst: string): Promise<{ mode: CopyMode }> {
  const sourceStat = await stat(src).catch(() => null);
  if (!sourceStat) {
    throw new Error(`copyTreeShared: source tree not found: ${src}`);
  }

  const attempts: CpAttempt[] =
    process.platform === "darwin"
      ? [
          // -R so directory trees clone; bare -c cannot copy directories.
          { cmd: "cp", args: ["-Rc", src, dst], mode: "clonefile" },
          { cmd: "cp", args: ["-pR", src, dst], mode: "copy" },
        ]
      : [
          { cmd: "cp", args: ["-a", "--reflink=auto", src, dst], mode: "reflink" },
          // Hardlink fallback: zero added bytes, but files share inodes with
          // the parent checkout — breakWritableSpots below is what makes this
          // safe (the documented inode caveat).
          { cmd: "cp", args: ["-al", src, dst], mode: "hardlink" },
        ];

  let lastStderr = "";
  for (const attempt of attempts) {
    // Start each attempt from a clean dst: a failed attempt leaves a partial
    // tree, and cp into an existing directory nests src inside it.
    await rm(dst, { recursive: true, force: true });
    const run = await execCp(attempt.cmd, attempt.args);
    if (run.ok) {
      await breakWritableSpots(dst);
      return { mode: attempt.mode };
    }
    lastStderr = run.stderr;
  }
  throw new Error(
    `copyTreeShared: every copy strategy failed for ${src} -> ${dst}; last error: ${lastStderr}`,
  );
}

// --- Cache retention ---

/**
 * Bound the persistent provision cache: delete direct entries oldest-first
 * (mtime) until the total is under maxBytes, and delete anything older than
 * maxAgeMs. Only entries inside cacheDir are ever removed; symlinks are
 * unlinked, not followed.
 */
export async function pruneProvisionCache(
  cacheDir: string,
  opts?: { maxBytes?: number; maxAgeMs?: number },
): Promise<{ removed: string[]; freedBytes: number }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  const removed: string[] = [];
  let freedBytes = 0;

  let dirents: Dirent[];
  try {
    dirents = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }

  const entries: CacheEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = join(cacheDir, dirent.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat) continue; // raced away between readdir and lstat
    entries.push({ path: entryPath, size: entryStat.size, mtimeMs: entryStat.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const now = Date.now();
  const keep: CacheEntry[] = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      await removeCacheEntry(entry.path);
      removed.push(entry.path);
      freedBytes += entry.size;
    } else {
      keep.push(entry);
    }
  }

  let totalBytes = keep.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of keep) {
    if (totalBytes <= maxBytes) break;
    await removeCacheEntry(entry.path);
    removed.push(entry.path);
    freedBytes += entry.size;
    totalBytes -= entry.size;
  }

  return { removed, freedBytes };
}
