import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/runtime/**", "node_modules/**", ".pi/worktrees/**"],
    setupFiles: [
      "./test/setup/worker-env.ts",
      "./test/setup/pi-tui.ts",
      "./test/setup/pi-coding-agent.ts",
    ],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["extensions/**/*.ts", "lib/**/*.ts"],
      exclude: ["test/**", "scripts/**", "types/**"],
      thresholds: {
        lines: 75,
        branches: 65,
        functions: 75,
      },
    },
  },
});
