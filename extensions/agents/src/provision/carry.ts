import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit } from "../../../../lib/git.ts";

const INCLUDE_FILE = ".worktreeinclude";
const SECRET_NAMES = [
  /^\.env(?:\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa(?:\..*)?$/,
  /^id_ed25519(?:\..*)?$/,
  /credentials/i,
  /^\.ssh$/,
];

export interface CarryResult {
  carried: string[];
  skipped: Array<{ path: string; reason: string }>;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isValidRelativePath(path: string): boolean {
  const name = path.replace(/^\//, "");
  return (
    name !== "" &&
    !isAbsolute(name) &&
    !name.includes("\0") &&
    !name.split(/[\\/]/).some((segment) => segment === ".." || segment === ".")
  );
}

/** Validate the include file; Git owns pattern matching and negation semantics. */
export async function readIncludePatterns(sourceRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(sourceRoot, INCLUDE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const patterns = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const pattern of patterns) {
    const path = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!isValidRelativePath(path)) {
      throw new Error(`invalid include path in ${INCLUDE_FILE}: ${pattern}`);
    }
  }
  return patterns;
}

function isSecretPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((component) => SECRET_NAMES.some((pattern) => pattern.test(component)));
}

/** Check each existing destination component before writing into a fresh worktree. */
async function ensureDestination(root: string, relativePath: string): Promise<string> {
  const destination = resolve(root, relativePath);
  if (!isInside(root, destination))
    throw new Error(`destination escapes worktree: ${relativePath}`);
  const components = relative(root, destination).split(sep);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error(`destination escapes worktree: ${relativePath}`);
    }
    if (!entry) await mkdir(current);
    if (!isInside(root, await realpath(current))) {
      throw new Error(`destination escapes worktree: ${relativePath}`);
    }
  }
  return destination;
}

/** Carry only paths matched by Git's ignore syntax, never hardlinking parent files. */
export async function carryIncludedPaths(
  sourceRoot: string,
  worktree: string,
): Promise<CarryResult> {
  const patterns = await readIncludePatterns(sourceRoot);
  const carried: string[] = [];
  const skipped: CarryResult["skipped"] = [];
  if (patterns.length === 0) return { carried, skipped };

  const root = await realpath(sourceRoot);
  const target = await realpath(worktree);
  const output = await runGit(sourceRoot, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${join(sourceRoot, INCLUDE_FILE)}`,
    "-z",
  ]);
  const names = output.split("\0").filter(Boolean).sort();
  for (const name of names) {
    if (!isValidRelativePath(name) || !isInside(root, resolve(root, name))) {
      throw new Error(`invalid include path in ${INCLUDE_FILE}: ${name}`);
    }
    if (isSecretPath(name)) {
      skipped.push({ path: name, reason: "secret-shaped" });
      continue;
    }
    const source = resolve(root, name);
    let realSource: string;
    try {
      realSource = await realpath(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      skipped.push({ path: name, reason: "not found" });
      continue;
    }
    if (!isInside(root, realSource)) {
      skipped.push({ path: name, reason: "symlink escapes project root" });
      continue;
    }
    const sourceStat = await lstat(realSource);
    if (!sourceStat.isFile()) {
      skipped.push({ path: name, reason: "not a file" });
      continue;
    }
    const destination = await ensureDestination(target, name);
    // COPYFILE_EXCL also refuses a tracked file or symlink already present
    // in the new worktree. The parent and worker never share an inode.
    await copyFile(realSource, destination, constants.COPYFILE_EXCL);
    carried.push(name);
  }
  return { carried, skipped };
}
