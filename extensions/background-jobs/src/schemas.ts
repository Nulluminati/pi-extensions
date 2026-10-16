/** Tool parameter schemas for the background-jobs tools. */

import { DEFAULT_MONITOR_INTERVAL_S, DEFAULT_MONITOR_TIMEOUT_S } from "./monitor.ts";

export const BACKGROUND_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to run in the background under /bin/sh.",
    },
    label: {
      type: "string",
      description: "Short label for the job. Defaults to the command's first token.",
    },
    cwd: {
      type: "string",
      description: "Working directory. Defaults to the project root.",
    },
    wake_on_pattern: {
      type: "string",
      description:
        "Regexp. If set, wake early (before exit) the first time any output line matches it.",
    },
    env: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
      patternProperties: {
        "^.*$": { type: "string" },
      },
      description: "Extra environment variables, merged over the inherited environment.",
    },
  },
  required: ["command"],
};

export const MONITOR_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command polled under /bin/sh -c on each tick.",
    },
    satisfy_on: {
      enum: ["exit_zero", "exit_nonzero", "stdout_matches", "stdout_not_matches"],
      description: "Condition that ends the monitor and wakes the agent.",
    },
    pattern: {
      type: "string",
      description: "Regexp required by stdout_matches / stdout_not_matches.",
    },
    interval_seconds: {
      type: "number",
      description: `Poll interval in seconds (minimum 1). Defaults to ${DEFAULT_MONITOR_INTERVAL_S}.`,
    },
    timeout_seconds: {
      type: "number",
      description: `Give up after this many seconds. Defaults to ${DEFAULT_MONITOR_TIMEOUT_S}.`,
    },
    label: {
      type: "string",
      description: "Short label for the monitor.",
    },
  },
  required: ["command", "satisfy_on"],
};

export const JOBS_OUTPUT = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          kind: { type: "string", enum: ["background", "monitor"] },
          label: { type: "string" },
          command: { type: "string" },
          status: { type: "string" },
          startedAt: { type: "number" },
          endedAt: { type: "number" },
          exitCode: { type: ["number", "null"] },
          spoolPath: { type: "string" },
        },
        required: ["id", "kind", "label", "command", "status", "startedAt"],
      },
    },
    output: { type: "string" },
    error: { type: "string" },
  },
  required: ["jobs"],
};

export const JOBS_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["list", "status", "tail", "cancel"],
      description: "Registry operation.",
    },
    jobId: {
      type: "number",
      description: "Job id, required for status / tail / cancel.",
    },
    lines: {
      type: "number",
      description: "Tail line count. Defaults to 40.",
    },
  },
  required: ["action"],
};
