/**
 * Delegate tool behavior: resolves the delegate call's arguments (task,
 * worker name, model, extensions, plan-mode constraints, worktree decision),
 * reserves a worker slot and spawns the child session, and builds the tool
 * responses. The reservation and its failure-release flow are the
 * concurrency-safety core of delegation.
 */

import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionContext, ThinkingLevel } from "pi";
import { isPlanModeActive } from "../../../lib/plan-state.ts";
import { resolveWorkerModelSpec } from "../../../lib/worker-model.ts";
import { formatWorkerStatus } from "./format.ts";
import { type RunningWorker, startWorker } from "./runner.ts";
import { generateWorkerId, reserveWorkerSlot, saveWorker } from "./store.ts";
import type { WorkerEvents, WorkerRecord } from "./types.ts";
import { resolveWorkerExtensions } from "./worker-extensions.ts";
import { createWorktree, isGitRepo } from "./worktree.ts";

// --- Constants ---

const DEFAULT_TIMEOUT_MS = 900_000;

function envMaxWorkers(): number {
  const parsed = Number.parseInt(process.env.PI_MAX_WORKERS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function envTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.PI_WORKER_TIMEOUT_S ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_TIMEOUT_MS;
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

  // La limite et l'unicité du nom sont tenues dans une section
  // verrouillée et le record running est écrit AVANT le spawn : deux
  // sessions qui délèguent en même temps ne peuvent pas franchir toutes
  // deux la limite (le check-then-spawn d'avant perdait ce genre de
  // course, et un worktree créé pour rien restait orphelin).
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
  };
}

// --- Reservation and spawn ---

export interface StartDelegatedWorkerOptions {
  cwd: string;
  plan: DelegatePlan;
  /** Live-worker map owned by the composition root for this Pi instance. */
  running: Map<string, RunningWorker>;
  /** Lifecycle callbacks (wake, notify, republish) built by the root. */
  events: WorkerEvents;
}

/**
 * Reserve a worker slot, create the worktree when wanted, and spawn the
 * child session. The slot reservation precedes the worktree: a refusal
 * (limit, name already taken) must not leave an orphaned worktree behind.
 * Returns the spawned worker and its worktree (when isolated).
 */
export async function startDelegatedWorker(
  options: StartDelegatedWorkerOptions,
): Promise<{ runningWorker: RunningWorker; worktree?: { path: string; branch: string } }> {
  const { cwd, plan, running, events } = options;
  const { workerId, name, task, model, thinkingLevel, timeoutMs, parentPlanning, extensionPaths } =
    plan;

  let worktree: { path: string; branch: string } | undefined;
  let runningWorker: RunningWorker | undefined;
  // La réservation précède la création du worktree : un refus (limite,
  // nom déjà pris) ne doit pas laisser un arbre de travail orphelin. Si
  // quoi que ce soit échoue après la réservation (worktree, spawn), le
  // slot est libéré en marquant le record failed.
  try {
    await reserveWorkerSlot(
      cwd,
      {
        id: workerId,
        name,
        task,
        model,
        thinkingLevel,
        cwd,
        status: "running",
        startedAt: Date.now(),
      },
      plan.maxWorkers,
    );
    if (plan.wantIsolate) {
      if (!(await isGitRepo(cwd))) {
        if (plan.isolateRequired) {
          throw new Error("isolate=true requires a git repository.");
        }
      } else {
        worktree = await createWorktree(cwd, workerId);
      }
    }

    const sandbox = true;
    const readOnly = parentPlanning;

    runningWorker = startWorker({
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
      ...(worktree !== undefined ? { worktree } : {}),
      events,
      onRecord: (worker) => saveWorker(cwd, worker),
    });
    running.set(workerId, runningWorker);
    // Finished fire-and-forget workers leave the map so it tracks only live
    // children. done never rejects; the rejection branch is a no-op guard.
    runningWorker.done.then(
      () => {
        running.delete(workerId);
      },
      () => {},
    );
    // Persist the running record (with the child pid): the reservation has
    // already landed, this save adds the pid and the model fields.
    await saveWorker(cwd, runningWorker.record);
  } catch (error) {
    // Libérer le slot : un record failed libère la place au prochain
    // reconcile, au lieu de laisser un running fantôme bloquer la limite.
    await saveWorker(cwd, {
      id: workerId,
      name,
      task,
      model,
      thinkingLevel,
      cwd,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    throw error;
  }
  if (!runningWorker) throw new Error("Worker not started; nothing to wait for.");
  return worktree === undefined ? { runningWorker } : { runningWorker, worktree };
}

// --- Responses ---

/** Fire-and-forget path: the worker started and the parent goes back to work. */
export function buildDelegateStartedResponse(
  plan: Pick<DelegatePlan, "workerId" | "name" | "model" | "parentPlanning">,
  worktree: { path: string; branch: string } | undefined,
  wait: boolean | undefined,
): AgentToolResult {
  const isolateNote = plan.parentPlanning
    ? "Read-only planning worker: Gondolin is enforced and workspace mutation is blocked."
    : worktree
      ? `Isolated in worktree ${worktree.branch}. Its patch is collected with workers (action=collect, id=${plan.workerId}).`
      : "Not isolated: the worker edits this working tree directly.";
  const waitNote = wait === true ? "" : " You will be woken when it exits.";

  return {
    content: [
      {
        type: "text",
        text: `Worker ${plan.name} (${plan.workerId}) started on ${plan.model}. ${isolateNote}${waitNote}`,
      },
    ],
    details: {
      workerId: plan.workerId,
      name: plan.name,
      model: plan.model,
      worktree: worktree?.path,
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
