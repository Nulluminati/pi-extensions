/** Tool parameter schemas for the agents extension. */

export const DELEGATE_PARAMETERS = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "Self-contained task for the worker. Include the goal, relevant file paths, constraints, and how to verify the result — the worker sees nothing else from this conversation.",
    },
    name: {
      type: "string",
      description: "Short worker name for messaging (defaults to worker-<id>).",
    },
    model: {
      type: "string",
      description:
        'Model for the worker as provider/id. Resolution: this parameter, then $PI_WORKER_MODEL or worker-model.json; "main" inherits the session model. Unconfigured delegates fail with a descriptive error.',
    },
    isolate: {
      type: "boolean",
      description:
        "Run in an isolated git worktree and capture a patch (default true in git repos). Set false only for read-only tasks.",
    },
    wait: {
      type: "boolean",
      description: "Block until the worker finishes and return its report inline (default false).",
    },
    timeout_seconds: {
      type: "number",
      description: "Hard timeout for the worker (default 900).",
    },
  },
  required: ["task"],
};

export const WORKERS_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["list", "status", "cancel", "collect"],
      description: "Worker registry operation.",
    },
    id: { type: "string", description: "Worker id, required for status / cancel / collect." },
    apply: {
      type: "boolean",
      description: "collect: apply the worker's patch to the working tree (default true).",
    },
    cleanup: {
      type: "boolean",
      description: "collect: remove the worktree and branch after collecting (default true).",
    },
  },
  required: ["action"],
};
