/** Metadata and parameter schema for the goal_complete tool. */

export const GOAL_COMPLETE_DESCRIPTION =
  "Call this tool when the current goal has been fully completed and verified. Provide a brief summary of what was accomplished.";

export const GOAL_COMPLETE_PROMPT_SNIPPET =
  "Mark the active /goal as complete after fully finishing and verifying it";

export const GOAL_COMPLETE_PROMPT_GUIDELINES = [
  "When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
  "Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
  "Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains.",
];

export const GOAL_COMPLETE_PARAMETERS = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Brief summary of what was accomplished",
    },
  },
};
