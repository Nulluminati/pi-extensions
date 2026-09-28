import { fileURLToPath } from "node:url";

export const SandboxManager = {
  async initialize(policy) {
    if (policy.network.allowedDomains.includes("reject-in-test")) {
      throw new Error("test sandbox initialization failed");
    }
  },
  async wrapWithSandboxArgv() {
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
