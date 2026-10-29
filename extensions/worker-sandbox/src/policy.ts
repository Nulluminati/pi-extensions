import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type FilesystemPathEntry,
  type SandboxRuntimeConfig,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { projectConfigPath } from "../../../lib/paths.ts";

export type WorkerSandboxPolicy = SandboxRuntimeConfig & {
  excludedCommands?: string[];
  network: SandboxRuntimeConfig["network"] & { allowedDomains: string[] };
  filesystem: SandboxRuntimeConfig["filesystem"] & {
    denyRead: FilesystemPathEntry[];
    allowRead: FilesystemPathEntry[];
    allowWrite: FilesystemPathEntry[];
    denyWrite: FilesystemPathEntry[];
  };
};

function workspacePath(cwd: string, value: string): string {
  if (value === "~" || value.startsWith("~/") || isAbsolute(value)) return value;
  return resolve(cwd, value);
}

/** The path a policy entry names, whether it is spelled or marked literal. */
function entryPath(entry: FilesystemPathEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

/** Resolve a policy entry against the worker directory, keeping its literal mark. */
function workspaceEntry(cwd: string, entry: FilesystemPathEntry): FilesystemPathEntry {
  return typeof entry === "string"
    ? workspacePath(cwd, entry)
    : { path: workspacePath(cwd, entry.path), literal: true };
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
export function loadWorkerSandboxPolicy(cwd: string, readOnly = false): WorkerSandboxPolicy {
  const file = projectConfigPath(cwd, "sandbox.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load worker sandbox policy ${file}: ${String(error)}`);
  }
  return parseSandboxPolicy(cwd, raw, file, readOnly, true);
}

/** An explicit launcher policy may grant write paths outside the project. */
export function loadSessionSandboxPolicy(cwd: string, json: string): WorkerSandboxPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid --sandbox JSON: ${String(error)}`);
  }
  return parseSandboxPolicy(cwd, raw, "--sandbox", false, false);
}

function parseSandboxPolicy(
  cwd: string,
  raw: unknown,
  file: string,
  readOnly: boolean,
  worker: boolean,
): WorkerSandboxPolicy {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("network" in raw) ||
    !raw.network ||
    typeof raw.network !== "object" ||
    !("allowedDomains" in raw.network) ||
    !("filesystem" in raw) ||
    !raw.filesystem ||
    typeof raw.filesystem !== "object" ||
    Array.isArray(raw.filesystem)
  ) {
    throw new Error(`Worker sandbox policy ${file} requires network.allowedDomains and filesystem`);
  }
  let parsed: SandboxRuntimeConfig;
  try {
    parsed = SandboxRuntimeConfigSchema.parse({
      ...raw,
      network: { deniedDomains: [], ...raw.network },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [], ...raw.filesystem },
    });
  } catch (error) {
    throw new Error(`Invalid worker sandbox policy ${file}: ${String(error)}`);
  }
  if (parsed.network.allowAllUnixSockets || parsed.network.allowUnixSockets?.length) {
    throw new Error(`Worker sandbox policy ${file} must not permit host Unix sockets`);
  }
  if (parsed.network.httpProxyPort || parsed.network.socksProxyPort) {
    throw new Error(`Sandbox policy ${file} must not use an external proxy`);
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
  const excludedCommands = "excludedCommands" in raw ? raw.excludedCommands : [];
  if (
    !Array.isArray(excludedCommands) ||
    excludedCommands.some(
      (rule) => typeof rule !== "string" || !/^[a-zA-Z0-9_./-]+(?: \*)?$/.test(rule),
    )
  ) {
    throw new Error(
      `Sandbox policy ${file} requires excludedCommands to name a command, optionally followed by ' *'`,
    );
  }
  if (worker && excludedCommands.length) {
    throw new Error(`Worker sandbox policy ${file} must not exclude commands`);
  }
  const worktree = resolve(cwd);
  for (const entry of worker ? (parsed.filesystem.allowWrite ?? []) : []) {
    const rule = entryPath(entry);
    if (!withinWorkspace(worktree, rule)) {
      throw new Error(`Worker sandbox write rule ${rule} is outside the worktree`);
    }
  }
  const mapPaths = (paths: FilesystemPathEntry[] | undefined): FilesystemPathEntry[] =>
    (paths ?? []).map((entry) => workspaceEntry(worktree, entry));
  return {
    ...parsed,
    ...(worker ? {} : { excludedCommands }),
    network: {
      ...parsed.network,
      allowedDomains: parsed.network.allowedDomains ?? [],
      strictAllowlist: true,
    },
    filesystem: {
      ...parsed.filesystem,
      denyRead: mapPaths(parsed.filesystem.denyRead),
      allowRead: mapPaths(parsed.filesystem.allowRead),
      allowWrite: readOnly ? [] : mapPaths(parsed.filesystem.allowWrite),
      denyWrite: readOnly
        ? [worktree, ...mapPaths(parsed.filesystem.denyWrite)]
        : mapPaths(parsed.filesystem.denyWrite),
    },
  };
}
