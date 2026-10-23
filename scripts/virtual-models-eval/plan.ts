import { MODEL_POOL } from "../../extensions/virtual-models/src/policy.ts";
import { fixtures, TASK_IDS, type TaskId } from "./tasks.ts";

export const ARMS = ["sol", "deepseek", "glm", "jev"] as const;
export type Arm = (typeof ARMS)[number];
export type Role = "main" | "worker";
export interface Options {
  phase: "smoke" | "scored";
  tasks: TaskId[];
  arms: Arm[];
  roles: Role[];
  repetitions: number[];
  outputDir?: string;
  resume?: string;
}
export interface Case {
  id: string;
  role: Role;
  task: TaskId;
  arm: Arm;
  repetition: number;
  parentModel: string;
  workerModel: string;
  requestedParentThinking: "medium";
  requestedWorkerThinking: "high";
  assignment: string;
  prompt: string;
  timeoutMs: number;
}
const selection = (arm: Arm): string => (arm === "jev" ? "virtual-models/jev-v1" : MODEL_POOL[arm]);

export function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      ![
        "--phase",
        "--tasks",
        "--arms",
        "--roles",
        "--repetitions",
        "--output-dir",
        "--resume",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error(`Invalid or duplicate option: ${key}`);
    values.set(key, value);
  }
  const phase = values.get("--phase") ?? "smoke";
  if (phase !== "smoke" && phase !== "scored") throw new Error("phase must be smoke or scored");
  function list<T extends string>(key: string, allowed: readonly T[], defaults: readonly T[]): T[] {
    const requested = values.get(key)?.split(",") ?? [...defaults];
    if (
      new Set(requested).size !== requested.length ||
      requested.some((value) => !allowed.some((entry) => entry === value))
    )
      throw new Error(`Invalid ${key}`);
    return requested.map((value) => {
      const match = allowed.find((entry) => entry === value);
      if (!match) throw new Error(`Invalid ${key}`);
      return match;
    });
  }
  const repetitions = (values.get("--repetitions") ?? "1").split(",").map(Number);
  if (
    new Set(repetitions).size !== repetitions.length ||
    repetitions.some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new Error("Invalid repetitions");
  if (values.has("--resume") && values.has("--output-dir"))
    throw new Error("Use resume or output-dir, not both");
  return {
    phase,
    tasks: list(
      "--tasks",
      TASK_IDS,
      phase === "smoke" && !values.has("--resume") ? ["boundaries"] : TASK_IDS,
    ),
    arms: list("--arms", ARMS, phase === "smoke" && !values.has("--resume") ? ["jev"] : ARMS),
    roles: list("--roles", ["main", "worker"] as const, ["main", "worker"]),
    repetitions,
    ...(values.has("--output-dir") ? { outputDir: values.get("--output-dir") as string } : {}),
    ...(values.has("--resume") ? { resume: values.get("--resume") as string } : {}),
  };
}
export function planCases(options: Options): Case[] {
  const result: Case[] = [];
  for (const role of options.roles)
    for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex++) {
      const task = fixtures.find((entry) => entry.id === options.tasks[taskIndex]);
      if (!task) throw new Error("Unknown fixture");
      const arms = options.arms.filter((arm) => role !== "worker" || ["glm", "jev"].includes(arm));
      for (const repetition of options.repetitions) {
        const offset = (TASK_IDS.indexOf(task.id) + repetition - 1) % Math.max(1, arms.length);
        for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)])
          result.push({
            id: `${role}-${task.id}-${arm}-r${repetition}`,
            role,
            task: task.id,
            arm,
            repetition,
            parentModel: role === "worker" ? MODEL_POOL.sol : selection(arm),
            workerModel: role === "worker" ? selection(arm) : MODEL_POOL.glm,
            requestedParentThinking: "medium",
            requestedWorkerThinking: "high",
            assignment: task.workerPrompt,
            prompt: task.mainPrompt,
            timeoutMs: task.timeoutMs + (role === "worker" ? 180000 : 0),
          });
      }
    }
  if (!result.length) throw new Error("No compatible cases selected");
  return result;
}
export const RUNNER_VERSION = "teop-runner-v2";

export function requiresWorkerIsolation(task: TaskId): boolean {
  return task === "fix" || task === "rename" || task === "diagnosis";
}

export function workerParentPrompt(item: Case): string {
  const writable = requiresWorkerIsolation(item.task);
  return `Use spawn_worker exactly once with wait:true, isolate:${writable}, read_only:${!writable}, timeout_seconds:${Math.floor((item.timeoutMs - 180000) / 1000)}. Keep the configured worker model and extension list. Pass this exact task string, without extra instructions: ${JSON.stringify(item.assignment)}. Use only spawn_worker and workers. Do not use other tools or perform the assignment yourself. If the worker has a patch, use workers action:collect to apply it before your final answer. Do not remove the worker or its artifacts. Do not commit or install packages. Echo the worker's final VIRTUAL_RESULT line exactly once. If the worker fails, report its failure instead of solving the task yourself.`;
}
