/**
 * Delegate tool behavior: resolves the delegate call's arguments (task,
 * worker name, model, extensions, plan-mode constraints, worktree decision),
 * reserves a worker slot and spawns the child session, and builds the tool
 * responses. The reservation and its failure-release flow are the
 * concurrency-safety core of delegation.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionContext, ThinkingLevel } from "pi";
import { withFileLock } from "../../../lib/file-lock.ts";
import { runGit } from "../../../lib/git.ts";
import { projectStateRelative } from "../../../lib/paths.ts";
import { isPlanModeActive } from "../../../lib/plan-state.ts";
import { resolveWorkerModelSpec } from "../../../lib/worker-model.ts";
import { formatWorkerStatus } from "./format.ts";
import { carryIncludedPaths } from "./provision/carry.ts";
import { assertSetupHook, runSetupHook } from "./provision/hook.ts";
import type { ProvisionStatus } from "./provision/types.ts";
import { type RunningWorker, startWorker } from "./runner.ts";
import { generateWorkerId, sweepWorkerArtifacts } from "./store.ts";
import type { WorkerEvents, WorkerRecord } from "./types.ts";
import { resolveWorkerExtensions } from "./worker-extensions.ts";
import { PROVISION_HOOK_RELATIVE, WORKER_SANDBOX_RELATIVE } from "./worker-sandbox-config.ts";
import { createWorktree, isGitRepo, removeWorktree } from "./worktree.ts";

// --- Constants ---

const DEFAULT_TIMEOUT_MS = 900_000;

/** Fixed message for the path-limited setup-file commit (review D2). */
const SETUP_COMMIT_MESSAGE = "chore(provision): update worktree setup files";
/** Setup budget for one worktree; secret values stay with the project files. */
const SETUP_TIMEOUT_MS = 600_000;
/** Lock waiters return `busy` after the setup budget plus this grace. */
const BUSY_GRACE_MS = 15_000;
/** Refusal when the setup lock stays held past the wait bound. */
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

/** Repo-root-free relative listing of the setup files being checked. */
function setupFileList(): string[] {
  return [PROVISION_HOOK_RELATIVE, WORKER_SANDBOX_RELATIVE];
}

/** Refusal text pointing at the path the model should fix. */
function setupRefusal(reason: string): Error {
  return new Error(
    `provisioned: ${reason}. Fix ${PROVISION_HOOK_RELATIVE} and ${WORKER_SANDBOX_RELATIVE} in the parent checkout, then re-delegate.`,
  );
}

/**
 * Preflight for isolated delegates (review D1): refuse before the slot
 * reservation when the project setup files cannot provision a worktree —
 * hook missing/not executable, sandbox policy absent/invalid, or a dirty
 * tracked setup file that must be path-committed first (review D2). Returns
 * true when preflight committed setup files (rides the provision status).
 */
export async function assertProvisionReady(
  cwd: string,
  notifyInfo: (message: string) => void,
): Promise<boolean> {
  try {
    await assertSetupHook(cwd);
  } catch (error) {
    throw setupRefusal(`none (setup hook missing or not executable: ${oneLine(messageOf(error))})`);
  }
  let policyRaw: unknown;
  const policyText = await readFile(`${cwd}/${WORKER_SANDBOX_RELATIVE}`, "utf8").catch(
    (error: unknown) => {
      throw setupRefusal(`none (sandbox policy missing: ${oneLine(messageOf(error))})`);
    },
  );
  try {
    policyRaw = JSON.parse(policyText);
  } catch {
    throw setupRefusal("invalid (sandbox policy is not JSON)");
  }
  if (
    !policyRaw ||
    typeof policyRaw !== "object" ||
    !("network" in policyRaw) ||
    !("filesystem" in policyRaw)
  ) {
    throw setupRefusal("invalid (sandbox policy needs network and filesystem)");
  }

  // Review D2, pre-gate position: path-commit untracked or modified setup
  // files BEFORE the dirty gate, so the worktree branches from HEAD with
  // the edit in it. A commit failure refuses before any slot or worktree.
  const paths = setupFileList();
  try {
    const status = await runGit(cwd, ["status", "--porcelain", "--", ...paths]);
    if (status.trim() === "") return false;
    await runGit(cwd, ["add", "--", ...paths]);
    await runGit(cwd, ["commit", "-m", SETUP_COMMIT_MESSAGE, "--only", "--", ...paths]);
  } catch (error) {
    throw new ProvisionRefusal(
      {
        state: "failed",
        detail: `setup commit failed: ${oneLine(messageOf(error))}`,
        at: Date.now(),
      },
      `provisioned: setup commit failed (${oneLine(messageOf(error))}). Commit ${paths.join(" and ")} host-side, then re-delegate.`,
    );
  }
  notifyInfo(`Worktree setup files committed (${paths.join(", ")}) so workers branch from it.`);
  return true;
}

