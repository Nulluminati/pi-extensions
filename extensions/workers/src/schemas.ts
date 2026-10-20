/** Tool parameter schemas for the workers extension. */

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
    extensions: {
      type: "array",
      items: { type: "string" },
      description:
        "Extension names for the worker to load (resolution: this param, then $PI_WORKER_EXTENSIONS, then worker-extensions.json, then the default set). messenger and worker-sandbox are always loaded. Workflow extensions (workers, missions, autoresearch, goal) are forbidden in workers.",
    },
    isolate: {
      type: "boolean",
      description:
        "Run in an isolated git worktree and capture a patch (default true in git repos). Set false only when a writable worker must use the current tree; for investigation use read_only instead.",
    },
    read_only: {
      type: "boolean",
      description:
        "Investigation-only worker: inspect the current workspace with read-only tools and a read-only sandbox. Never create a patch.",
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
} as const;

export const WORKERS_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["list", "status", "tail", "cancel", "collect", "remove"],
      description:
        "Worker registry operation. Lifecycle: only running workers hold a slot — a worker in a terminal state (completed, failed, timeout, cancelled) consumes none; cancel signals a live process, remove is cleanup only, and a fresh spawn_worker relaunches. tail: read the bounded stream tail of a running or finished worker (tool calls, assistant texts) without anything auto-delivering into the conversation. remove: delete a finished worker's record and artifacts (stream spool, patch) and discard its worktree and branch; on an id with no record but a leftover worktree, discards that worktree.",
    },
    id: {
      type: "string",
      description: "Worker id, required for status / tail / cancel / collect / remove.",
    },
    scope: {
      enum: ["mine", "orphans", "all"],
      description:
        "list: which workers to show. mine (default) is this session's own workers. orphans shows artifacts left by ended sessions (collectable). all adds workers running in other live sessions, tagged as foreign.",
    },
    lines: {
      type: "number",
      description: "tail: how many trailing stream entries to show (default 40).",
    },
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
} as const;
