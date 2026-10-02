import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/runtime/**/*.test.ts"],
    setupFiles: [],
    testTimeout: 30_000,
  },
});
