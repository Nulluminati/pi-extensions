import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { loadSessionSandboxPolicy, loadWorkerSandboxPolicy } from "./policy.ts";

const START_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;

// Results come from whichever built-in tool ran in the sandbox, so their
// details type varies by tool.
type SandboxToolResult = AgentToolResult<any>;
type SandboxToolUpdateCallback = AgentToolUpdateCallback<any>;

type Reply =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "update"; id: number; value: SandboxToolResult }
  | { type: "data"; id: number; base64: string }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; error: string };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onUpdate?: SandboxToolUpdateCallback;
  onData?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface WorkerSandboxClient {
  runTool(
    name: string,
    params: unknown,
    options: { cwd: string; signal?: AbortSignal; onUpdate?: SandboxToolUpdateCallback },
  ): Promise<SandboxToolResult>;
  runShell(
    command: string,
    options: {
      cwd: string;
      onData(chunk: Buffer): void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
  close(): Promise<void>;
}

class BrokerClient implements WorkerSandboxClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private child: ChildProcess,
    private cwd: string,
    private temp: string,
  ) {}

  receive(reply: Reply): void {
    if (!("id" in reply)) return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (reply.type === "update") {
      pending.onUpdate?.(reply.value);
      return;
    }
    if (reply.type === "data") {
      pending.onData?.(Buffer.from(reply.base64, "base64"));
      return;
    }
    this.pending.delete(reply.id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    if (reply.type === "error") pending.reject(new Error(reply.error));
    else pending.resolve(reply.value);
  }

  fail(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.signal && pending.abort)
        pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private request(
    payload: Record<string, unknown>,
    options: {
      cwd: string;
      signal?: AbortSignal;
      onUpdate?: SandboxToolUpdateCallback;
      onData?: (chunk: Buffer) => void;
    },
  ): Promise<unknown> {
    if (this.closed || this.child.stdin?.destroyed) {
      return Promise.reject(new Error("Worker sandbox not ready; refusing host execution"));
    }
    if (options.cwd !== this.cwd) {
      return Promise.reject(new Error("Worker sandbox cwd changed; refusing host execution"));
    }
    if (options.signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
        ...(options.onData ? { onData: options.onData } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const abort = () => {
        this.write({ type: "cancel", id });
        this.pending.delete(id);
        reject(new Error("Operation aborted"));
      };
      if (options.signal) {
        pending.abort = abort;
        options.signal.addEventListener("abort", abort, { once: true });
      }
      this.pending.set(id, pending);
      if (!this.write({ ...payload, id })) {
        this.pending.delete(id);
        if (options.signal) options.signal.removeEventListener("abort", abort);
        reject(new Error("Worker sandbox broker closed before the request started"));
      }
    });
  }

  private write(value: Record<string, unknown>): boolean {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async runTool(
    name: string,
    params: unknown,
    options: { cwd: string; signal?: AbortSignal; onUpdate?: SandboxToolUpdateCallback },
  ): Promise<SandboxToolResult> {
    return (await this.request({ type: "tool", name, params }, options)) as SandboxToolResult;
  }

  async runShell(
    command: string,
    options: {
      cwd: string;
      onData(chunk: Buffer): void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }> {
    return (await this.request(
      {
        type: "shell",
        command,
        timeout: options.timeout,
        ...(options.env ? { env: options.env } : {}),
      },
      options,
    )) as { exitCode: number | null };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.fail(new Error("Worker sandbox closed"));
    try {
      this.child.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      this.child.stdin?.end();
    } catch {
      // A failed write cannot undo the closed state.
    }
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
    if (this.child.exitCode === null && this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
    rmSync(this.temp, { recursive: true, force: true });
  }
}

/** Start the broker outside the worktree so srt's synthetic paths stay out of tool scans. */
export async function startWorkerSandbox(
  cwd: string,
  sessionPolicy?: string,
): Promise<WorkerSandboxClient> {
  const policy =
    sessionPolicy === undefined
      ? loadWorkerSandboxPolicy(cwd, process.env.PI_WORKER_READONLY === "1")
      : loadSessionSandboxPolicy(cwd, sessionPolicy);
  const temp = mkdtempSync(join(tmpdir(), "pi-worker-sandbox-"));
  const scratch = join(temp, "tmp");
  mkdirSync(scratch);
  const file = fileURLToPath(new URL("./broker.mjs", import.meta.url));
  const child = spawn(process.execPath, [file], {
    cwd: temp,
    env: { ...process.env, CLAUDE_CODE_TMPDIR: scratch },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new BrokerClient(child, cwd, temp);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("Worker sandbox initialization timed out"));
    }, START_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (error: Error) => {
      finish(() => {
        client.fail(error);
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        rmSync(temp, { recursive: true, force: true });
        reject(error);
      });
    };
    child.on("error", (error) => {
      client.fail(error);
      rmSync(temp, { recursive: true, force: true });
      fail(error);
    });
    child.stdin?.on("error", (error) => {
      client.fail(error);
      rmSync(temp, { recursive: true, force: true });
      fail(error);
    });
    child.on("exit", (code) => {
      const error = new Error(`Worker sandbox broker exited (${code}): ${stderr.trim()}`);
      client.fail(error);
      rmSync(temp, { recursive: true, force: true });
      fail(error);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        fail(new Error("Worker sandbox broker sent invalid output"));
        return;
      }
      if (reply.type === "ready") {
        finish(() => resolve(client));
      } else if (reply.type === "fatal") {
        fail(new Error(`Worker sandbox initialization failed: ${reply.error}`));
      } else if (settled) {
        client.receive(reply);
      }
    });
    child.stdin?.write(
      `${JSON.stringify({ type: "init", cwd, policy, scratch, mainSession: sessionPolicy !== undefined })}\n`,
    );
  });
}
