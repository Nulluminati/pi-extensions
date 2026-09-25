/**
 * Worktree provisioning: shared types, path helpers, and module contracts.
 *
 * The design separates mechanism from policy: extension code here carries no
 * ecosystem knowledge. Per-repo policy lives in a committed `.pi/provision.json`
 * (authored by the main conversation model, guided by the bundled skill);
 * this module defines the vocabulary those pieces share. Sibling modules:
 *
 * - `config.ts`   — load, merge, validate configs; fingerprint staleness.
 * - `primitives.ts` — carry (config files) and share (directory copies).
 * - `executor.ts` — run the `provision` command in a throwaway VM.
 * - `skill.ts`    — materialize the bundled guidance skill per project.
 *
 * Design and review record: docs/issues/worktree-isolation-lacks-node-modules.md
 */

import { join } from "node:path";
import { projectStateDir } from "../../../../lib/paths.ts";

// --- Constants ---

/** Committed policy file (tracked, shared). */
export const PROVISION_CONFIG_FILE = "provision.json";
/** Machine-local override (git-excluded; may carry `carryUnsafe`). */
export const PROVISION_LOCAL_FILE = "provision.local.json";
/** Fingerprint state (git-excluded project state; never tracked). */
export const PROVISION_STATE_FILE = "provision-state.json";
/** Skill directory materialized under the project config dir. */
export const PROVISION_SKILL_DIR = "provision";
/** Provision command budget when the config omits `timeoutSeconds`. */
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Lock waiters return `busy` after provision timeout + this grace. */
export const BUSY_GRACE_MS = 15_000;
/** Directory-copy strategies, cheapest safe option first. */
export const SHARE_STRATEGIES = ["hardlink-copy", "install", "none"] as const;

// --- Config (policy) ---

export type ShareStrategy = (typeof SHARE_STRATEGIES)[number];

/** The committed per-repo policy. No `carryUnsafe` key: validation rejects it
 *  in committed files; only the local override may set it. */
export interface ProvisionConfig {
  /** Gitignored paths to carry from the parent checkout into the worktree. */
  carry?: string[];
  /** When this config applies: at least one listed file must exist (plain
   *  project-relative paths, no globs). Omitted = always applies. */
  detect?: { any?: string[] };
  /** Command executed in the throwaway provision VM. Omitted = no command. */
  provision?: string;
  /** How dependencies reach the worktree. Default: `provision` if present,
   *  otherwise `none`. */
  share?: ShareStrategy;
  /** Hosts the provision VM may reach (createHttpHooks allowedHosts). */
  network?: string[];
  /** Provision command budget. Default {@link DEFAULT_TIMEOUT_SECONDS}. */
  timeoutSeconds?: number;
  /** True: the project owns its environment end to end; mechanism runs only
   *  carry + the command, no share defaults. */
  providesOwn?: boolean;
}

/** Machine-local overrides, merged over the committed config. */
export interface LocalProvisionConfig extends ProvisionConfig {
  /** Opt in to carrying secret-shaped paths. Honored ONLY from this file;
   *  present in a committed config = validation error. */
  carryUnsafe?: boolean;
}

/** Result of reading both config files for a project. */
export interface LoadedProvisionConfig {
  config: ProvisionConfig & Partial<LocalProvisionConfig>;
  hasCommitted: boolean;
  hasLocal: boolean;
}

/** One validation problem, file-scoped. */
export interface ValidationIssue {
  file: string;
  path: string;
  message: string;
}

// --- Status (mechanism output) ---

/** `yes` ran green; `none` no applicable config; `failed` refused with detail;
 *  `skipped` no worktree (plan/non-isolated); `busy` lock wait exhausted. */
export type ProvisionState = "yes" | "none" | "failed" | "skipped" | "busy";

/** Persisted on `WorkerRecord.provision`; echoed in delegate responses. */
export interface ProvisionStatus {
  state: ProvisionState;
  detail?: string;
  at: number;
}

// --- Fingerprints (staleness) ---

/** sha256 of each `detect.any` input file, stamped after a green provision. */
export interface ProvisionFingerprint {
  inputs: Record<string, string>;
  at: number;
}

// --- Execution contracts ---

/** Options for `executor.runProvisionCommand`. */
export interface ProvisionRunOptions {
  /** Absolute host path of the worktree; mounted read-write at /workspace. */
  worktree: string;
  /** The config `provision` command string. */
  command: string;
  /** createHttpHooks allowedHosts; omitted = allow all (documented hazard). */
  network?: string[];
  /** Hard bound on command execution. */
  timeoutMs: number;
  /** Persistent host cache dir (cacheDir("provision")); mounted at /cache. */
  cacheDir: string;
}

export interface ProvisionRunResult {
  exitCode: number;
  /** Tail of combined output, bounded — becomes `ProvisionStatus.detail`. */
  detail: string;
  ms: number;
}

/** Options for `primitives.carryPaths`. */
export interface CarryOptions {
  /** Absolute host path of the worktree (copy destination). */
  worktree: string;
  /** Absolute host path of the parent checkout (copy source). */
  sourceRoot: string;
  /** Config `carry` paths plus a present `.worktreeinclude`, deduplicated. */
  paths: string[];
  /** Whether the local override opted into secret-shaped paths. */
  allowUnsafe: boolean;
}

export interface CarryResult {
  carried: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** How `primitives.copyTreeShared` achieved the copy (diagnostics). */
export type CopyMode = "reflink" | "clonefile" | "hardlink" | "copy";

// --- Path helpers (CONFIG_DIR_NAME discipline: no literal `.pi` anywhere) ---

export function provisionConfigPath(cwd: string): string {
  return projectStateDir(cwd, PROVISION_CONFIG_FILE);
}

export function provisionLocalPath(cwd: string): string {
  return projectStateDir(cwd, PROVISION_LOCAL_FILE);
}

export function provisionStatePath(cwd: string): string {
  return projectStateDir(cwd, PROVISION_STATE_FILE);
}

export function provisionSkillPath(cwd: string): string {
  return join(projectStateDir(cwd, "skills"), PROVISION_SKILL_DIR, "SKILL.md");
}
