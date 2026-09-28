import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkerSandbox } from "../../extensions/worker-sandbox/src/client.ts";
import workerSandboxExtension from "../../extensions/worker-sandbox/worker-sandbox.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("../../extensions/worker-sandbox/src/client.ts", () => ({
  startWorkerSandbox: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const names = ["read", "write", "edit", "bash", "ls", "find", "grep"];
  return Object.fromEntries(
    names.map((name) => [
      `create${name[0]?.toUpperCase()}${name.slice(1)}Tool`,
      vi.fn(() => ({ name, label: name, description: name, parameters: {}, execute: vi.fn() })),
    ]),
  );
});

type UserBashResponse = {
  operations: {
    exec(
      command: string,
      cwd: string,
      options: { onData: (chunk: Buffer) => void; timeout?: number },
    ): Promise<{ exitCode: number | null }>;
  };
};

function mockClient() {
  return {
    runTool: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "sandbox result" }],
      details: undefined,
    })),
    runShell: vi.fn(async (_command: string, _options: unknown) => ({ exitCode: 0 })),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("worker sandbox extension", () => {
  it("does not override tools in main sessions", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    await workerSandboxExtension(pi);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("registers all built-in tools and sends their calls to the sandbox", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "ls",
      "find",
      "grep",
    ]);
    const start = getEventHandler(pi, "session_start");
    await start({ type: "session_start", reason: "startup" }, ctx);
    expect(startWorkerSandbox).toHaveBeenCalledWith(ctx.cwd);
    for (const [tool] of pi.registerTool.mock.calls) {
      const result = await tool.execute("call-1", { path: "file.txt" }, undefined, undefined, ctx);
      expect(result).toEqual({
        content: [{ type: "text", text: "sandbox result" }],
        details: undefined,
      });
      expect(client.runTool).toHaveBeenCalledWith(
        tool.name,
        { path: "file.txt" },
        expect.objectContaining({ cwd: ctx.cwd }),
      );
    }
  });

  it("never runs a local tool after sandbox initialization fails", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.mocked(startWorkerSandbox).mockRejectedValue(new Error("socat not installed"));
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    const start = getEventHandler(pi, "session_start");
    await expect(start({ type: "session_start", reason: "startup" }, ctx)).rejects.toThrow(
      /socat not installed/,
    );
    for (const [tool] of pi.registerTool.mock.calls) {
      await expect(
        tool.execute("call-1", { path: "file.txt" }, undefined, undefined, ctx),
      ).rejects.toThrow(/socat not installed/);
    }
    const userBash = getEventHandler(pi, "user_bash");
    const operation = (await userBash(
      { type: "user_bash", command: "echo unsafe" },
      ctx,
    )) as UserBashResponse;
    expect(operation).toHaveProperty("operations.exec");
    await expect(
      operation.operations.exec("echo unsafe", ctx.cwd, { onData: vi.fn() }),
    ).rejects.toThrow(/socat not installed/);
  });

  it("routes user-bash output and exit status through the sandbox", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    const userBash = getEventHandler(pi, "user_bash");
    const operation = (await userBash(
      { type: "user_bash", command: "echo safe" },
      ctx,
    )) as UserBashResponse;
    const onData = vi.fn();
    expect(await operation.operations.exec("echo safe", ctx.cwd, { onData, timeout: 3 })).toEqual({
      exitCode: 0,
    });
    expect(client.runShell).toHaveBeenCalledWith(
      "echo safe",
      expect.objectContaining({ cwd: ctx.cwd, onData, timeout: 3 }),
    );
  });

  it("closes the sandbox on session shutdown and refuses later calls", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    await getEventHandler(pi, "session_shutdown")({ type: "session_shutdown" }, ctx);
    expect(client.close).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls.find(([registered]) => registered.name === "read")?.[0];
    expect(tool).toBeDefined();
    await expect(
      tool?.execute("call-1", { path: "file.txt" }, undefined, undefined, ctx),
    ).rejects.toThrow(/sandbox not ready/);
  });
});
