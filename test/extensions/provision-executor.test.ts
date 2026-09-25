import { existsSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreateHttpHooksResult } from "@earendil-works/gondolin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runProvisionCommand,
  type VmLike,
} from "../../extensions/agents/src/provision/executor.ts";
import type { ProvisionRunOptions } from "../../extensions/agents/src/provision/types.ts";

const WORKTREE = "/tmp/provision-test-worktree";
const CACHE_DIR = "/tmp/provision-test-cache";
const NETWORK = ["registry.npmjs.org", "*.npmjs.org"];
const TIMEOUT_MS = 120_000;
const COMMAND = "npm ci";

vi.mock("@earendil-works/gondolin", () => ({
  VM: { create: vi.fn() },
  RealFSProvider: vi.fn(function mockedRealFSProvider(this: { path: string }, hostPath: string) {
    this.path = hostPath;
  }),
  createHttpHooks: vi.fn(),
}));

vi.mock("../../lib/guest-image.ts", () => ({
  resolveGuestImagePath: vi.fn(),
}));

import type { VM as GuestVm } from "@earendil-works/gondolin";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import { resolveGuestImagePath } from "../../lib/guest-image.ts";

describe("provision-executor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("command execution", () => {
    it("runs `cd /workspace && <command>` through the shell shorthand", async () => {
      const fake = createFakeVm();
      await runProvisionCommand(runOptions(), { createVm: () => fake.vmPromise });

      expect(fake.execs).toHaveLength(1);
      expect(fake.execs[0]?.command).toBe("cd /workspace && npm ci");
    });

    it("throws on an empty command without creating a vm", async () => {
      const createVm = vi.fn();

      await expect(runProvisionCommand(runOptions({ command: "" }), { createVm })).rejects.toThrow(
        /empty/i,
      );
      expect(createVm).not.toHaveBeenCalled();
    });

    it("throws on a whitespace-only command without creating a vm", async () => {
      const createVm = vi.fn();

      await expect(
        runProvisionCommand(runOptions({ command: "   \n\t " }), { createVm }),
      ).rejects.toThrow(/empty/i);
      expect(createVm).not.toHaveBeenCalled();
    });

    it("bounds execution with an abort signal derived from timeoutMs", async () => {
      const fake = createFakeVm();
      await runProvisionCommand(runOptions({ timeoutMs: 10 }), {
        createVm: () => fake.vmPromise,
      });

      const signal = execSignal(fake.execs[0]?.options);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      await sleep(100);
      expect(signal?.aborted).toBe(true);
    });
  });

  describe("default vm path", () => {
    it("wires mounts, cache env, and the network allowlist into VM.create", async () => {
      const hooks = createHooksResult({ env: { PROVISION_SECRET: "placeholder" } });
      mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(hooks);

      await runProvisionCommand(runOptions());

      expect(createHttpHooks).toHaveBeenCalledWith({ allowedHosts: NETWORK });

      const createCall = vi.mocked(VM.create).mock.calls[0]?.[0];
      expect(createCall).toBeDefined();
      const mounts = createCall?.vfs?.mounts ?? {};
      expect(mounts["/workspace"]).toBeInstanceOf(RealFSProvider);
      expect(mounts["/cache"]).toBeInstanceOf(RealFSProvider);
      expect(providerPath(mounts["/workspace"])).toBe(WORKTREE);
      expect(providerPath(mounts["/cache"])).toBe(CACHE_DIR);

      expect(createCall?.env).toMatchObject({
        PROVISION_SECRET: "placeholder",
        npm_config_cache: "/cache/npm",
        XDG_CACHE_HOME: "/cache/xdg",
        TMPDIR: "/cache/tmp",
      });
      expect(createCall?.httpHooks).toBe(hooks.httpHooks);
    });

    it("omits allowedHosts when network is undefined (SDK allow-all default)", async () => {
      mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(createHooksResult({}));

      await runProvisionCommand(runOptions({ network: undefined }));

      expect(createHttpHooks).toHaveBeenCalledWith({});
    });

    it("closes the vm after the command completes", async () => {
      const guest = mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(createHooksResult({}));

      await runProvisionCommand(runOptions());

      expect(guest.close).toHaveBeenCalledTimes(1);
    });

    it("creates the host cache dir before booting", async () => {
      mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(createHooksResult({}));
      const tmpBase = mkdtempSync(path.join(os.tmpdir(), "provision-executor-"));
      const cacheDir = path.join(tmpBase, "cache", "nested");
      expect(existsSync(cacheDir)).toBe(false);

      await runProvisionCommand(runOptions({ cacheDir }));

      expect(statSync(cacheDir).isDirectory()).toBe(true);
    });
  });

  describe("guest image", () => {
    it("passes the built custom image as sandbox.imagePath into VM.create", async () => {
      mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(createHooksResult({}));
      vi.mocked(resolveGuestImagePath).mockReturnValue("/cache/pi-gondolin/guest");

      await runProvisionCommand(runOptions());

      const createCall = vi.mocked(VM.create).mock.calls[0]?.[0];
      expect(createCall?.sandbox).toEqual({ imagePath: "/cache/pi-gondolin/guest" });
    });

    it("omits the sandbox key when no custom image is built (SDK default registry image)", async () => {
      mockGuestVm();
      vi.mocked(createHttpHooks).mockReturnValue(createHooksResult({}));
      vi.mocked(resolveGuestImagePath).mockReturnValue(undefined);

      await runProvisionCommand(runOptions());

      const createCall = vi.mocked(VM.create).mock.calls[0]?.[0];
      expect(createCall).toBeDefined();
      expect(createCall).not.toHaveProperty("sandbox");
    });
  });

  describe("result mapping", () => {
    it("maps exit code, output tail, and wall-clock ms", async () => {
      const fake = createFakeVm({
        exitCode: 3,
        stdout: "added 1314 packages\n",
        stderr: "npm warn deprecated old-pkg\nnpm error missing script: build\n",
      });

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.exitCode).toBe(3);
      const combined = `${fake.execResult.stdout}\n${fake.execResult.stderr}`;
      expect(result.detail).toBe(combined.slice(-400).trim());
      expect(result.detail.endsWith("npm error missing script: build")).toBe(true);
      expect(result.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.ms)).toBe(true);
    });

    it("synthesizes a detail for a nonzero exit with empty output", async () => {
      const fake = createFakeVm({ exitCode: 3, stdout: "", stderr: "" });

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.exitCode).toBe(3);
      expect(result.detail).toBe("exit 3 with no output (killed before flush?)");
    });

    it("adds the sandbox-OOM hint to exit 137 with empty output", async () => {
      const fake = createFakeVm({ exitCode: 137, stdout: "", stderr: "" });

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.detail).toBe(
        "exit 137 with no output (killed before flush? exit 137 is typically sandbox OOM)",
      );
    });

    it("keeps an empty detail for a successful run with no output", async () => {
      const fake = createFakeVm({ exitCode: 0, stdout: "", stderr: "" });

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.exitCode).toBe(0);
      expect(result.detail).toBe("");
    });

    it("synthesizes a timeout detail when the exec aborts and closes the vm", async () => {
      const fake = createFakeVm();
      const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
      fake.execThrows(timeout);

      const result = await runProvisionCommand(runOptions({ timeoutMs: 120_000 }), {
        createVm: () => fake.vmPromise,
      });

      expect(result.exitCode).toBe(-1);
      expect(result.detail).toBe("command aborted after 120000ms");
      expect(result.ms).toBeGreaterThanOrEqual(0);
      expect(fake.close).toHaveBeenCalledTimes(1);
    });

    it("treats a generic abort-named exec error as the timeout case", async () => {
      const fake = createFakeVm();
      fake.execThrows(new Error("exec aborted"));

      const result = await runProvisionCommand(runOptions({ timeoutMs: 5_000 }), {
        createVm: () => fake.vmPromise,
      });

      expect(result.detail).toBe("command aborted after 5000ms");
      expect(fake.close).toHaveBeenCalledTimes(1);
    });

    it("bounds detail to the last 400 characters of combined output", async () => {
      const stdout = "a".repeat(600);
      const stderr = "b".repeat(300);
      const fake = createFakeVm({ exitCode: 1, stdout, stderr });

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.detail).toBe(`${"a".repeat(99)}\n${"b".repeat(300)}`);
      expect(result.detail).toHaveLength(400);
    });
  });

  describe("vm teardown", () => {
    it("rejects and closes the vm on a non-abort exec error", async () => {
      const fake = createFakeVm();
      fake.execThrows(new Error("krun guest died"));

      await expect(
        runProvisionCommand(runOptions(), { createVm: () => fake.vmPromise }),
      ).rejects.toThrow("krun guest died");
      expect(fake.close).toHaveBeenCalledTimes(1);
    });

    it("swallows close failures when the command succeeded", async () => {
      const fake = createFakeVm();
      fake.close.mockRejectedValue(new Error("runner already gone"));

      const result = await runProvisionCommand(runOptions(), {
        createVm: () => fake.vmPromise,
      });

      expect(result.exitCode).toBe(0);
      expect(fake.close).toHaveBeenCalledTimes(1);
    });
  });
});

