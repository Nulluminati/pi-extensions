/** Tool parameter schema for the autoresearch tool. */

import { projectStateRelative } from "../../../lib/paths.ts";

export const AUTORESEARCH_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["init", "run", "log", "status", "stop"],
      description: "Autoresearch operation.",
    },
    objective: {
      type: "string",
      description: "init: what is being optimized and any constraints.",
    },
    metric: { type: "string", description: "init: metric name parsed from measure output." },
    unit: { type: "string", description: "init: optional unit (ms, KB, score)." },
    direction: {
      enum: ["lower", "higher"],
      description: "init: which direction is an improvement.",
    },
    measure: {
      type: "string",
      description:
        "init: shell command that measures the metric. Emit 'METRIC name=value' (or make the last number the value). Must be POSIX-sh compatible (macOS /bin/sh is bash 3.2; avoid GNU-only flags).",
    },
    checks: {
      type: "string",
      description:
        "init: optional correctness gate (tests, typecheck) run before measuring. Must be POSIX-sh compatible (macOS /bin/sh is bash 3.2; avoid GNU-only flags).",
    },
    maxIterations: {
      type: "number",
      description: "init: stop after this many logged experiments.",
    },
    notes: {
      type: "string",
      description: `init: optional guidance recorded in ${projectStateRelative("autoresearch")}/prompt.md.`,
    },
    description: {
      type: "string",
      description: "run/log: what this experiment changes or changed.",
    },
    hypothesis: { type: "string", description: "run: why this should improve the metric." },
    status: {
      enum: ["keep", "discard"],
      description: "log: keep (commit) or discard (revert) the current changes.",
    },
  },
  required: ["action"],
};
