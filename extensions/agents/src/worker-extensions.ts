/**
 * Worker extension allowlist.
 *
 * Worker sessions run with `--no-extensions` plus an explicit allowlist: a
 * bounded set of extensions that keeps workers capable (interop via
 * messenger, research tools, provider registrations, sandboxing) without
 * giving them the full suite (no nested delegation, no mission/record
 * mutation, no campaigns).
 *
 * Resolution order: the delegate call's explicit list, then
 * PI_WORKER_EXTENSIONS (comma-separated names), then the config file, then
 * the default set. `messenger`, `worker-blocker`, `approval-mode`, and
 * `worker-sandbox` are always included: the first two coordinate with the
 * parent, approval-mode gates commands, and worker-sandbox isolates tools.
 * A hard denylist rejects workflow extensions that would break the one-level
 * delegation model, even when explicitly requested.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNodeError } from "../../../lib/errors.ts";
import { agentConfigPath } from "../../../lib/paths.ts";

// --- Constants ---

export const WORKER_EXTENSIONS_ENV_VAR = "PI_WORKER_EXTENSIONS";
export const WORKER_EXTENSIONS_CONFIG_ENV_VAR = "PI_WORKER_EXTENSIONS_CONFIG";

export const DEFAULT_WORKER_EXTENSIONS = [
  "messenger",
  "code-search",
  "context7",
  "web-search",
  "synthetic",
  "neuralwatt",
  "approval-mode",
  "worker-sandbox",
] as const;

/**
 * Workflow extensions that must never load in a worker: agents would allow
 * nested delegation, missions/autoresearch/goal would let a one-shot worker
 * mutate durable project records or run campaigns.
 */
export const FORBIDDEN_WORKER_EXTENSIONS = ["agents", "missions", "autoresearch", "goal"] as const;

/** Coordination, blocker reporting, and sandbox extensions loaded by every
 *  worker. worker-sandbox pins last so its built-in tool overrides cannot be
 *  shadowed by an extension loaded afterward. */
export const REQUIRED_WORKER_EXTENSIONS = [
  "messenger",
  "worker-blocker",
  "approval-mode",
  "worker-sandbox",
] as const;

/**
 * Extension names map to extensions/<name>/<name>.ts; names outside the
 * lowercase letters, digits, and hyphens convention are rejected before any
 * filesystem access, so traversal like "agents/../agents" cannot slip past
 * the denylist or resolve an unintended entrypoint.
 */
const WORKER_EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ResolvedWorkerExtension {
  name: string;
  /** Absolute path to the extension entrypoint. */
  path: string;
}

export interface ResolveWorkerExtensionsOptions {
  /** Repository extensions directory (defaults to <repo>/extensions). */
  extensionsRoot?: string;
  /** Path to the worker-extensions config file. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

// --- Resolution ---

/**
 * Resolve the extensions a worker should load. Order: explicit list →
 * PI_WORKER_EXTENSIONS (comma-separated names) → config file → default set.
 * Throws on denylisted names, unknown names, and malformed config.
 */
export function resolveWorkerExtensions(
  explicit: string[] | undefined,
  options: ResolveWorkerExtensionsOptions = {},
): ResolvedWorkerExtension[] {
  const env = options.env ?? process.env;
  const root = options.extensionsRoot ?? defaultExtensionsRoot();
  const configPath = options.configPath ?? workerExtensionsConfigPath(env);

  let names: string[];
  if (explicit !== undefined) {
    names = explicit;
  } else {
    const envValue = env[WORKER_EXTENSIONS_ENV_VAR]?.trim();
    if (envValue) {
      names = envValue.split(",").map((part) => part.trim());
      if (names.some((name) => !name)) {
        throw new Error(
          `Invalid ${WORKER_EXTENSIONS_ENV_VAR} value "${envValue}". Expected a comma-separated list of extension names.`,
        );
      }
    } else {
      names = loadWorkerExtensionsConfig(configPath) ?? [...DEFAULT_WORKER_EXTENSIONS];
    }
  }

  const forbidden = new Set<string>(FORBIDDEN_WORKER_EXTENSIONS);
  const requestedNames = names.map((name) => name.trim());
  // Mandatory extensions pin the ends of the load order: boundary machinery
  // first, the worker sandbox's built-in tool overrides last. Requested
  // duplicates of either fall out via the Set.
  const unique = new Set<string>([
    ...REQUIRED_WORKER_EXTENSIONS.filter((name) => name !== "worker-sandbox"),
    ...requestedNames.filter((name) => name !== "worker-sandbox"),
    "worker-sandbox",
  ]);
  const resolved: ResolvedWorkerExtension[] = [];
  for (const name of unique) {
    if (!WORKER_EXTENSION_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid worker extension name "${name}": expected lowercase letters, digits, and hyphens (extensions map to extensions/<name>/<name>.ts).`,
      );
    }
    if (forbidden.has(name)) {
      throw new Error(
        `Extension "${name}" is forbidden in worker sessions (would break the one-level delegation model or mutate durable records).`,
      );
    }
    const path = join(root, name, `${name}.ts`);
    if (!existsSync(path)) {
      throw new Error(
        `Unknown worker extension "${name}": no entrypoint at ${path}. Extension names map to extensions/<name>/<name>.ts.`,
      );
    }
    resolved.push({ name, path });
  }
  return resolved;
}

function loadWorkerExtensionsConfig(configPath: string): string[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    // Only a config file that cannot exist means "not configured"; a
    // failure to read an existing one must not fall back to the defaults.
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw new Error(`Cannot read worker extensions config ${configPath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid worker extensions config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(
      `Invalid worker extensions config ${configPath}: expected an array of extension names.`,
    );
  }
  return parsed;
}

function workerExtensionsConfigPath(env: NodeJS.ProcessEnv): string {
  const override = env[WORKER_EXTENSIONS_CONFIG_ENV_VAR]?.trim();
  return override || agentConfigPath("worker-extensions", defaultAgentDir());
}

// This module lives at <repo>/extensions/agents/src/, so two directory
// levels up is the repository's extensions/ directory.
function defaultExtensionsRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function defaultAgentDir(): string {
  return getAgentDir();
}
