/** Tool parameter schema for the mission tool. Plain JSON Schema, matching
 * the repo convention (see background-jobs/src/schemas.ts). */

export const MISSION_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: [
        "create",
        "status",
        "list",
        "switch",
        "task_add",
        "task_update",
        "task_verify",
        "checkpoint",
        "decision",
        "set_budget",
        "spend",
        "set_status",
        "reconcile",
      ],
      description: "Mission operation.",
    },
    title: { type: "string", description: "create: short mission title." },
    objective: {
      type: "string",
      description: "create: full objective — what done means, constraints, and success criteria.",
    },
    id: { type: "string", description: "switch: mission id to make active." },
    taskId: { type: "string", description: "task_update / task_verify: target task id." },
    taskTitle: { type: "string", description: "task_add: task title." },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description: "task_add: task ids that must be done before this one.",
    },
    owner: {
      type: "string",
      description: 'task_add / task_update: owner, e.g. "main" or "worker:<name>".',
    },
    status: {
      enum: ["todo", "in_progress", "blocked", "done", "failed", "regressed"],
      description: "task_update: new task status. done requires summary.",
    },
    summary: {
      type: "string",
      description: "task_update (required for done) / checkpoint: what was delivered or captured.",
    },
    verification: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command that must exit 0." },
        description: { type: "string", description: "What the command proves." },
      },
      required: ["command"],
      description:
        "task_add / task_verify: executable proof for a task. Omit to clear (task_verify).",
    },
    label: { type: "string", description: "checkpoint: short label." },
    commit: { type: "string", description: "checkpoint: optional git commit id." },
    text: { type: "string", description: "decision: the decision and its rationale." },
    maxIterations: { type: "number", description: "set_budget: iteration cap." },
    maxTokens: { type: "number", description: "set_budget: token cap." },
    iterations: { type: "number", description: "spend: iterations to add." },
    tokens: { type: "number", description: "spend: tokens to add." },
    missionStatus: {
      enum: ["planning", "active", "paused", "complete", "aborted"],
      description: "set_status: new mission status. complete requires every task done or failed.",
    },
  },
  required: ["action"],
};