/**
 * Populate a fresh worktree: carry `.worktreeinclude` paths, then run the
 * setup hook inside the worker sandbox. Lock-serialized; a lock wait past
 * the budget refuses busy (no spawn, no orphan). Throws ProvisionRefusal;
 * the caller owns worktree cleanup (busy discards, failed keeps it).
 */
async function provisionWorktree(
  cwd: string,
  worktree: { path: string; branch: string },
  _notifyInfo: (message: string) => void,
  setupCommittedAtPreflight: boolean,
): Promise<ProvisionStatus> {
  const detailParts: string[] = [];
  try {
    await withFileLock(
      `${cwd}/${projectStateRelative("worktree-setup")}.lock`,
      async () => {
        const carry = await carryIncludedPaths(cwd, worktree.path);
        detailParts.push(`carry ${carry.carried.length}`);
        const run = await runSetupHook(worktree.path, SETUP_TIMEOUT_MS);
        if (run.exitCode !== 0) {
          const detail = oneLine(run.detail);
          throw new ProvisionRefusal(
            {
              state: "failed",
              detail: detail ? `exit ${run.exitCode}: ${detail}` : `exit ${run.exitCode}`,
              at: Date.now(),
            },
            `provisioned: failed (exit ${run.exitCode})${detail ? `: ${detail}` : ""}. Log: ${run.logPath}. Fix ${PROVISION_HOOK_RELATIVE} or the environment, then re-delegate.`,
          );
        }
        detailParts.push(`hook exit ${run.exitCode} (${Math.round(run.ms / 1000)}s)`);
      },
      {
        timeoutMs: SETUP_TIMEOUT_MS + BUSY_GRACE_MS,
        timeoutMessage: PROVISION_BUSY_MESSAGE,
      },
    );
  } catch (error) {
    if (error instanceof ProvisionRefusal) throw error;
    if (error instanceof Error && error.message === PROVISION_BUSY_MESSAGE) {
      throw new ProvisionRefusal(
        { state: "busy", detail: "lock wait exhausted", at: Date.now() },
        PROVISION_BUSY_MESSAGE,
      );
    }
    throw new ProvisionRefusal(
      { state: "failed", detail: oneLine(messageOf(error)), at: Date.now() },
      `provisioned: failed (${oneLine(messageOf(error))}). Fix ${PROVISION_HOOK_RELATIVE} or the environment, then re-delegate.`,
    );
  }
  if (setupCommittedAtPreflight) detailParts.push("setup committed");
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
  // worker-extensions.json -> default set. Messenger, worker-blocker, and
  // worker-sandbox are mandatory; denylisted workflow extensions are
  // rejected outright.
  const requestedExtensions = Array.isArray(params.extensions)
    ? params.extensions.map(String)
    : undefined;
  const resolvedExtensions = resolveWorkerExtensions(requestedExtensions, {
    extensionsRoot: fileURLToPath(new URL("../../../extensions/", import.meta.url)),
  });

  // Every worker routes built-in file and shell tools through the OS
  // sandbox extension. Planning workers additionally load the headless plan
  // gate, which reduces active tools to the research allowlist.
  const extensionPaths = resolvedExtensions.map((extension) => extension.path);
  if (parentPlanning) {
    extensionPaths.push(fileURLToPath(new URL("../../plan/plan.ts", import.meta.url)));
  }

  // Read-only planning workers inspect the parent's current files through
  // the sandbox and never need a branch or patch. Avoid changing git
  // metadata merely to perform research during plan mode.
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
  // Whether preflight path-committed the config; rides the provision status
  // so the durable response shows the commit fact (field feedback: notify unseen).
  let configCommittedAtPreflight = false;
  const { workerId, name, task, model, thinkingLevel, timeoutMs, parentPlanning, extensionPaths } =
    plan;

  // Provision preflight first (review D1): a refusal here must burn no slot
  // and create nothing, so it runs before the reservation and the worktree.
  // It only applies when a worktree would be created; plan-mode and
  // non-isolated workers never provision (review I10).
  if (plan.wantIsolate && (await isGitRepo(cwd))) {
    configCommittedAtPreflight = await assertProvisionReady(cwd, (message) =>
      events.notify("info", message),
    );
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
      provisionStatus = await provisionWorktree(
        cwd,
        worktree,
        (message) => events.notify("info", message),
        configCommittedAtPreflight,
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
    // The republish is load-bearing: without it the workers widget stays
    // frozen on its last "running" snapshot — header says "N running" over
    // rows whose records have since mutated to "completed".
    runningWorker.done.then(
      () => {
        state.running.delete(workerId);
        events.onChange();
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
    ? "Read-only planning worker: the sandbox is enforced and workspace mutation is blocked."
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
