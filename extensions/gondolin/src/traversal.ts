import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { FindOperations } from "@earendil-works/pi-coding-agent";
import { toGuestPath, toPosix } from "./paths.ts";

export async function walkGuestFiles(
  vm: VM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, signal ? { signal } : undefined);
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, signal ? { signal } : undefined);
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
      try {
        entryStat = await vm.fs.stat(guestPath, signal ? { signal } : undefined);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

export function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

export function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(localCwd, cwd);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}
