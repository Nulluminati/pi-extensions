import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetupHook } from "../../extensions/agents/src/provision/hook.ts";
import { startWorkerSandbox } from "../../extensions/worker-sandbox/src/client.ts";

vi.mock("../../extensions/worker-sandbox/src/client.ts", () => ({
  startWorkerSandbox: vi.fn(),
}));

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  const cache = temporaryDirectory();
  vi.stubEnv("XDG_CACHE_HOME", cache);
});

describe("bounded worktree setup hook", () => {
  it("executes the script inside the worker sandbox and captures output", async () => {
    const worktree = setupWorktree();
    const client = mockClient();
    client.runShell.mockImplementation(async (_command, options) => {
      options.onData(Buffer.from("setup complete\n"));
      return { exitCode: 0 };
    });
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);

    const result = await runSetupHook(worktree, 5000);
    expect(startWorkerSandbox).toHaveBeenCalledWith(worktree);
    expect(client.runShell).toHaveBeenCalledWith(
      `./${join(CONFIG_DIR_NAME, "provision-worktree")}`,
      expect.objectContaining({ cwd: worktree, timeout: 5 }),
    );
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.detail).toBe("setup complete");
    expect(readFileSync(result.logPath, "utf8")).toBe("setup complete\n");
  });

  it("returns useful evidence when the hook fails without output", async () => {
    const worktree = setupWorktree();
    const client = mockClient();
    client.runShell.mockResolvedValue({ exitCode: 17 });
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const result = await runSetupHook(worktree, 5000);
    expect(result.exitCode).toBe(17);
    expect(result.detail).toMatch(/exit 17.*no output/);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("aborts a hook that exceeds its budget and closes the sandbox", async () => {
    vi.useFakeTimers();
    const worktree = setupWorktree();
    const client = mockClient();
    let started: () => void = () => {};
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.runShell.mockImplementation(async (_command, options) => {
      started();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), {
          once: true,
        });
      });
    });
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const pending = runSetupHook(worktree, 250);
    await executing;
    await vi.advanceTimersByTimeAsync(251);
    const result = await pending;
    expect(result.exitCode).toBe(-1);
    expect(result.detail).toMatch(/aborted after 250ms/);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing or non-executable script before starting a sandbox", async () => {
    const worktree = temporaryDirectory();
    await expect(runSetupHook(worktree, 5000)).rejects.toThrow(/provision-worktree/);
    mkdirSync(join(worktree, CONFIG_DIR_NAME));
    writeFileSync(join(worktree, CONFIG_DIR_NAME, "provision-worktree"), "#!/bin/sh\n", {
      mode: 0o644,
    });
    await expect(runSetupHook(worktree, 5000)).rejects.toThrow(/executable/);
    expect(startWorkerSandbox).not.toHaveBeenCalled();
  });

  it("closes the sandbox after a tool error", async () => {
    const worktree = setupWorktree();
    const client = mockClient();
    client.runShell.mockRejectedValue(new Error("hook crashed"));
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    await expect(runSetupHook(worktree, 5000)).rejects.toThrow(/hook crashed/);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "provision-hook-"));
  roots.push(root);
  return root;
}

function setupWorktree(): string {
  const root = temporaryDirectory();
  mkdirSync(join(root, CONFIG_DIR_NAME));
  const file = join(root, CONFIG_DIR_NAME, "provision-worktree");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(file, 0o755);
  return root;
}

function mockClient() {
  return {
    runTool: vi.fn(),
    runShell: vi.fn(
      async (
        _command: string,
        _options: { onData: (chunk: Buffer) => void; signal?: AbortSignal },
      ) => ({ exitCode: 0 }),
    ),
    close: vi.fn(async () => {}),
  };
}
