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
  const tools = [
    ["Read", "read"],
    ["Write", "write"],
    ["Edit", "edit"],
    ["Bash", "bash"],
    ["Ls", "ls"],
    ["Find", "find"],
    ["Grep", "grep"],
  ];
  return Object.fromEntries(
    tools.map(([capitalized, name]) => [
      `create${capitalized}ToolDefinition`,
      vi.fn((_cwd: string) => ({
        name,
        label: `${name} (full definition)`,
        description: `${name} description`,
        promptSnippet: `${name} prompt snippet`,
        promptGuidelines: [`Prefer ${name} over host execution.`],
        parameters: { type: "object", properties: {} },
        renderCall: vi.fn(() => `${name} call`),
        renderResult: vi.fn(() => `${name} result`),
        execute: vi.fn(async () => ({
          content: [{ type: "text" as const, text: `host ${name} execution` }],
          details: undefined,
        })),
      })),
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
    const ctx = createMockCommandContext();
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(startWorkerSandbox).not.toHaveBeenCalled();
    expect(
      await getEventHandler(pi, "user_bash")({ type: "user_bash", command: "pwd" }, ctx),
    ).toBeUndefined();
    expect(
      await getEventHandler(pi, "tool_call")(
        { type: "tool_call", toolCallId: "bg", toolName: "background", input: { command: "pwd" } },
        ctx,
      ),
    ).toBeUndefined();
  });

  it("registers a main-session policy flag and routes tools when supplied", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    const raw = JSON.stringify({ network: { allowedDomains: [] }, filesystem: { allowWrite: [] } });
    pi.getFlag.mockImplementation((name) => (name === "sandbox" ? raw : undefined));
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    expect(pi.registerFlag).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ type: "string" }),
    );
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(startWorkerSandbox).toHaveBeenCalledWith(ctx.cwd, raw);
    const tool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "write")?.[0];
    expect(
      await tool?.execute("write-1", { path: "/review/result" }, undefined, undefined, ctx),
    ).toEqual({
      content: [{ type: "text", text: "sandbox result" }],
      details: undefined,
    });
    const gate = getEventHandler(pi, "tool_call");
    expect(
      await gate(
        {
          type: "tool_call",
          toolCallId: "bg",
          toolName: "background",
          input: { command: "touch /outside" },
        },
        ctx,
      ),
    ).toMatchObject({ block: true });
    expect(
      await gate(
        {
          type: "tool_call",
          toolCallId: "web",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        },
        ctx,
      ),
    ).toBeUndefined();
    for (const toolName of [
      "web_search",
      "context7_resolve_library_id",
      "context7_get_library_docs",
      "context7_get_cached_doc_raw",
      "code_search",
    ]) {
      expect(
        await gate({ type: "tool_call", toolCallId: toolName, toolName, input: {} }, ctx),
      ).toBeUndefined();
    }
  });

  it("reads CLI flags at session start after Pi parses extension options", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    await workerSandboxExtension(pi);
    pi.getFlag.mockReturnValue("late inline policy");
    const ctx = createMockCommandContext();
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(startWorkerSandbox).toHaveBeenCalledWith(ctx.cwd, "late inline policy");
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toContain("write");
  });

  it("keeps main-session tools blocked after an invalid inline policy fails", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    pi.getFlag.mockReturnValue("invalid JSON");
    vi.mocked(startWorkerSandbox).mockRejectedValue(new Error("Invalid --sandbox JSON"));
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await expect(
      getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx),
    ).rejects.toThrow("Invalid --sandbox JSON");
    for (const [tool] of pi.registerTool.mock.calls) {
      await expect(tool.execute("blocked", {}, undefined, undefined, ctx)).rejects.toThrow(
        "Invalid --sandbox JSON",
      );
    }
  });

  it("does not let a worker replace its project policy with the main-session flag", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const pi = createMockPi();
    pi.getFlag.mockReturnValue("weaker main policy");
    const client = mockClient();
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(startWorkerSandbox).toHaveBeenCalledWith(ctx.cwd);
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
      // Full built-in definition metadata and renderers survive the execute replacement.
      expect(tool.label).toBe(`${tool.name} (full definition)`);
      expect(tool.promptSnippet).toBe(`${tool.name} prompt snippet`);
      expect(tool.promptGuidelines).toEqual([`Prefer ${tool.name} over host execution.`]);
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
      const result = await tool.execute("call-1", { path: "file.txt" }, undefined, undefined, ctx);
      // The definition's own execute would answer "host ... execution"; the
      // registered tool must route to the sandbox instead.
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

  it.each(["worker", "main"])(
    "routes %s user-bash output and exit status through the sandbox",
    async (mode) => {
      vi.stubEnv("PI_WORKER", mode === "worker" ? "1" : "");
      const client = mockClient();
      vi.mocked(startWorkerSandbox).mockResolvedValue(client);
      const pi = createMockPi();
      if (mode === "main") pi.getFlag.mockReturnValue("inline policy");
      const ctx = createMockCommandContext();
      await workerSandboxExtension(pi);
      await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
      const userBash = getEventHandler(pi, "user_bash");
      const operation = (await userBash(
        { type: "user_bash", command: "echo safe" },
        ctx,
      )) as UserBashResponse;
      const onData = vi.fn();
      expect(await operation.operations.exec("echo safe", ctx.cwd, { onData, timeout: 3 })).toEqual(
        {
          exitCode: 0,
        },
      );
      expect(client.runShell).toHaveBeenCalledWith(
        "echo safe",
        expect.objectContaining({ cwd: ctx.cwd, onData, timeout: 3 }),
      );
    },
  );

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

  it("runs claimed exec requests in the session sandbox with bounded output", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    pi.getFlag.mockImplementation((name) => (name === "sandbox" ? "{}" : undefined));
    const client = mockClient();
    client.runShell.mockImplementation(async (_command, options) => {
      (options as { onData(chunk: Buffer): void }).onData(Buffer.from("0123456789"));
      return { exitCode: 3 };
    });
    vi.mocked(startWorkerSandbox).mockResolvedValue(client);
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    const outcome = await execRequest(pi, { maxOutputBytes: 4 });
    expect(client.runShell).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ cwd: "/workspace", timeout: 2 }),
    );
    expect(outcome).toEqual({ ok: false, output: "0123…[truncated]\nexit code 3" });

    client.runShell.mockResolvedValueOnce({ exitCode: 0 });
    expect(await execRequest(pi)).toEqual({ ok: true, output: "" });
  });

  it("reports a sandbox failure instead of running the command on the host", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    pi.getFlag.mockImplementation((name) => (name === "sandbox" ? "{}" : undefined));
    vi.mocked(startWorkerSandbox).mockRejectedValue(new Error("broker failed"));
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await expect(
      getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx),
    ).rejects.toThrow("broker failed");
    const outcome = await execRequest(pi);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.output).toContain("broker failed");
  });

  it("leaves exec requests unclaimed without a sandbox and after shutdown", async () => {
    vi.stubEnv("PI_WORKER", "");
    const pi = createMockPi();
    const unsubscribe = vi.fn();
    pi.events.on.mockReturnValue(unsubscribe);
    const ctx = createMockCommandContext();
    await workerSandboxExtension(pi);
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(execListener(pi)).toBeUndefined();

    pi.getFlag.mockImplementation((name) => (name === "sandbox" ? "{}" : undefined));
    vi.mocked(startWorkerSandbox).mockResolvedValue(mockClient());
    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(execListener(pi)).toBeDefined();
    await getEventHandler(pi, "session_shutdown")({ type: "session_shutdown" }, ctx);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function execListener(pi: ReturnType<typeof createMockPi>) {
  return pi.events.on.mock.calls.find((call) => call[0] === "worker-sandbox:exec-request")?.[1];
}

function execRequest(
  pi: ReturnType<typeof createMockPi>,
  overrides: { maxOutputBytes?: number } = {},
): Promise<{ ok: boolean; output: string } | undefined> {
  const listener = execListener(pi);
  if (!listener) throw new Error("exec listener missing");
  return new Promise((respond) => {
    let claimed = false;
    listener({
      command: "npm test",
      cwd: "/workspace",
      timeoutMs: 1_500,
      maxOutputBytes: 1024,
      ...overrides,
      claim: () => {
        claimed = true;
      },
      respond,
    });
    if (!claimed) respond(undefined);
  });
}
