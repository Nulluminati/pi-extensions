import { fileURLToPath } from "node:url";

export const SandboxManager = {
  async initialize(policy) {
    if (policy.network.allowedDomains.includes("reject-in-test")) {
      throw new Error("test sandbox initialization failed");
    }
  },
  async wrapWithSandboxArgv() {
    // Test hook: slow the wrap so a cancel can arrive while it is pending,
    // which is the window the broker must not drop.
    const delay = Number(process.env.PI_TEST_WRAP_DELAY_MS ?? "0");
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return {
      argv: [
        process.execPath,
        "--import",
        fileURLToPath(new URL("./worker-sandbox-loader.mjs", import.meta.url)),
        fileURLToPath(new URL("../../extensions/worker-sandbox/src/tool-child.mjs", import.meta.url)),
      ],
    };
  },
  getLinuxHttpSocketPath() {
    return undefined;
  },
  getLinuxSocksSocketPath() {
    return undefined;
  },
  async reset() {},
};
