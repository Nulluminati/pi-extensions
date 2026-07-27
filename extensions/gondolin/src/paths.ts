import path from "node:path";
import { GUEST_WORKSPACE } from "./constants.ts";

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
  const relativePath = path.relative(localCwd, hostPath);
  if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
  return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

export function toGuestPath(localCwd: string, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}
