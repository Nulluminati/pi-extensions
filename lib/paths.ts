/**
 * Canonical filesystem locations for extension state, plus Pi's own auth
 * store for the user-facing messages that point at it.
 *
 * Four locations, by lifetime and scope:
 * - `<agentDir>/<name>.json` — global config, alongside Pi's own settings.json
 * - `<agentDir>/<name>/` — global runtime state (logs, spools, locks)
 * - `${XDG_CACHE_HOME:-~/.cache}/pi-<name>/` — regenerable cache and models
 * - `<cwd>/<CONFIG_DIR_NAME>/<name>/` — project-local state
 * - `<cwd>/<CONFIG_DIR_NAME>/<file>` — project-local config file
 *
 * `<agentDir>` comes from `getAgentDir()` and honors PI_CODING_AGENT_DIR;
 * project paths use `CONFIG_DIR_NAME` so rebranded distributions resolve to
 * their own config directory. Never construct either path from `homedir()` or
 * a literal `.pi` — extensions that did wrote to the wrong tree whenever
 * either was overridden.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// --- Global ---

/** Global config file for an extension, e.g. `<agentDir>/voice.json`. */
export function agentConfigPath(name: string, agentDir = getAgentDir()): string {
  return join(agentDir, `${name}.json`);
}

/** Global runtime state directory for an extension, e.g. `<agentDir>/background-jobs`. */
export function agentStateDir(name: string, agentDir = getAgentDir()): string {
  return join(agentDir, name);
}

/**
 * Pi's own auth store. Extensions never write it; this exists so messages
 * that tell the user where to put a key point at the real file under
 * PI_CODING_AGENT_DIR. The package does not export getAuthPath from its root.
 */
export function authPath(agentDir = getAgentDir()): string {
  return join(agentDir, "auth.json");
}

// --- Cache ---

/** Regenerable cache directory for an extension, e.g. `~/.cache/pi-voice`. */
export function cacheDir(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const fromEnv = env.XDG_CACHE_HOME?.trim();
  const cacheRoot = fromEnv || join(home, ".cache");
  return join(cacheRoot, `pi-${name}`);
}

// --- Project ---

/** Project-local config file, e.g. `<cwd>/.pi/sandbox.json`. */
export function projectConfigPath(cwd: string, file: string): string {
  return join(cwd, CONFIG_DIR_NAME, file);
}

/** Project-local state directory, e.g. `<cwd>/.pi/missions`. */
export function projectStateDir(cwd: string, name: string): string {
  return join(cwd, CONFIG_DIR_NAME, name);
}

/**
 * Project-relative state path, e.g. `.pi/autoresearch`. Derive git-exclude
 * entries from this so they keep matching when CONFIG_DIR_NAME is rebound.
 */
export function projectStateRelative(name: string): string {
  return `${CONFIG_DIR_NAME}/${name}`;
}

/**
 * True when a project-relative path is extension state under the config dir —
 * either the dir itself (porcelain collapses a wholly-untracked tree to
 * `.pi/`) or anything inside it.
 */
export function isProjectStatePath(relativePath: string): boolean {
  return relativePath === CONFIG_DIR_NAME || relativePath.startsWith(`${CONFIG_DIR_NAME}/`);
}
