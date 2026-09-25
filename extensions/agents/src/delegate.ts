/**
 * Delegate tool behavior: resolves the delegate call's arguments (task,
 * worker name, model, extensions, plan-mode constraints, worktree decision),
 * reserves a worker slot and spawns the child session, and builds the tool
 * responses. The reservation and its failure-release flow are the
 * concurrency-safety core of delegation.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionContext, ThinkingLevel } from "pi";
import { withFileLock } from "../../../lib/file-lock.ts";
import { runGit } from "../../../lib/git.ts";
import { cacheDir, projectStateRelative } from "../../../lib/paths.ts";
import { isPlanModeActive } from "../../../lib/plan-state.ts";
import { resolveWorkerModelSpec } from "../../../lib/worker-model.ts";
import { formatWorkerStatus } from "./format.ts";
import {
  configApplies,
  isProvisionStale,
  loadProvisionConfig,
  recordProvisionInputs,
  validateProvisionConfig,
} from "./provision/config.ts";
import { runProvisionCommand } from "./provision/executor.ts";
import { carryPaths, copyTreeShared } from "./provision/primitives.ts";
import {
  BUSY_GRACE_MS,
  DEFAULT_TIMEOUT_SECONDS,
  type LoadedProvisionConfig,
  PROVISION_CONFIG_FILE,
  PROVISION_LOCAL_FILE,
  type ProvisionStatus,
  provisionConfigPath,
  provisionLocalPath,
  provisionSkillPath,
  provisionStatePath,
  type ValidationIssue,
} from "./provision/types.ts";
import { type RunningWorker, startWorker } from "./runner.ts";
import { generateWorkerId, sweepWorkerArtifacts } from "./store.ts";
import type { WorkerEvents, WorkerRecord } from "./types.ts";
import { resolveWorkerExtensions } from "./worker-extensions.ts";
import { createWorktree, isGitRepo, removeWorktree } from "./worktree.ts";

// --- Constants ---

const DEFAULT_TIMEOUT_MS = 900_000;

/** Fixed message for the path-limited provision config commit (review D2). */
const PROVISION_COMMIT_MESSAGE = "chore(provision): update worktree provision config";
/** Parent-checkout file listing extra carry paths (gitignore-style lines). */
const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
/** Refusal when the provision config lock stays held past the wait bound. */
const PROVISION_BUSY_MESSAGE = "provisioned: busy (another provision is running); retry shortly.";

