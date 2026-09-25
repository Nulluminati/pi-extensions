import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type SandboxRuntimeConfig,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type WorkerSandboxPolicy = SandboxRuntimeConfig & {
  network: SandboxRuntimeConfig["network"] & { allowedDomains: string[] };
  filesystem: SandboxRuntimeConfig["filesystem"] & {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
};

function workspacePath(cwd: string, value: string): string {
  if (value === "~" || value.startsWith("~/") || isAbsolute(value)) return value;
  return resolve(cwd, value);
}

function isInside(root: string, path: string): boolean {
  const result = relative(root, path);
  return (
    result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result))
  );
}

function withinWorkspace(cwd: string, value: string): boolean {
  const path = workspacePath(cwd, value);
  if (path.startsWith("~") || !isInside(cwd, path)) return false;
  let existing = path;
  for (;;) {
    try {
      const resolved = realpathSync(existing);
      return isInside(realpathSync(cwd), resolve(resolved, relative(existing, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
}

/** Load a project-owned srt policy. Missing or weaker policies refuse worker startup. */
export function loadWorkerSandboxPolicy(cwd: string): WorkerSandboxPolicy {
  const file = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load worker sandbox policy ${file}: ${String(error)}`);
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("network" in raw) ||
    !raw.network ||
    typeof raw.network !== "object" ||
    !("allowedDomains" in raw.network) ||
    !("filesystem" in raw)
  ) {
    throw new Error(`Worker sandbox policy ${file} requires network.allowedDomains and filesystem`);
  }
  let parsed: SandboxRuntimeConfig;
  try {
    parsed = SandboxRuntimeConfigSchema.parse(raw);
  } catch (error) {
    throw new Error(`Invalid worker sandbox policy ${file}: ${String(error)}`);
  }
  if (parsed.network.allowAllUnixSockets || parsed.network.allowUnixSockets?.length) {
    throw new Error(`Worker sandbox policy ${file} must not permit host Unix sockets`);
  }
  if (parsed.network.allowLocalBinding) {
    throw new Error(`Worker sandbox policy ${file} must not permit local binding`);
  }
  if (parsed.filesystem.disabled) {
    throw new Error(`Worker sandbox policy ${file} must not disable filesystem isolation`);
  }
  if (
    parsed.enableWeakerNestedSandbox ||
    parsed.enableWeakerNetworkIsolation ||
    parsed.allowAppleEvents
  ) {
    throw new Error(`Worker sandbox policy ${file} must not weaken isolation`);
  }
  const worktree = resolve(cwd);
  for (const entry of parsed.filesystem.allowWrite ?? []) {
    if (!withinWorkspace(worktree, entry)) {
      throw new Error(`Worker sandbox write rule ${entry} is outside the worktree`);
    }
  }
  const mapPaths = (paths: string[] | undefined) =>
    (paths ?? []).map((entry) => workspacePath(worktree, entry));
  return {
    ...parsed,
    network: { ...parsed.network, allowedDomains: parsed.network.allowedDomains ?? [] },
    filesystem: {
      ...parsed.filesystem,
      denyRead: mapPaths(parsed.filesystem.denyRead),
      allowRead: mapPaths(parsed.filesystem.allowRead),
      allowWrite: mapPaths(parsed.filesystem.allowWrite),
      denyWrite: mapPaths(parsed.filesystem.denyWrite),
    },
  };
}
