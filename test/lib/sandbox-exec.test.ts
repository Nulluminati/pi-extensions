import { describe, expect, it, vi } from "vitest";
import {
  requestSandboxExec,
  SANDBOX_EXEC_EVENT,
  type SandboxExecRequest,
} from "../../lib/sandbox-exec.ts";

const options = { command: "npm test", cwd: "/workspace", timeoutMs: 1_000, maxOutputBytes: 64 };

describe("requestSandboxExec", () => {
  it("returns undefined when no sandbox claims the request", async () => {
    await expect(requestSandboxExec({ emit: vi.fn() }, options)).resolves.toBeUndefined();
  });

  it("returns the sandbox outcome when a sandbox claims the request", async () => {
    const emit = vi.fn((event: string, data: unknown) => {
      expect(event).toBe(SANDBOX_EXEC_EVENT);
      const request = data as SandboxExecRequest;
      expect(request).toMatchObject(options);
      request.claim();
      setTimeout(() => request.respond({ ok: false, output: "exit code 2" }), 0);
    });
    await expect(requestSandboxExec({ emit }, options)).resolves.toEqual({
      ok: false,
      output: "exit code 2",
    });
  });

  it("fails closed when the sandbox listener throws after claiming", async () => {
    const emit = vi.fn((_event: string, data: unknown) => {
      (data as SandboxExecRequest).claim();
      throw new Error("broker gone");
    });
    const outcome = await requestSandboxExec({ emit }, options);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.output).toContain("broker gone");
  });

  it("fails when the caller cancels while the sandbox runs", async () => {
    const controller = new AbortController();
    const result = requestSandboxExec(
      { emit: (_event: string, data: unknown) => (data as SandboxExecRequest).claim() },
      { ...options, signal: controller.signal },
    );
    controller.abort();
    expect(await result).toMatchObject({ ok: false });
  });
});
