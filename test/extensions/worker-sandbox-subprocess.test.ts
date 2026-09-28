import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BROKER = fileURLToPath(
  new URL("../../extensions/worker-sandbox/src/broker.mjs", import.meta.url),
);
const LOADER = fileURLToPath(new URL("../setup/worker-sandbox-loader.mjs", import.meta.url));
const POLICY = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
};

type Reply = Record<string, unknown>;
interface Broker {
  child: ChildProcessWithoutNullStreams;
  send(request: Reply): void;
  next(predicate: (reply: Reply) => boolean): Promise<Reply>;
  close(): Promise<void>;
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "worker sandbox subprocess protocol",
  () => {
    let cwd: string;
    let brokers: Broker[];

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "pi-broker-test-"));
      brokers = [];
    });

    afterEach(async () => {
      for (const broker of brokers) await broker.close();
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
    });

    async function start(policy = POLICY): Promise<Broker> {
      const broker = launchBroker(cwd);
      brokers.push(broker);
      const scratch = join(cwd, "scratch");
      await mkdir(scratch);
      broker.send({ type: "init", cwd, scratch, policy });
      const ready = await broker.next((reply) => reply.type === "ready" || reply.type === "fatal");
      expect(ready).toEqual({ type: "ready" });
      return broker;
    }

    it("frames tool updates, results, shell bytes, and tool errors across both processes", async () => {
      const broker = await start();
      broker.send({ type: "tool", id: 1, name: "read", params: { path: "file" } });
      const update = await broker.next((reply) => reply.id === 1 && reply.type === "update");
      expect(update.value).toMatchObject({ phase: "started", cwd, pid: expect.any(Number) });
      expect(await broker.next((reply) => reply.id === 1 && reply.type === "result")).toEqual({
        type: "result",
        id: 1,
        value: { content: [{ type: "text", text: "read:file" }] },
      });

      // This command is data for the stub. No shell executes it.
      broker.send({ type: "shell", id: 2, command: "not executed" });
      const data = await broker.next((reply) => reply.id === 2 && reply.type === "data");
      expect(Buffer.from(data.base64 as string, "base64")).toEqual(Buffer.from([0, 255]));
      expect(await broker.next((reply) => reply.id === 2 && reply.type === "result")).toEqual({
        type: "result",
        id: 2,
        value: { exitCode: 0, stdout: "stub", stderr: "" },
      });

      broker.send({ type: "tool", id: 3, name: "read", params: { mode: "error" } });
      expect(await broker.next((reply) => reply.id === 3 && reply.type === "error")).toEqual({
        type: "error",
        id: 3,
        error: "test tool failed",
      });
      broker.send({ type: "tool", id: 4, name: "unknown", params: {} });
      expect(await broker.next((reply) => reply.id === 4 && reply.type === "error")).toEqual({
        type: "error",
        id: 4,
        error: "Unknown worker sandbox tool",
      });
    });

    it("kills a timed-out tool subprocess and accepts another request", async () => {
      const broker = await start();
      broker.send({ type: "tool", id: 5, name: "read", params: { mode: "hang" }, timeout: 1 });
      const update = await broker.next((reply) => reply.id === 5 && reply.type === "update");
      const { pid, descendantPid } = update.value as { pid: number; descendantPid: number };
      expect(descendantPid).toEqual(expect.any(Number));
      expect(await broker.next((reply) => reply.id === 5 && reply.type === "error")).toEqual({
        type: "error",
        id: 5,
        error: "Command timed out after 1s",
      });
      await expect.poll(() => processExists(pid)).toBe(false);
      await expect.poll(() => processExists(descendantPid)).toBe(false);
      broker.send({ type: "tool", id: 6, name: "read", params: { path: "after-timeout" } });
      expect(await broker.next((reply) => reply.id === 6 && reply.type === "result")).toMatchObject(
        {
          value: { content: [{ text: "read:after-timeout" }] },
        },
      );
    });

    it("kills a cancelled tool subprocess and rejects malformed child framing", async () => {
      const broker = await start();
      broker.send({ type: "tool", id: 7, name: "read", params: { mode: "hang" } });
      const update = await broker.next((reply) => reply.id === 7 && reply.type === "update");
      const { pid, descendantPid } = update.value as { pid: number; descendantPid: number };
      expect(descendantPid).toEqual(expect.any(Number));
      broker.send({ type: "cancel", id: 7 });
      expect(await broker.next((reply) => reply.id === 7 && reply.type === "error")).toMatchObject({
        error: expect.stringContaining("Worker sandbox tool exited"),
      });
      await expect.poll(() => processExists(pid)).toBe(false);
      await expect.poll(() => processExists(descendantPid)).toBe(false);

      broker.send({ type: "tool", id: 8, name: "read", params: { mode: "malformed" } });
      await broker.next((reply) => reply.id === 8 && reply.type === "update");
      expect(await broker.next((reply) => reply.id === 8 && reply.type === "error")).toEqual({
        type: "error",
        id: 8,
        error: "Worker sandbox tool sent invalid output",
      });
    });

    it("fails closed when the sandbox manager refuses initialization", async () => {
      const broker = launchBroker(cwd);
      brokers.push(broker);
      const scratch = join(cwd, "scratch");
      await mkdir(scratch);
      broker.send({
        type: "init",
        cwd,
        scratch,
        policy: { ...POLICY, network: { ...POLICY.network, allowedDomains: ["reject-in-test"] } },
      });
      expect(await broker.next((reply) => reply.type === "fatal")).toEqual({
        type: "fatal",
        error: "test sandbox initialization failed",
      });
    });

    it("passes the request environment to the sandboxed shell command", async () => {
      const broker = await start();

      broker.send({
        type: "shell",
        id: 30,
        command: "print-env",
        env: { PI_TEST_SANDBOX_VAR: "hello" },
      });

      expect(await broker.next((reply) => reply.id === 30 && reply.type === "result")).toEqual({
        type: "result",
        id: 30,
        value: { exitCode: 0, stdout: "hello", stderr: "" },
      });
    });

    it("keeps the sandbox home when the request environment overrides HOME", async () => {
      const broker = await start();

      broker.send({
        type: "shell",
        id: 31,
        command: "print-home",
        env: { HOME: "/attacker-home" },
      });

      const reply = await broker.next((entry) => entry.id === 31 && entry.type === "result");
      const home = (reply.value as { stdout: string }).stdout;
      expect(home).not.toBe("missing");
      expect(home).not.toBe("/attacker-home");
    });

    it("kills a request cancelled while the sandbox wrapper is still being built", async () => {
      vi.stubEnv("PI_TEST_WRAP_DELAY_MS", "400");
      const broker = await start();

      broker.send({ type: "tool", id: 32, name: "read", params: { mode: "hang" } });
      broker.send({ type: "cancel", id: 32 });

      expect(await broker.next((reply) => reply.id === 32 && reply.type === "error")).toMatchObject(
        {
          error: expect.stringContaining("cancelled"),
        },
      );

      // The broker keeps serving the next request.
      broker.send({ type: "tool", id: 33, name: "read", params: { path: "after-cancel" } });
      expect(
        await broker.next((reply) => reply.id === 33 && reply.type === "result"),
      ).toMatchObject({ value: { content: [{ text: "read:after-cancel" }] } });
    });
  },
);

function launchBroker(cwd: string): Broker {
  const child = spawn(process.execPath, ["--import", LOADER, BROKER], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: "" },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies: Reply[] = [];
  const waiting: Array<{
    predicate(reply: Reply): boolean;
    resolve(reply: Reply): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const reply = JSON.parse(line) as Reply;
    const index = waiting.findIndex(({ predicate }) => predicate(reply));
    if (index < 0) replies.push(reply);
    else {
      const [waiter] = waiting.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`broker exited (${code}): ${stderr}`));
    }
  });
  return {
    child,
    send(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    },
    next(predicate) {
      const index = replies.findIndex(predicate);
      if (index >= 0) return Promise.resolve(replies.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error(`broker reply timed out: ${stderr}`));
        }, 3_000);
        waiting.push({ predicate, resolve, reject, timer });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
      });
    },
  };
}

function processExists(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      if (readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z") return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