function envMaxWorkers(): number {
  const parsed = Number.parseInt(process.env.PI_MAX_WORKERS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function envTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.PI_WORKER_TIMEOUT_S ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_TIMEOUT_MS;
}

// --- Provisioning (worktree environment) ---

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ENOENT and ENOTDIR both mean the path cannot exist as a file. */
function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Collapse a detail/error to one line for refusal texts and record fields. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A refusal raised by the provisioning flow. It carries the ProvisionStatus
 * recorded on the failed worker record, and the message is the refusal text
 * returned to the delegating model.
 */
class ProvisionRefusal extends Error {
  readonly provision: ProvisionStatus;

  constructor(provision: ProvisionStatus, message: string) {
    super(message);
    this.name = "ProvisionRefusal";
    this.provision = provision;
  }
}

function provisionLockPath(cwd: string): string {
  return `${provisionConfigPath(cwd)}.lock`;
}

/** Parsed JSON of one policy file; undefined when missing, descriptive
 *  throw when unreadable or not JSON (same contract as config loading).
 *  Validation needs the raw shape, which the merged load does not keep. */
async function readRawProvisionFile(path: string): Promise<unknown> {
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

async function hasProvisionFingerprint(cwd: string): Promise<boolean> {
  try {
    await stat(provisionStatePath(cwd));
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

/**
 * Preflight for isolated delegates (review D1): refuse before the slot
 * reservation when the provision policy cannot produce a working
 * environment — config missing or not applicable, invalid, or stale. The
 * refusal text carries the bundled skill pointer so the delegating model
 * can fix the config and re-delegate (the documented recovery loop).
 */
export async function assertProvisionReady(cwd: string): Promise<void> {
  const skill = provisionSkillPath(cwd);
  const relConfig = projectStateRelative(PROVISION_CONFIG_FILE);
  const loaded = await loadProvisionConfig(cwd);

  // Shape validation per file (unknown fields, types, local-only keys).
  const issues: ValidationIssue[] = [];
  if (loaded?.hasCommitted) {
    issues.push(
      ...validateProvisionConfig(
        await readRawProvisionFile(provisionConfigPath(cwd)),
        PROVISION_CONFIG_FILE,
      ),
    );
  }
  if (loaded?.hasLocal) {
    issues.push(
      ...validateProvisionConfig(
        await readRawProvisionFile(provisionLocalPath(cwd)),
        PROVISION_LOCAL_FILE,
      ),
    );
  }
  if (issues.length > 0) {
    const list = issues.map((issue) => `${issue.file}:${issue.path}: ${issue.message}`).join("; ");
    throw new Error(
      `provisioned: invalid config (${list}). Read ${skill}, fix ${relConfig} per the skill, then re-delegate.`,
    );
  }

  if (loaded === null || !(await configApplies(cwd))) {
    throw new Error(
      `provisioned: none (config missing or not applicable). Read ${skill}, author ${relConfig} per the skill, then re-delegate.`,
    );
  }

  const { stale, reasons } = await isProvisionStale(cwd);
  if (!stale) return;
  // "No fingerprint recorded" is the first-run state, not drift: the green
  // provision below stamps it, so the delegate proceeds.
  if (!(await hasProvisionFingerprint(cwd))) return;
  // Stale-refresh (design "Loops" section): consume the drift signal so the
  // recovery loop converges — the model reviews the config, and the next
  // delegate provisions with the current inputs instead of refusing again.
  await recordProvisionInputs(cwd);
  throw new Error(
    `provisioned: stale (${reasons.join("; ")}). Read ${skill}, refresh ${relConfig} per the skill, then re-delegate.`,
  );
}

/**
 * Gitignore-style plain lines of a present `.worktreeinclude`; blanks and
 * comments ignored. Negation lines are skipped: nothing has been carried
 * yet that a `!pattern` could un-carry.
 */
async function readWorktreeInclude(sourceRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(sourceRoot, WORKTREE_INCLUDE_FILE), "utf8");
  } catch (error) {
    if (isMissingError(error)) return [];
    throw new Error(`Failed to read ${WORKTREE_INCLUDE_FILE}: ${messageOf(error)}`);
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
}

/**
 * Review D2: a provisioned delegate branches worktrees from HEAD, so an
 * untracked or modified committed config must be committed (path-limited,
 * fixed message) before the worker runs — an uncommitted config fails the
 * next delegate's dirty gate, so warn-and-continue is impossible. The local
 * override and the state file are git-excluded and never committed. A commit
 * failure refuses the delegate with the named git reason.
 */
async function commitProvisionConfig(
  cwd: string,
  skill: string,
  relConfig: string,
  notifyInfo: (message: string) => void,
): Promise<void> {
  const configPath = provisionConfigPath(cwd);
  try {
    const status = await runGit(cwd, ["status", "--porcelain", "--", configPath]);
    if (status.trim() === "") return; // committed and clean
    await runGit(cwd, ["add", "--", configPath]);
    // --only: commit the config alone, never unrelated staged work.
    await runGit(cwd, ["commit", "-m", PROVISION_COMMIT_MESSAGE, "--only", "--", configPath]);
  } catch (error) {
    throw new ProvisionRefusal(
      {
        state: "failed",
        detail: `config commit failed: ${oneLine(messageOf(error))}`,
        at: Date.now(),
      },
      `provisioned: config commit failed (${oneLine(messageOf(error))}). Read ${skill}, commit ${relConfig} host-side, then re-delegate.`,
    );
  }
  notifyInfo(`Provision config committed (${relConfig}) so worker worktrees branch from it.`);
}

/**
 * Populate a fresh worktree under the provision config lock, in primitive
 * order carry → share → provision command, then stamp fingerprints and
 * commit the config. Boots the provision VM only when the config has a
 * command (review N2). Throws ProvisionRefusal on busy and failed; the
 * caller owns worktree cleanup (busy discards, failed keeps it for
 * remove/prune — review B4).
 */
async function provisionWorktree(
  cwd: string,
  worktree: { path: string; branch: string },
  notifyInfo: (message: string) => void,
): Promise<ProvisionStatus> {
  const loaded: LoadedProvisionConfig | null = await loadProvisionConfig(cwd);
  if (loaded === null) return { state: "yes", detail: "nothing to do", at: Date.now() };
  const config = loaded.config;
  const skill = provisionSkillPath(cwd);
  const relConfig = projectStateRelative(PROVISION_CONFIG_FILE);
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  const carryList = [...new Set([...(config.carry ?? []), ...(await readWorktreeInclude(cwd))])];
  const wantsShare = config.share === "hardlink-copy";
  const command = config.provision?.trim();
  if (carryList.length === 0 && !wantsShare && command === undefined) {
    // The config has no work (review N2: no VM boots). Stamp anyway so the
    // config does not read as stale forever.
    await recordProvisionInputs(cwd);
    return { state: "yes", detail: "nothing to do", at: Date.now() };
  }

  const detailParts: string[] = [];
  try {
    await withFileLock(
      provisionLockPath(cwd),
      async () => {
        if (carryList.length > 0) {
          const carry = await carryPaths({
            worktree: worktree.path,
            sourceRoot: cwd,
            paths: carryList,
            allowUnsafe: config.carryUnsafe === true,
          });
          detailParts.push(`carry ${carry.carried.length}`);
        }
        if (wantsShare) {
          // Documented npm convention: the parent's node_modules reaches the
          // worktree as a shared copy when it exists.
          const sourceModules = join(cwd, "node_modules");
          if (await pathExists(sourceModules)) {
            const { mode } = await copyTreeShared(
              sourceModules,
              join(worktree.path, "node_modules"),
            );
            detailParts.push(`share ${mode}`);
          } else {
            detailParts.push("share none (no node_modules in parent checkout)");
          }
        }
        if (command !== undefined) {
          const run = await runProvisionCommand({
            worktree: worktree.path,
            command,
            ...(config.network !== undefined ? { network: config.network } : {}),
            timeoutMs,
            cacheDir: cacheDir("provision"),
          });
          if (run.exitCode !== 0) {
            throw new ProvisionRefusal(
              {
                state: "failed",
                detail: `exit ${run.exitCode}: ${oneLine(run.detail)}`,
                at: Date.now(),
              },
              `provisioned: failed (exit ${run.exitCode}): ${oneLine(run.detail)}. Read ${skill}, fix ${relConfig} or the environment per the skill, then re-delegate.`,
            );
          }
          detailParts.push(`command exit ${run.exitCode} (${Math.round(run.ms / 1000)}s)`);
        }
        await recordProvisionInputs(cwd);
        await commitProvisionConfig(cwd, skill, relConfig, notifyInfo);
      },
      {
        // Waiters give up after the provision budget plus a grace period,
        // then the delegate refuses busy (no spawn, no orphan).
        timeoutMs: timeoutMs + BUSY_GRACE_MS,
        timeoutMessage: PROVISION_BUSY_MESSAGE,
      },
    );
  } catch (error) {
    if (error instanceof ProvisionRefusal) throw error;
    // The lock's timeout error carries exactly the busy refusal text.
    if (error instanceof Error && error.message === PROVISION_BUSY_MESSAGE) {
      throw new ProvisionRefusal(
        { state: "busy", detail: "lock wait exhausted", at: Date.now() },
        PROVISION_BUSY_MESSAGE,
      );
    }
    throw new ProvisionRefusal(
      { state: "failed", detail: oneLine(messageOf(error)), at: Date.now() },
      `provisioned: failed (${oneLine(messageOf(error))}). Read ${skill}, fix ${relConfig} or the environment per the skill, then re-delegate.`,
    );
  }
  return { state: "yes", detail: detailParts.join(", "), at: Date.now() };
}

// --- Types ---

/** Loose view of the delegate tool parameters; each field is validated at runtime. */
export interface DelegateParams {
  task?: unknown;
  name?: unknown;
  extensions?: unknown;
  isolate?: boolean;
  wait?: boolean;
  timeout_seconds?: number;
}

/** Everything the reservation and spawn steps need, resolved up front. */
export interface DelegatePlan {
  workerId: string;
  /** Sanitized name; falls back to the worker id (trusted-channel constraint). */
  name: string;
  task: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  /** Parent session is planning: worker is read-only and never isolated. */
  parentPlanning: boolean;
  extensionPaths: string[];
  /** The worker wants a worktree (not planning, isolate not disabled). */
  wantIsolate: boolean;
  /** The caller demanded isolation (isolate=true): error outside git repos. */
  isolateRequired: boolean;
  maxWorkers: number;
  /** Owning session id (transcript ownership is implicit; this labels the
   *  artifact record file for the janitor). */
  parentSessionId: string;
}

// --- Argument resolution ---

/**
 * Resolve the delegate call into a spawnable plan. Throws on an empty task
 * or an unresolvable worker model; the reservation itself happens later (see
 * startDelegatedWorker) so refusals there never leave partial state.
 */
export async function planDelegate(
  params: DelegateParams,
  ctx: ExtensionContext,
): Promise<DelegatePlan> {
  const task = typeof params.task === "string" ? params.task.trim() : "";
  if (!task) throw new Error("delegate requires task.");
  const workerId = generateWorkerId();

  const maxWorkers = envMaxWorkers();

  // The global environment/config selection is authoritative. Individual
  // delegate calls cannot silently substitute another model.
  const { model, thinkingLevel } = await resolveWorkerModelSpec();
  const timeoutMs =
    typeof params.timeout_seconds === "number" && params.timeout_seconds > 0
      ? params.timeout_seconds * 1000
      : envTimeoutMs();
  const parentPlanning = isPlanModeActive((ctx.sessionManager.getBranch() ?? []) as unknown[]);

  // Sanitize at the boundary: the name flows into wake messages and
  // PI_MESSENGER_NAME, a trusted channel that carries ids and status
  // words only, so anything outside [A-Za-z0-9_-] (or longer than 64
  // chars) falls back to the worker id.
  const requestedName = typeof params.name === "string" ? params.name.trim() : "";
  const name =
    requestedName && requestedName.length <= 64 && /^[A-Za-z0-9_-]+$/.test(requestedName)
      ? requestedName
      : workerId;
  // Worker extension allowlist: delegate param -> PI_WORKER_EXTENSIONS ->
  // worker-extensions.json -> default set. Messenger and Gondolin are
  // mandatory; denylisted workflow extensions are rejected outright.
  const requestedExtensions = Array.isArray(params.extensions)
    ? params.extensions.map(String)
    : undefined;
  const resolvedExtensions = resolveWorkerExtensions(requestedExtensions, {
    extensionsRoot: fileURLToPath(new URL("../../../extensions/", import.meta.url)),
  });

  // Every worker routes built-in file and shell tools through Gondolin.
  // Planning workers additionally load the headless plan gate, which
  // reduces active tools to the research allowlist and enforces read-only Bash.
  const extensionPaths = resolvedExtensions.map((extension) => extension.path);
  if (parentPlanning) {
    extensionPaths.push(fileURLToPath(new URL("../../plan/plan.ts", import.meta.url)));
  }

  // Read-only planning workers inspect the parent's current files through
  // Gondolin and never need a branch or patch. Avoid changing git metadata
  // merely to perform research during plan mode.
  const wantIsolate = !parentPlanning && params.isolate !== false;

  return {
    workerId,
    name,
    task,
    model,
    thinkingLevel,
    timeoutMs,
    parentPlanning,
    extensionPaths,
    wantIsolate,
    isolateRequired: params.isolate === true,
    maxWorkers,
    parentSessionId: ctx.sessionManager.getSessionId(),
  };
}

// --- Reservation and spawn ---

/**
 * Per-session worker state owned by the composition root: live children,
 * the session's transcript-derived records, and ids reserved by in-flight
 * delegate calls (checked against the cap before their record exists).
 */
export interface WorkerSessionState {
  /** Live-worker map owned by the composition root for this Pi instance. */
  running: Map<string, RunningWorker>;
  /** The session's own worker records (transcript branch, last-wins). */
  branchWorkers: Map<string, WorkerRecord>;
  /** Worker ids reserved but not yet spawned/recorded, keyed by name. */
  reserved: Map<string, string>;
}

export interface StartDelegatedWorkerOptions {
  cwd: string;
  plan: DelegatePlan;
  /** Per-session worker state (see WorkerSessionState). */
  state: WorkerSessionState;
  /** Lifecycle callbacks (wake, notify, republish) built by the root. */
  events: WorkerEvents;
  /** Persist a state transition (transcript entry + artifact record file).
   *  Returns false when a stale running snapshot lost to a terminal state. */
  persist(record: WorkerRecord): Promise<boolean>;
}

/**
 * Reserve a worker slot, create the worktree when wanted, and spawn the
 * child session. The cap is per session and enforced in-process: the check
 * plus the reservation are synchronous (no await between them), so parallel
 * delegate calls in one session cannot both cross the limit. The
 * reservation precedes the worktree: a refusal (limit, name already taken)
 * must not leave an orphaned worktree behind. If anything fails after the
 * reservation (worktree, spawn), the worker is recorded failed.
 */
export async function startDelegatedWorker(
  options: StartDelegatedWorkerOptions,
): Promise<{ runningWorker: RunningWorker; worktree?: { path: string; branch: string } }> {
  const { cwd, plan, state, events, persist } = options;
  const { workerId, name, task, model, thinkingLevel, timeoutMs, parentPlanning, extensionPaths } =
    plan;

  // Provision preflight first (review D1): a refusal here must burn no slot
  // and create nothing, so it runs before the reservation and the worktree.
  // It only applies when a worktree would be created; plan-mode and
  // non-isolated workers never provision (review I10).
  if (plan.wantIsolate && (await isGitRepo(cwd))) {
    await assertProvisionReady(cwd);
  }

  // Foreign-live names (workers of other live sessions) keep messenger-name
  // collisions unlikely; the check is best-effort (no lock, small race
  // window) because names route mail, not correctness.
  const foreignLive = (await sweepWorkerArtifacts(cwd, new Set(state.branchWorkers.keys())))
    .foreignLive;
  const takenNames = new Set<string>([
    ...state.reserved.values(),
    ...foreignLive.map((w) => w.name),
  ]);
  let runningCount = 0;
  for (const record of state.branchWorkers.values()) {
    if (record.status !== "running") continue;
    runningCount += 1;
    takenNames.add(record.name);
  }
  runningCount += state.reserved.size;
  if (takenNames.has(name)) {
    throw new Error(`A worker named "${name}" is already running.`);
  }
  if (runningCount >= plan.maxWorkers) {
    throw new Error(
      `Worker limit reached (${runningCount}/${plan.maxWorkers}). Wait for a worker to finish or raise PI_MAX_WORKERS.`,
    );
  }
  // Reserve synchronously (no await between check and add): single-threaded,
  // so concurrent delegate calls in this session serialize here.
  state.reserved.set(workerId, name);

  let worktree: { path: string; branch: string } | undefined;
  let runningWorker: RunningWorker | undefined;
  let provisionStatus: ProvisionStatus | undefined;
  try {
    if (plan.wantIsolate) {
      if (!(await isGitRepo(cwd))) {
        if (plan.isolateRequired) {
          throw new Error("isolate=true requires a git repository.");
        }
      } else {
        worktree = await createWorktree(cwd, workerId);
      }
    }

    // Provision the fresh worktree (carry → share → provision under the
    // config lock). A refusal throws after recording the failure below; a
    // non-isolated or planning worker is skipped, never provisioned.
    if (worktree !== undefined) {
      provisionStatus = await provisionWorktree(cwd, worktree, (message) =>
        events.notify("info", message),
      );
    } else {
      provisionStatus = { state: "skipped", detail: "no worktree", at: Date.now() };
    }

    const sandbox = true;
    const readOnly = parentPlanning;

    runningWorker = await startWorker({
      cwd,
      task,
      model,
      thinkingLevel,
      name,
      timeoutMs,
      workerId,
      extensionPaths,
      sandbox,
      readOnly,
      parentPid: process.pid,
      parentSessionId: plan.parentSessionId,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(provisionStatus !== undefined ? { provision: provisionStatus } : {}),
      events,
      onRecord: (worker) => persist(worker).then(() => undefined),
    });
    state.running.set(workerId, runningWorker);
    // Finished fire-and-forget workers leave the map so it tracks only live
    // children. done never rejects; the rejection branch is a no-op guard.
    runningWorker.done.then(
      () => {
        state.running.delete(workerId);
      },
      () => {},
    );
  } catch (error) {
    // Busy: nothing was provisioned into the fresh worktree, so it is
    // discarded here and the failed record carries no worktree (no orphan).
    // Every other failure keeps the worktree ON the record (review B4):
    // remove/prune owns discarding it, together with any partial state.
    if (
      error instanceof ProvisionRefusal &&
      error.provision.state === "busy" &&
      worktree !== undefined
    ) {
      await removeWorktree(cwd, workerId).catch(() => {});
      worktree = undefined;
    }
    // Record the failure so history keeps it; a failed record frees its slot
    // immediately (nothing to reconcile later). A persist failure here must
    // not mask the original spawn error.
    try {
      await persist({
        id: workerId,
        name,
        task,
        model,
        thinkingLevel,
        cwd,
        status: "failed",
        ...(worktree !== undefined ? { worktree: worktree.path, branch: worktree.branch } : {}),
        ...(error instanceof ProvisionRefusal ? { provision: error.provision } : {}),
        parentPid: process.pid,
        parentSessionId: plan.parentSessionId,
        error: error instanceof Error ? error.message : String(error),
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
    } catch {
      // persist already logged the failure; the spawn error propagates below.
    }
    throw error;
  } finally {
    state.reserved.delete(workerId);
  }
  if (!runningWorker) throw new Error("Worker not started; nothing to wait for.");
  // Persist the running record (with the child pid): the transcript entry
  // and the artifact record file make the worker the session's own. The
  // child is already live, so a persistence failure here must not fail the
  // delegate call — persist logs it, the widget still tracks the live child,
  // and the runner's terminal save retries the transcript entry.
  await persist(runningWorker.record).catch(() => {});
  return worktree === undefined ? { runningWorker } : { runningWorker, worktree };
}

// --- Responses ---

/** Fire-and-forget path: the worker started and the parent goes back to work. */
export function buildDelegateStartedResponse(
  plan: Pick<DelegatePlan, "workerId" | "name" | "model" | "parentPlanning">,
  worktree: { path: string; branch: string } | undefined,
  wait: boolean | undefined,
  provision: ProvisionStatus | undefined,
): AgentToolResult {
  const isolateNote = plan.parentPlanning
    ? "Read-only planning worker: Gondolin is enforced and workspace mutation is blocked."
    : worktree
      ? `Isolated in worktree ${worktree.branch}. Its patch is collected with workers (action=collect, id=${plan.workerId}).`
      : "Not isolated: the worker edits this working tree directly.";
  const waitNote = wait === true ? "" : " You will be woken when it exits.";
  const provisionNote =
    provision === undefined
      ? ""
      : ` Provision: ${provision.state}${provision.detail !== undefined ? ` — ${provision.detail}` : ""}.`;

  return {
    content: [
      {
        type: "text",
        text: `Worker ${plan.name} (${plan.workerId}) started on ${plan.model}. ${isolateNote}${waitNote}${provisionNote}`,
      },
    ],
    details: {
      workerId: plan.workerId,
      name: plan.name,
      model: plan.model,
      worktree: worktree?.path,
      ...(provision !== undefined ? { provision } : {}),
    },
  };
}

/** Blocking path: the worker finished and its report is returned inline. */
export function buildDelegateWaitedResponse(record: WorkerRecord): AgentToolResult {
  return {
    content: [{ type: "text", text: formatWorkerStatus(record) }],
    details: { worker: record },
  };
}
