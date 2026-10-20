/**
 * Mission tool actions
 *
 * Implementations of the `mission` tool's actions: create, list, switch,
 * status, task graph updates, checkpoints, decisions, budget, spend, status
 * changes, and reconciliation. The composition root owns the per-instance
 * active-mission pointer and the UI wiring; this module touches that state
 * only through the explicit `MissionActionDeps` contract.
 */

// --- Imports ---
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execPlatformHint, runExec } from "../../../lib/exec.ts";
import { findNewestCustomEntry } from "../../../lib/session-utils.ts";
import {
  formatMissionStatus,
  formatMissionSummaries,
  formatReconcileReport,
  formatSkippedMissions,
} from "./format.ts";
import {
  addCheckpoint,
  addDecision,
  addSpend,
  addTask,
  createMission,
  reconcileMission,
  requireOpen,
  setBudget,
  setStatus,
  setTaskVerification,
  updateTask,
  type VerificationRunner,
} from "./ops.ts";
import {
  generateMissionId,
  listMissionSummaries,
  loadMission,
  saveMission,
  validateMissionId,
} from "./storage.ts";
import type { Mission, MissionStatus, TaskStatus, TaskVerification } from "./types.ts";

// --- Constants ---

/** Custom entry type carrying this session's active mission id (newest wins;
 * `{ id: undefined }` clears). Session state, not project state: two
 * sessions may each work their own active mission. */
export const MISSION_ACTIVE_ENTRY_TYPE = "missions-active";

// --- Types ---

/** Raw mission tool parameters as received from the model; fields are
 * narrowed at runtime against MISSION_PARAMETERS (see schemas.ts). */
export type MissionToolParams = Record<string, unknown>;

/** The session's active-mission pointer, split into its two effects: the
 * in-memory cache every tool call consults, and the session-transcript
 * entry that makes the pointer survive restarts. Owned by the composition
 * root; actions read and mutate it only through this interface. */
export interface ActiveMissionRef {
  /** Cached active mission, or undefined. */
  get(): Mission | undefined;
  /** Assign the cached active mission (no transcript write). */
  set(mission: Mission | undefined): void;
  /** Record which mission this session is working (session transcript, not
   * project state — two sessions may each hold their own active mission). */
  record(id: string | undefined): void;
}

/** Everything the mission actions need from the composition root, passed
 * explicitly so this module holds no per-instance state of its own. */
export interface MissionActionDeps {
  /** The session's active-mission pointer. */
  mission: ActiveMissionRef;
  /** Refresh the footer status line, editor widget, and state event. */
  publish(ctx: ExtensionContext): void;
  /** Save a mission to disk, update the cached active mission, and publish. */
  persist(ctx: ExtensionContext, mission: Mission): Promise<void>;
  /** Re-read the session's active mission from the transcript and disk. */
  reload(ctx: ExtensionContext): Promise<Mission | undefined>;
  /** Runs verification commands for reconcile. */
  runner: VerificationRunner;
}

// --- Verification runner ---

/** Exec-backed verification runner, bounded to two minutes and 1 MiB of
 * output per verification command. */
export function createExecVerificationRunner(): VerificationRunner {
  return {
    async run(command, cwd) {
      const result = await runExec(command, { cwd, timeoutMs: 120_000, maxBuffer: 1024 * 1024 });
      if (result.ok) return { ok: true, output: "verification command passed" };
      const output = [result.stdout, result.stderr, result.error, execPlatformHint()]
        .filter(Boolean)
        .join("\n")
        .trim();
      return { ok: false, output: output || "verification command failed" };
    },
  };
}

// --- Session pointer ---

/** The session's active mission, or undefined. Reads the newest
 * missions-active entry from the session branch and loads that mission
 * from disk; a dangling id (mission file deleted) degrades to none. */