// --- Helpers ---

interface RecordedExec {
  command: string;
  options: unknown;
}

function createFakeVm(
  execResult: Partial<{ exitCode: number; stdout: string; stderr: string }> = {},
): {
  vmPromise: Promise<VmLike>;
  execs: RecordedExec[];
  execResult: { exitCode: number; stdout: string; stderr: string };
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  execThrows: (error: Error) => void;
} {
  const execs: RecordedExec[] = [];
  const execResultFull = { exitCode: 0, stdout: "ok\n", stderr: "", ...execResult };
  let throwFn: (() => never) | undefined;
  const close = vi.fn(async () => {});
  const vm: VmLike = {
    exec: async (command, options) => {
      execs.push({ command, options });
      if (throwFn) throwFn();
      return execResultFull;
    },
    close,
  };
  return {
    vmPromise: Promise.resolve(vm),
    execs,
    execResult: execResultFull,
    close,
    execThrows: (error: Error) => {
      throwFn = () => {
        throw error;
      };
    },
  };
}

type RunOptionOverrides = {
  [K in keyof ProvisionRunOptions]?: ProvisionRunOptions[K] | undefined;
};

function runOptions(overrides: RunOptionOverrides = {}): ProvisionRunOptions {
  const merged = {
    worktree: WORKTREE,
    command: COMMAND,
    network: NETWORK,
    timeoutMs: TIMEOUT_MS,
    cacheDir: CACHE_DIR,
    ...overrides,
  } as RunOptionOverrides;
  for (const key of Object.keys(merged) as (keyof RunOptionOverrides)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as ProvisionRunOptions;
}

function mockGuestVm(): {
  exec: ReturnType<
    typeof vi.fn<() => Promise<{ exitCode: number; stdout: string; stderr: string }>>
  >;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const guest = {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    close: vi.fn(async () => {}),
  };
  vi.mocked(VM.create).mockResolvedValue(guest as unknown as GuestVm);
  return guest;
}

function createHooksResult(overrides: Partial<CreateHttpHooksResult> = {}): CreateHttpHooksResult {
  return {
    httpHooks: {} as CreateHttpHooksResult["httpHooks"],
    env: {},
    allowedHosts: [],
    secretManager: {
      listSecrets: () => [],
      updateSecret: () => {},
      deleteSecret: () => {},
    },
    ...overrides,
  };
}

function execSignal(options: unknown): AbortSignal | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function providerPath(provider: unknown): string | undefined {
  if (typeof provider !== "object" || provider === null) return undefined;
  const path = (provider as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
