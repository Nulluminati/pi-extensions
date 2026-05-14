// Time tool — demonstrates registering an LLM-callable tool

export default async function (pi: any) {
  pi.registerTool("getCurrentTime", {
    description: "Get the current date and time in various formats",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "IANA timezone identifier (e.g., 'America/New_York', 'UTC'). Defaults to local time.",
        },
        format: {
          type: "string",
          description: "Output format: 'iso', 'locale', or 'unix'. Defaults to 'locale'.",
          enum: ["iso", "locale", "unix"],
        },
      },
    },
    async run(params: { timezone?: string; format?: string }) {
      const now = new Date();
      const format = params.format || "locale";

      let result: string;
      switch (format) {
        case "iso":
          result = now.toISOString();
          break;
        case "unix":
          result = String(Math.floor(now.getTime() / 1000));
          break;
        case "locale":
        default:
          result = now.toLocaleString(params.timezone ? [params.timezone] : undefined);
          break;
      }

      return { currentTime: result, timezone: params.timezone || "local" };
    },
  });
}
