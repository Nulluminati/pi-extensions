/** Tool parameter schema for the messenger tool. */

export const MESSENGER_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      enum: ["whoami", "list", "send", "inbox", "reserve", "release", "status"],
      description: "Messenger operation.",
    },
    to: { type: "string", description: "send: recipient agent name." },
    text: { type: "string", description: "send: message text." },
    status: {
      type: "string",
      description: 'status: short presence line, e.g. "refactoring auth".',
    },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "reserve: project-relative file or directory paths to claim.",
    },
    reason: { type: "string", description: "reserve: why the paths are claimed." },
  },
  required: ["action"],
};
