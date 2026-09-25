/**
 * Worktree provisioning config core: loading, merge, validation, detect
 * applicability, fingerprint staleness, and git-exclusion hygiene.
 *
 * Both policy files live under the project config dir: the committed
 * `provision.json` and the git-excluded `provision.local.json` override.
 * Staleness is a sha256 fingerprint of each `detect.any` input, stamped into
 * a git-excluded state file after a green provision. Unreadable-but-existing
 * files throw descriptively; missing files resolve cleanly (null / absent /
 * stale). Sibling modules own carry, share, and command execution.
 *
 * Design and review record: docs/issues/worktree-isolation-lacks-node-modules.md
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { excludeFromGit } from "../../../../lib/git.ts";
import { projectStateRelative } from "../../../../lib/paths.ts";
import {
  type LoadedProvisionConfig,
  type LocalProvisionConfig,
  PROVISION_CONFIG_FILE,
  PROVISION_LOCAL_FILE,
  PROVISION_SKILL_DIR,
  PROVISION_STATE_FILE,
  type ProvisionConfig,
  type ProvisionFingerprint,
  provisionConfigPath,
  provisionLocalPath,
  provisionStatePath,
  SHARE_STRATEGIES,
  type ValidationIssue,
} from "./types.ts";

// --- Constants ---

/** Known top-level config fields, in validation order. */
const KNOWN_FIELDS = [
  "carry",
  "detect",
  "provision",
  "share",
  "network",
  "timeoutSeconds",
  "providesOwn",
] as const;

/** Fields only the machine-local override may set. */
const LOCAL_ONLY_FIELDS = ["carryUnsafe"] as const;

/** Value the fingerprint map records for a detect input that does not exist. */
const ABSENT = "absent";

/** Reason reported when no state file exists yet. */
const NO_FINGERPRINT_REASON = "no provision fingerprint recorded";

// --- Helpers ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ENOENT and ENOTDIR both mean the path cannot exist as a file. */
function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse a JSON file; undefined when missing, throw descriptively otherwise. */
async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw new Error(`Failed to read ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`);
  }
}

function requireConfigObject(raw: unknown, path: string, exists: boolean): Record<string, unknown> {
  if (!exists) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return raw;
}

function checkStringArray(
  value: unknown,
  path: string,
  file: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({
      file,
      path,
      message: `${path} must be an array of non-empty strings`,
    });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push({
        file,
        path: `${path}[${index}]`,
        message: "must be a non-empty string",
      });
    }
  }
}

function isKnownField(key: string): boolean {
  return (
    (KNOWN_FIELDS as readonly string[]).includes(key) ||
    (LOCAL_ONLY_FIELDS as readonly string[]).includes(key)
  );
}

async function sha256OfFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

/** sha256 (or "absent") for each current detect input, keyed by config path. */
async function computeFingerprint(cwd: string): Promise<Record<string, string>> {
  const loaded = await loadProvisionConfig(cwd);
  const any = loaded?.config.detect?.any ?? [];
  const inputs: Record<string, string> = {};
  for (const file of any) {
    const absolute = join(cwd, file);
    try {
      inputs[file] = await sha256OfFile(absolute);
    } catch (error) {
      if (isMissingError(error)) {
        inputs[file] = ABSENT;
        continue;
      }
      throw new Error(`Failed to fingerprint detect input ${absolute}: ${messageOf(error)}`);
    }
  }
  return inputs;
}

async function readFingerprint(cwd: string): Promise<ProvisionFingerprint | undefined> {
  const path = provisionStatePath(cwd);
  const raw = await readJsonFile(path);
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || !isPlainObject(raw.inputs)) {
    throw new Error(`${path} is corrupt: expected an object with an inputs map`);
  }
  return raw as unknown as ProvisionFingerprint;
}

/** Order-insensitive comparison; key order never justifies a rewrite. */
function sameInputs(stamped: Record<string, string>, fresh: Record<string, string>): boolean {
  const stampedKeys = Object.keys(stamped);
  const freshKeys = Object.keys(fresh);
  if (stampedKeys.length !== freshKeys.length) return false;
  return stampedKeys.every((key) => stamped[key] === fresh[key]);
}

