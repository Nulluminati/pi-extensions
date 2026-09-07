/** Tool parameter schema for the evals tool. */

export const EVALS_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["list", "run", "report"],
      description: "Eval operation.",
    },
    taskId: {
      type: "string",
      description:
        "run: run a single task by id (see action=list). Omit with all=true for the whole suite.",
    },
    all: { type: "boolean", description: "run: run every built-in task sequentially." },
    model: {
      type: "string",
      description:
        "run: model under test as provider/id. Defaults to $PI_EVAL_MODEL or the session default.",
    },
    repeats: {
      type: "number",
      description: "run: repeat each task N times (default 1) to smooth variance.",
    },
  },
  required: ["action"],
};