export async function loadSessionActiveMission(
  ctx: ExtensionContext,
): Promise<Mission | undefined> {
  const branch = (ctx.sessionManager.getBranch() ?? []) as Array<{
    type?: string;
    customType?: string;
    data?: { id?: unknown };
  }>;
  const entry = findNewestCustomEntry(branch, MISSION_ACTIVE_ENTRY_TYPE);
  const data = entry?.data as { id?: unknown } | undefined;
  const id = typeof data?.id === "string" ? data.id : undefined;
  if (!id) return undefined;
  try {
    return await loadMission(ctx.cwd, id);
  } catch (error) {
    // Corrupt mission file: degrade to no active mission rather than
    // breaking session startup; the corruption surfaces on explicit reads.
    console.error(`[missions] active mission ${id} unreadable: ${(error as Error).message}`);
    // The degradation silences the session's active mission; tell the user
    // when a UI can show it. Outside the UI the log line is the only record.
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Active mission ${id} is unreadable and was deactivated: ${(error as Error).message}`,
        "warning",
      );
    }
    return undefined;
  }
}

// --- Parameter narrowing ---

/** Optional array-of-strings parameter (schema: dependsOn); undefined when
 * absent, a usage error otherwise so malformed task ids cannot slip through
 * to ops. */
function dependsOnParam(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("dependsOn must be an array of task ids.");
  }
  return value;
}

/** Optional TaskVerification parameter (schema: { command, description? });
 * undefined when absent, a usage error when malformed so ops never sees a
 * verification without a command. */
function verificationParam(value: unknown): TaskVerification | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { command?: unknown }).command !== "string"
  ) {
    throw new Error("verification must be an object with a command string.");
  }
  const { command, description } = value as { command: string; description?: unknown };
  return {
    command,
    ...(typeof description === "string" ? { description } : {}),
  };
}

/** The schema's missionStatus enum, narrowed; a usage error otherwise so a
 * garbage status never reaches the mission record. */
function missionStatusParam(value: unknown): MissionStatus {
  if (
    value === "planning" ||
    value === "active" ||
    value === "paused" ||
    value === "complete" ||
    value === "aborted"
  ) {
    return value;
  }
  throw new Error(
    "set_status requires missionStatus (planning, active, paused, complete, or aborted).",
  );
}

// --- Guards ---

/** The active mission, or a usage error directing the agent to create or
 * switch to one. */
function requireActiveMission(mission: Mission | undefined): Mission {
  if (!mission) {
    throw new Error(
      "No active mission. Use the mission tool (action=create) to create one, or action=switch to select one.",
    );
  }
  return mission;
}

// --- Actions ---

/** Execute one `mission` tool action. Throws an Error with a user-readable
 * message on invalid usage; Pi turns those into tool errors. */
export async function executeMissionAction(
  deps: MissionActionDeps,
  params: MissionToolParams,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const action = params.action;

  if (action === "create") {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const objective = typeof params.objective === "string" ? params.objective.trim() : "";
    if (!title) throw new Error("create requires title.");
    if (!objective) throw new Error("create requires objective.");
    if (deps.mission.get()) {
      throw new Error(
        "An active mission already exists. Complete, abort, or switch missions before creating a new one.",
      );
    }
    const mission = createMission(generateMissionId(), title, objective, {
      ...(typeof params.maxIterations === "number" ? { maxIterations: params.maxIterations } : {}),
      ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
    });
    await saveMission(ctx.cwd, mission);
    deps.mission.record(mission.id);
    deps.mission.set(mission);
    deps.publish(ctx);
    return {
      content: [{ type: "text", text: `Created ${mission.id}. ${formatMissionStatus(mission)}` }],
      details: { missionId: mission.id },
    };
  }

  if (action === "list") {
    const { summaries, skipped } = await listMissionSummaries(ctx.cwd);
    return {
      content: [
        { type: "text", text: formatMissionSummaries(summaries) + formatSkippedMissions(skipped) },
      ],
      details: { count: summaries.length, skipped },
    };
  }

  if (action === "switch") {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) throw new Error("switch requires id.");
    validateMissionId(id);
    const mission = await loadMission(ctx.cwd, id);
    if (!mission) throw new Error(`No mission found with id ${id}.`);
    deps.mission.record(mission.id);
    deps.mission.set(mission);
    deps.publish(ctx);
    return {
      content: [
        { type: "text", text: `Switched to ${mission.id}. ${formatMissionStatus(mission)}` },
      ],
      details: { missionId: mission.id },
    };
  }

  if (action === "status") {
    await deps.reload(ctx);
    const mission = requireActiveMission(deps.mission.get());
    return {
      content: [{ type: "text", text: formatMissionStatus(mission) }],
      details: { missionId: mission.id, status: mission.status },
    };
  }

  // Everything below operates on the active mission.
  const mission = requireActiveMission(deps.mission.get());

  switch (action) {
    case "task_add": {
      requireOpen(mission);
      const title = typeof params.taskTitle === "string" ? params.taskTitle.trim() : "";
      if (!title) throw new Error("task_add requires taskTitle.");
      const dependsOn = dependsOnParam(params.dependsOn);
      const verification = verificationParam(params.verification);
      const task = addTask(mission, {
        title,
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...(typeof params.owner === "string" ? { owner: params.owner } : {}),
        ...(verification !== undefined ? { verification } : {}),
      });
      await deps.persist(ctx, mission);
      return {
        content: [{ type: "text", text: `Added ${task.id}: ${task.title}` }],
        details: { taskId: task.id },
      };
    }
    case "task_update": {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) throw new Error("task_update requires taskId.");
      const task = updateTask(mission, {
        taskId,
        // updateTask validates the raw string against the task statuses.
        ...(typeof params.status === "string" ? { status: params.status as TaskStatus } : {}),
        ...(typeof params.summary === "string" ? { summary: params.summary } : {}),
        ...(typeof params.owner === "string" ? { owner: params.owner } : {}),
      });
      await deps.persist(ctx, mission);
      return {
        content: [{ type: "text", text: `${task.id} is now ${task.status}.` }],
        details: { taskId: task.id, status: task.status },
      };
    }
    case "task_verify": {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) throw new Error("task_verify requires taskId.");
      const task = setTaskVerification(mission, taskId, verificationParam(params.verification));
      await deps.persist(ctx, mission);
      return {
        content: [
          {
            type: "text",
            text: task.verification
              ? `${task.id} verification: ${task.verification.command}`
              : `${task.id} verification cleared.`,
          },
        ],
        details: { taskId: task.id },
      };
    }
    case "checkpoint": {
      const label = typeof params.label === "string" ? params.label.trim() : "";
      if (!label) throw new Error("checkpoint requires label.");
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      if (!summary) throw new Error("checkpoint requires summary.");
      const { id } = addCheckpoint(
        mission,
        label,
        summary,
        typeof params.commit === "string" ? params.commit : undefined,
      );
      await deps.persist(ctx, mission);
      return {
        content: [{ type: "text", text: `Checkpoint ${id} recorded.` }],
        details: { checkpointId: id },
      };
    }
    case "decision": {
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) throw new Error("decision requires text.");
      addDecision(mission, text);
      await deps.persist(ctx, mission);
      return { content: [{ type: "text", text: "Decision recorded." }], details: {} };
    }
    case "set_budget": {
      const budget = setBudget(mission, {
        ...(typeof params.maxIterations === "number"
          ? { maxIterations: params.maxIterations }
          : {}),
        ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
      });
      await deps.persist(ctx, mission);
      return {
        content: [{ type: "text", text: `Budget: ${JSON.stringify(budget)}` }],
        details: { budget },
      };
    }
    case "spend": {
      const iterations = typeof params.iterations === "number" ? params.iterations : undefined;
      const tokens = typeof params.tokens === "number" ? params.tokens : undefined;
      if (iterations === undefined && tokens === undefined) {
        throw new Error("spend requires iterations and/or tokens.");
      }
      const { overBudget, spent } = addSpend(mission, iterations, tokens);
      await deps.persist(ctx, mission);
      return {
        content: [
          {
            type: "text",
            text: overBudget
              ? `Spend recorded: ${JSON.stringify(spent)}. OVER BUDGET — report this to the user.`
              : `Spend recorded: ${JSON.stringify(spent)}.`,
          },
        ],
        details: { spent, overBudget },
      };
    }
    case "set_status": {
      const status = missionStatusParam(params.missionStatus);
      // requireOpen is deliberately NOT called here: reopening a paused,
      // completed, or aborted mission is allowed.
      setStatus(mission, status);
      await deps.persist(ctx, mission);
      if (status === "complete" || status === "aborted") {
        // Completed and aborted missions free this session's active slot —
        // otherwise they block every future create in this session.
        deps.mission.record(undefined);
        deps.mission.set(undefined);
        deps.publish(ctx);
      } else {
        // Non-terminal statuses keep the session pointer in lockstep with
        // the in-memory active mission.
        deps.mission.record(mission.id);
      }
      return {
        content: [{ type: "text", text: `Mission is now ${status}.` }],
        details: { status },
      };
    }
    case "reconcile": {
      const report = await reconcileMission(mission, ctx.cwd, deps.runner);
      await deps.persist(ctx, mission);
      return {
        content: [{ type: "text", text: formatReconcileReport(report) }],
        details: { report },
      };
    }
    default:
      throw new Error(`Unknown mission action: ${String(action)}`);
  }
}
