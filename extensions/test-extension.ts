// Test extension to validate pi loads extensions correctly

export default async function (pi: any) {
  pi.registerCommand("hello", {
    description: "Say hello to verify extensions are loading",
    async run() {
      pi.appendEntry({
        role: "assistant",
        content: "Hello! The test extension loaded successfully.",
      });
    },
  });
}