async function pathExists(base: string, relativePath: string): Promise<boolean> {
  try {
    await stat(join(base, relativePath));
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

// --- Config loading ---

/**
 * Read both policy files and merge the local override over the committed
 * config field by field. Returns null when neither file exists.
 */
export async function loadProvisionConfig(cwd: string): Promise<LoadedProvisionConfig | null> {
  const [committedRaw, localRaw] = await Promise.all([
    readJsonFile(provisionConfigPath(cwd)),
    readJsonFile(provisionLocalPath(cwd)),
  ]);
  const hasCommitted = committedRaw !== undefined;
  const hasLocal = localRaw !== undefined;
  if (!hasCommitted && !hasLocal) return null;

  const committed = requireConfigObject(committedRaw, provisionConfigPath(cwd), hasCommitted);
  const local = requireConfigObject(localRaw, provisionLocalPath(cwd), hasLocal);
  const config: ProvisionConfig & Partial<LocalProvisionConfig> = {
    ...committed,
    ...local,
  };
  return { config, hasCommitted, hasLocal };
}

// --- Config validation ---

/**
 * Strict shape check of one parsed config file: every present field is
 * type-checked, unknown keys are issues (they catch typos), and `share` must
 * be a known strategy. `carryUnsafe` is rejected in the committed file — it
 * is machine-local and only the git-excluded local override may set it.
 */
export function validateProvisionConfig(raw: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(raw)) {
    issues.push({ file, path: "", message: "config must be a JSON object" });
    return issues;
  }

  if ("carry" in raw) checkStringArray(raw.carry, "carry", file, issues);
  if ("detect" in raw) {
    if (isPlainObject(raw.detect)) {
      if ("any" in raw.detect) {
        checkStringArray(raw.detect.any, "detect.any", file, issues);
      }
    } else {
      issues.push({ file, path: "detect", message: "detect must be an object" });
    }
  }
  if ("provision" in raw && typeof raw.provision !== "string") {
    issues.push({
      file,
      path: "provision",
      message: "provision must be a string",
    });
  }
  if (
    "share" in raw &&
    !(typeof raw.share === "string" && (SHARE_STRATEGIES as readonly string[]).includes(raw.share))
  ) {
    issues.push({
      file,
      path: "share",
      message: `share must be one of: ${SHARE_STRATEGIES.join(", ")}`,
    });
  }
  if ("network" in raw) checkStringArray(raw.network, "network", file, issues);
  if ("timeoutSeconds" in raw) {
    const seconds = raw.timeoutSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      issues.push({
        file,
        path: "timeoutSeconds",
        message: "timeoutSeconds must be a positive finite number",
      });
    }
  }
  if ("providesOwn" in raw && typeof raw.providesOwn !== "boolean") {
    issues.push({
      file,
      path: "providesOwn",
      message: "providesOwn must be a boolean",
    });
  }

  if (file === PROVISION_CONFIG_FILE && "carryUnsafe" in raw) {
    issues.push({
      file,
      path: "carryUnsafe",
      message: `carryUnsafe is local-only; move it to ${PROVISION_LOCAL_FILE} (git-excluded, machine-local)`,
    });
  }

  for (const key of Object.keys(raw)) {
    if (isKnownField(key)) continue;
    issues.push({ file, path: key, message: `unknown field "${key}"` });
  }

  return issues;
}

// --- Applicability ---

/**
 * True when the merged config constrains nothing (`detect` absent) or at
 * least one `detect.any` path exists. Paths are plain and project-relative;
 * there are no globs.
 */
export async function configApplies(cwd: string): Promise<boolean> {
  const loaded = await loadProvisionConfig(cwd);
  const detect = loaded?.config.detect;
  if (!detect || detect.any === undefined) return true;
  for (const file of detect.any) {
    if (await pathExists(cwd, file)) return true;
  }
  return false;
}

// --- Fingerprint staleness ---

/**
 * Compare the stamped fingerprint against freshly computed hashes of the
 * current detect inputs. Stale when no state exists, an input changed
 * (including appearing or disappearing), or an input was added to `detect`.
 */
export async function isProvisionStale(
  cwd: string,
): Promise<{ stale: boolean; reasons: string[] }> {
  const stamped = await readFingerprint(cwd);
  if (!stamped) {
    return { stale: true, reasons: [NO_FINGERPRINT_REASON] };
  }
  const fresh = await computeFingerprint(cwd);
  const reasons: string[] = [];
  for (const [file, hash] of Object.entries(fresh)) {
    const recorded = stamped.inputs[file];
    if (recorded === undefined) {
      reasons.push(`${file} was added to detect after the last provision`);
    } else if (recorded !== hash) {
      reasons.push(`${file} changed since the last provision`);
    }
  }
  return { stale: reasons.length > 0, reasons };
}

/**
 * Stamp the current detect-input hashes into the state file (atomic tmp +
 * rename in the same directory). Skips the write entirely when the input map
 * is unchanged so re-stamping never churns the file.
 */
export async function recordProvisionInputs(cwd: string): Promise<void> {
  const inputs = await computeFingerprint(cwd);
  const stamped = await readFingerprint(cwd);
  if (stamped && sameInputs(stamped.inputs, inputs)) return;

  const statePath = provisionStatePath(cwd);
  const state: ProvisionFingerprint = { inputs, at: Date.now() };
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = join(dirname(statePath), `.${basename(statePath)}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, statePath);
}

// --- Git hygiene ---

/**
 * Append the state file, the local override, and the materialized skill
 * directory to the repo's local exclude so untracked provision state never
 * dirties the worktree gate. Best-effort: a no-op outside a repository.
 */
export async function ensureProvisionExclusions(cwd: string): Promise<void> {
  await excludeFromGit(cwd, projectStateRelative(PROVISION_STATE_FILE));
  await excludeFromGit(cwd, projectStateRelative(PROVISION_LOCAL_FILE));
  await excludeFromGit(cwd, projectStateRelative(join("skills", PROVISION_SKILL_DIR)));
}
