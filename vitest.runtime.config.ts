import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/runtime/**/*.test.ts"],
    setupFiles: [],
    // Each runtime test starts real Pi processes. Half the cores and a wide
    // time limit keep the suite stable when other suites share the machine.
    maxWorkers: "50%",
    testTimeout: 90_000,
  },
});
