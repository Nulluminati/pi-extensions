import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachParentApprovalChannel,
  createWorkerApprovalClient,
  dispatchWorkerApproval,
  type WorkerApprovalEvent,
  type WorkerApprovalRequest,
} from "../../lib/worker-approval.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});

function pair() {
  const worker = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      parent.push(chunk);
      done();
    },
    destroy(error, done) {
      parent.destroy();
      done(error);
    },
  });
  const parent = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      worker.push(chunk);
      done();
    },
    destroy(error, done) {
      worker.destroy();
      done(error);
    },
  });
  cleanup.push(() => {
    worker.destroy();
    parent.destroy();
  });
  return { worker, parent };
}

const approval: WorkerApprovalRequest = {
  kind: "approval",
  command: "npm test",
  cwd: "/workspace",
  toolName: "bash",
  decision: "uncertain",
  reason: "Risk is uncertain",
};

describe("worker approval channel", () => {
  it("matches concurrent mode and approval replies without caching approval", async () => {
    const { worker, parent } = pair();
    const client = createWorkerApprovalClient(worker);
    let calls = 0;
    const handler = vi.fn(async (request: WorkerApprovalRequest) => {
      if (request.kind === "mode") return { enabled: calls > 0 };
      return { approved: ++calls === 1 };
    });
    const server = attachParentApprovalChannel(parent, handler);
    cleanup.push(client.close, server.close);
    expect(await Promise.all([client.request(approval), client.request({ kind: "mode" })])).toEqual(
      [{ approved: true }, { enabled: true }],
    );
    expect(await client.request(approval)).toEqual({ approved: false });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("preserves exact Unicode commands across fragmented byte frames", async () => {
    const { worker, parent } = pair();
    const request = { ...approval, command: "echo '日本語 😀'" };
    const handler = vi.fn(async () => ({ approved: false }));
    const server = attachParentApprovalChannel(parent, handler);
    cleanup.push(server.close);
    const reply = new Promise<string>((resolve) =>
      worker.once("data", (data) => resolve(data.toString())),
    );
    const frame = Buffer.from(`${JSON.stringify({ id: "unicode", request })}\n`);
    for (const byte of frame) worker.write(Buffer.from([byte]));
    expect(JSON.parse(await reply)).toEqual({ id: "unicode", reply: { approved: false } });
    expect(handler).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  });

  it("aborts a parent request and ignores a late approval", async () => {
    const { worker, parent } = pair();
    const client = createWorkerApprovalClient(worker);
    let parentSignal: AbortSignal | undefined;
    let approve = () => {};
    const started = new Promise<void>((resolve) => {
      const server = attachParentApprovalChannel(parent, async (_request, signal) => {
        parentSignal = signal;
        resolve();
        return new Promise((done) => {
          approve = () => done({ approved: true });
        });
      });
      cleanup.push(server.close);
    });
    cleanup.push(client.close);
    const controller = new AbortController();
    const result = client.request(approval, controller.signal);
    await started;
    const aborted = new Promise<void>((resolve) =>
      parentSignal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    controller.abort();
    expect(await result).toHaveProperty("error");
    await aborted;
    expect(parentSignal?.aborted).toBe(true);
    approve();
  });

  it("refuses already cancelled requests without contacting the parent", async () => {
    const { worker, parent } = pair();
    const client = createWorkerApprovalClient(worker);
    const handler = vi.fn(async () => ({ approved: true }));
    const server = attachParentApprovalChannel(parent, handler);
    cleanup.push(client.close, server.close);
    const controller = new AbortController();
    controller.abort();
    expect(await client.request(approval, controller.signal)).toHaveProperty("error");
    expect(handler).not.toHaveBeenCalled();
  });

  it("resolves pending and future requests as errors after disconnect", async () => {
    const { worker, parent } = pair();
    const client = createWorkerApprovalClient(worker);
    cleanup.push(client.close);
    const result = client.request(approval);
    parent.destroy();
    expect(await result).toHaveProperty("error");
    expect(await client.request({ kind: "mode" })).toHaveProperty("error");
  });

  it("times out mode and approval requests without approval", async () => {
    vi.useFakeTimers();
    const { worker } = pair();
    const client = createWorkerApprovalClient(worker);
    cleanup.push(client.close);
    const mode = client.request({ kind: "mode" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await mode).toHaveProperty("error");
    const result = client.request(approval);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toHaveProperty("error");
  });

  it.each([
    "not json\n",
    `${JSON.stringify({ id: "bad", request: { kind: "disable" } })}\n`,
    "x".repeat(33_000),
  ])("closes on malformed or oversized input without calling the parent handler", async (frame) => {
    const { worker, parent } = pair();
    const handler = vi.fn(async () => ({ approved: true }));
    const server = attachParentApprovalChannel(parent, handler);
    cleanup.push(server.close);
    const closed = new Promise<void>((resolve) => parent.once("close", resolve));
    worker.write(frame);
    await closed;
    expect(handler).not.toHaveBeenCalled();
  });

  it("never interprets an approval reply as disabled mode", async () => {
    const { worker, parent } = pair();
    const client = createWorkerApprovalClient(worker);
    cleanup.push(client.close);
    parent.once("data", (chunk) => {
      const { id } = JSON.parse(chunk.toString());
      parent.write(`${JSON.stringify({ id, reply: { approved: true } })}\n`);
    });
    expect(await client.request({ kind: "mode" })).toHaveProperty("error");
  });

  it("bounds pending requests and closes all of them on shutdown", async () => {
    const { worker } = pair();
    const client = createWorkerApprovalClient(worker);
    const pending = Array.from({ length: 16 }, () => client.request(approval));
    expect(await client.request(approval)).toHaveProperty("error");
    client.close();
    for (const reply of await Promise.all(pending)) expect(reply).toHaveProperty("error");
  });
});

describe("parent approval event", () => {
  const identity = { id: "w-test", name: "researcher", cwd: "/workspace" };

  it("delivers identity and a one-shot response directly to the extension", async () => {
    const signal = new AbortController().signal;
    const emit = vi.fn((_name: string, data: unknown) => {
      const event = data as WorkerApprovalEvent;
      event.respond({ enabled: false });
      event.respond({ enabled: true });
    });
    expect(await dispatchWorkerApproval({ emit }, identity, { kind: "mode" }, signal)).toEqual({
      enabled: false,
    });
    expect(emit).toHaveBeenCalledWith("approval-mode:worker-request", {
      worker: identity,
      request: { kind: "mode" },
      signal,
      respond: expect.any(Function),
    });
  });

  it("settles as an error when the parent request is aborted", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    const result = dispatchWorkerApproval({ emit }, identity, approval, controller.signal);
    controller.abort();
    expect(await result).toHaveProperty("error");
  });
});
