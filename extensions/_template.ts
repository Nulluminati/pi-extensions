// Template for new pi extensions
// Copy this file to extensions/<descriptive-name>.ts and implement your extension.

export default async function (pi: any) {
  // Example: register a tool callable by the LLM
  // pi.registerTool("myTool", {
  //   description: "Describe what this tool does",
  //   parameters: {
  //     type: "object",
  //     properties: {
  //       input: { type: "string", description: "The input to process" },
  //     },
  //     required: ["input"],
  //   },
  //   async run(params: any) {
  //     return { result: `Processed: ${params.input}` };
  //   },
  // });

  // Example: register a slash command
  // pi.registerCommand("myCommand", {
  //   description: "Describe what this command does",
  //   async run() {
  //     pi.appendEntry({
  //       role: "assistant",
  //       content: "Hello from my extension!",
  //     });
  //   },
  // });

  // Example: hook a lifecycle event
  // pi.on("beforeToolCall", async (toolCall: any) => {
  //   console.log("About to call tool:", toolCall.name);
  // });
}
