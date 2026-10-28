import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkerSandbox } from "../../extensions/worker-sandbox/src/client.ts";
import {
  loadSessionSandboxPolicy,
  loadWorkerSandboxPolicy,
} from "../../extensions/worker-sandbox/src/policy.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../extensions/worker-sandbox/src/policy.ts", () => ({
  loadWorkerSandboxPolicy: vi.fn(),
  loadSessionSandboxPolicy: vi.fn(),
}));

import { spawn } from "node:child_process";

// The broker script must live beside client.ts; workers provision imports the
// client from another extension, so the path cannot depend on the caller.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("worker sandbox broker client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadWorkerSandboxPolicy).mockReturnValue({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    });
  });

  it("uses the inline policy rather than the project policy for main sessions", async () => {
    const policy = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: ["/reviews"],
        denyWrite: ["/worktree"],
      },
    };
    vi.mocked(loadSessionSandboxPolicy).mockReturnValue(policy);
    const child = fakeChild((request) => (request.type === "init" ? { type: "ready" } : undefined));
    vi.mocked(spawn).mockReturnValue(child as never);
    const client = await startWorkerSandbox("/worktree", "inline policy");
    expect(loadSessionSandboxPolicy).toHaveBeenCalledWith("/worktree", "inline policy");
    expect(loadWorkerSandboxPolicy).not.toHaveBeenCalled();
    expect(child.requests[0]).toMatchObject({ type: "init", policy, mainSession: true });
    await client.close();
  });

  it("forwards tool updates and results without local execution", async () => {
    const child = fakeChild((request) => {
      if (request.type === "init") return { type: "ready" };
      if (request.type === "tool") {
        child.stdout.write(
          `${JSON.stringify({ type: "update", id: request.id, value: { content: [{ type: "text", text: "partial" }] } })}\n`,
        );
        return {
          type: "result",
          id: request.id,
          value: { content: [{ type: "text", text: "done" }] },
        };
      }
      return undefined;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const client = await startWorkerSandbox("/worktree");
    const onUpdate = vi.fn();
    const result = await client.runTool("read", { path: "file" }, { cwd: "/worktree", onUpdate });
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "partial" }] });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    await client.close();
  });

  it("forwards binary shell output and cancellation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fakeChild((request) => {
      requests.push(request);
      if (request.type === "init") return { type: "ready" };
      if (request.type === "shell") {
        child.stdout.write(
          `${JSON.stringify({ type: "data", id: request.id, base64: Buffer.from([0, 255]).toString("base64") })}\n`,
        );
        return { type: "result", id: request.id, value: { exitCode: 0 } };
      }
      return undefined;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const client = await startWorkerSandbox("/worktree");
    const onData = vi.fn();
    expect(
      await client.runShell("printf safe", {
        cwd: "/worktree",
        onData,
        env: { PI_TEST_SHELL_VAR: "hello" },
      }),
    ).toEqual({ exitCode: 0 });
    expect(onData).toHaveBeenCalledWith(Buffer.from([0, 255]));
    // BashOperations.exec carries an env for the command; the broker payload
    // must not drop it.
    expect(requests.find((request) => request.type === "shell")).toMatchObject({
      env: { PI_TEST_SHELL_VAR: "hello" },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.runTool(
        "bash",
        { command: "sleep 20" },
        { cwd: "/worktree", signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/);
    expect(requests.filter((request) => request.type === "tool")).toEqual([]);
    await client.close();
  });

  it("resolves the broker script beside client.ts, not beside the caller", async () => {
    const child = fakeChild((request) => (request.type === "init" ? { type: "ready" } : undefined));
    vi.mocked(spawn).mockReturnValue(child as never);
    const client = await startWorkerSandbox("/worktree");
    const brokerPath = vi.mocked(spawn).mock.calls[0]?.[1]?.[0];
    expect(brokerPath).toBe(
      join(repositoryRoot, "extensions", "worker-sandbox", "src", "broker.mjs"),
    );
    expect(existsSync(brokerPath ?? "")).toBe(true);
    await client.close();
  });

  it("refuses calls when startup fails", async () => {
    const child = fakeChild((request) =>
      request.type === "init" ? { type: "fatal", error: "socat not installed" } : undefined,
    );
    vi.mocked(spawn).mockReturnValue(child as never);
    await expect(startWorkerSandbox("/worktree")).rejects.toThrow(/socat not installed/);
    expect(child.requests.map((request) => request.type)).toEqual(["init"]);
  });

  it("refuses pending and future calls if the broker exits", async () => {
    const child = fakeChild((request) => (request.type === "init" ? { type: "ready" } : undefined));
    vi.mocked(spawn).mockReturnValue(child as never);
    const client = await startWorkerSandbox("/worktree");
    const temporaryDirectory = vi.mocked(spawn).mock.calls[0]?.[2]?.cwd;
    expect(typeof temporaryDirectory).toBe("string");
    const pending = client.runTool("read", { path: "file" }, { cwd: "/worktree" });
    child.exitCode = 1;
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/broker exited/);
    await expect(client.runTool("read", { path: "file" }, { cwd: "/worktree" })).rejects.toThrow(
      /not ready/,
    );
    expect(existsSync(String(temporaryDirectory))).toBe(false);
  });
});

function fakeChild(
  respond: (request: Record<string, unknown>) => Record<string, unknown> | undefined,
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    pid: undefined as number | undefined,
    kill: vi.fn(),
    requests: [] as Array<Record<string, unknown>>,
  });
  let input = "";
  child.stdin.on("data", (data: Buffer) => {
    input += data.toString();
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      input = input.slice(newline + 1);
      child.requests.push(request);
      const response = respond(request);
      if (response) child.stdout.write(`${JSON.stringify(response)}\n`);
      if (request.type === "shutdown") {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0));
      }
    }
  });
  return child;
}
