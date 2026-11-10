import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import herdrExtension from "../../extensions/herdr/herdr.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { sessionEntries } from "../mocks/test-helpers.ts";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: connect }));

interface MetadataRequest {
  id: string;
  method: string;
  params: {
    pane_id: string;
    source: string;
    seq: number;
    ttl_ms: number;
    tokens: Record<string, string | null>;
    label?: string;
    caller_pane_id?: string;
  };
}

const requests: MetadataRequest[] = [];
const sockets: TestSocket[] = [];
const fixtures: Array<{ stop(): Promise<void> }> = [];
const artifactDirs: string[] = [];
let respond: (socket: TestSocket, request: MetadataRequest) => void;
function paneInfo(id: string) {
  return { pane_id: id };
}

class TestSocket extends EventEmitter {
  destroyed = false;

  write(line: string): boolean {
    const request = JSON.parse(line) as MetadataRequest;
    requests.push(request);
    queueMicrotask(() => respond(this, request));
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function acknowledge(socket: TestSocket, request: MetadataRequest): void {
  let result: object = {};
  if (request.method === "pane.current") {
    result = { pane: paneInfo(request.params.caller_pane_id ?? "w1:p1") };
  }
  socket.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`));
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/herdr-test.sock");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  vi.stubEnv("PI_WORKER", "0");
  requests.length = 0;
  sockets.length = 0;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-agent-"));
  artifactDirs.push(agentDir);
  vi.mocked(getAgentDir).mockReturnValue(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  respond = acknowledge;
  connect.mockImplementation(() => {
    const socket = new TestSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
});

afterEach(async () => {
  respond = acknowledge;
  for (const fixture of fixtures) await fixture.stop();
  fixtures.length = 0;
  for (const dir of artifactDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup(mode: ExtensionContext["mode"] = "tui", paneId?: string) {
  if (paneId) vi.stubEnv("HERDR_PANE_ID", paneId);
  const pi = createMockPi();
  const ctx = createMockContext();
  ctx.mode = mode;
  const listeners = new Map<string, (data: unknown) => void>();
  const unsubscribe = vi.fn();
  pi.events.on.mockImplementation((name, listener) => {
    listeners.set(name, listener);
    return () => {
      listeners.delete(name);
      unsubscribe(name);
    };
  });
  await herdrExtension(pi);
  const start = async () => {
    const handler = pi.on.mock.calls.find(([event]) => event === "session_start")?.[1];
    await handler?.({ type: "session_start", reason: "startup" }, ctx);
  };
  const stop = async () => {
    const handler = pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    await handler?.({ type: "session_shutdown", reason: "exit" }, ctx);
  };
  const fixture = {
    pi,
    ctx,
    listeners,
    unsubscribe,
    start,
    stop,
    emit(name: string, data: unknown) {
      if (name === "session_info_changed") {
        const handler = pi.on.mock.calls.find(([event]) => event === name)?.[1];
        return handler?.(data, ctx);
      }
      listeners.get(name)?.(data);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function flushUpdates(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}

async function fireCostEvent(
  fixture: Awaited<ReturnType<typeof setup>>,
  event: "message_end" | "turn_end",
): Promise<void> {
  const handler = fixture.pi.on.mock.calls.find(([name]) => name === event)?.[1];
  if (!handler) throw new Error(`Missing ${event} handler`);
  await handler({ type: event }, fixture.ctx);
}

function latestRequest(): MetadataRequest {
  const request = requests.at(-1);
  if (!request) throw new Error("No metadata request recorded");
  return request;
}

function workerEntry(id: string, status = "running") {
  return { type: "custom", customType: "worker-record", data: { id, name: id, status } };
}

function paneRequests(method: string): MetadataRequest[] {
  return requests.filter((request) => request.method === method);
}

describe("Herdr status adapter", () => {
  it("keeps one discoverable entrypoint", async () => {
    const files = await readdir(resolve(import.meta.dirname, "../../extensions/herdr"));
    expect(files.filter((file) => file.endsWith(".ts"))).toEqual(["herdr.ts"]);
  });

  it("registers listeners before session start without opening sockets or timers", async () => {
    const fixture = await setup();
    expect([...fixture.listeners.keys()].sort()).toEqual([
      "messenger:state",
      "missions:state",
      "todos:changed",
      "workers:state",
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    fixture.emit("missions:state", { active: true, status: "active", title: "Auth" });
    await fixture.start();
    expect(latestRequest().params.tokens.pi_mission).toBe("Auth");
  });

  it("reports display-only expiring pane tokens without lifecycle or session authority", async () => {
    const fixture = await setup();
    await fixture.start();
    const request = latestRequest();
    expect(request.method).toBe("pane.report_metadata");
    expect(request.params).toEqual({
      pane_id: "w1:p1",
      source: "pi-extensions:herdr",
      seq: expect.any(Number),
      ttl_ms: 60_000,
      tokens: {
        pi_session_name: null,
        pi_mission: null,
        pi_mission_status: null,
        pi_workers: null,
        pi_worker_cost: null,
        pi_worker_tokens: null,
        pi_cost: "$0.000",
        pi_context: null,
        pi_todos: null,
        pi_messenger: null,
        pi_unread: null,
      },
    });
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
    expect(fixture.pi.registerTool).not.toHaveBeenCalled();
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("restores main-session and worker cost together at startup", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
      ]),
    );
    fixture.emit("workers:state", { running: 0, workerCostUsd: 0.005, workerTokens: 100 });
    await fixture.start();
    expect(latestRequest().params.tokens).toMatchObject({
      pi_cost: "$0.031",
      pi_worker_cost: "$0.0050",
    });
  });

  it.each(["message_end", "turn_end"] as const)(
    "refreshes session cost on %s using the active branch",
    async (event) => {
      const fixture = await setup();
      await fixture.start();
      fixture.ctx.sessionManager.getBranch.mockReturnValue(
        sessionEntries([
          { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
        ]),
      );
      await fireCostEvent(fixture, event);
      await flushUpdates();
      expect(latestRequest().params.tokens.pi_cost).toBe("$0.026");
      fixture.ctx.sessionManager.getBranch.mockReturnValue(
        sessionEntries([
          { type: "message", message: { role: "assistant", usage: { cost: { total: 0.041 } } } },
        ]),
      );
      await fireCostEvent(fixture, event);
      await flushUpdates();
      expect(latestRequest().params.tokens.pi_cost).toBe("$0.041");
    },
  );

  it("counts nested usage only through its top-level tool result", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
        {
          type: "message",
          message: {
            role: "toolResult",
            usage: { cost: { total: 0.01 } },
            details: { nested: { usage: { cost: { total: 10 } } } },
          },
        },
      ]),
    );
    await fixture.start();
    fixture.emit("workers:state", { running: 0, workerCostUsd: 0.005 });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.041");
    fixture.emit("workers:state", { running: 0, workerCostUsd: 0.005 });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.041");
  });

  it("adds unrounded costs before formatting the combined total", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.00026 } } } },
      ]),
    );
    fixture.emit("workers:state", { running: 1, workerCostUsd: 0.00026 });
    await fixture.start();
    expect(latestRequest().params.tokens.pi_worker_cost).toBe("$0.0003");
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.001");
  });

  it("updates combined cost even when the formatted worker cost does not change", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.000051 } } } },
      ]),
    );
    fixture.emit("workers:state", { running: 1, workerCostUsd: 0.0014489 });
    await fixture.start();
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.001");
    fixture.emit("workers:state", { running: 1, workerCostUsd: 0.0014491 });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_worker_cost).toBe("$0.0014");
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.002");
  });

  it("resets combined cost across sessions and clears it on shutdown", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
      ]),
    );
    fixture.emit("workers:state", { running: 0, workerCostUsd: 0.005 });
    await fixture.start();
    await fixture.stop();
    expect(latestRequest().params.tokens.pi_cost).toBeNull();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(sessionEntries([]));
    await fixture.start();
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.000");
  });

  it("reads fresh session costs during periodic metadata refresh", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([{ type: "usage", usage: { cost: { total: 0.004 } } }]),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.004");
  });

  it("reports context use in the same format as the Claude sidebar row", async () => {
    const fixture = await setup();
    fixture.ctx.getContextUsage.mockReturnValue({
      tokens: 37_200,
      contextWindow: 200_000,
      percent: 18.6,
    });
    await fixture.start();
    expect(latestRequest().params.tokens.pi_context).toBe("ctx 19%");
    fixture.ctx.getContextUsage.mockReturnValue({
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestRequest().params.tokens.pi_context).toBeNull();
  });

  it("does not read session usage or schedule cost reports after shutdown", async () => {
    const fixture = await setup();
    await fixture.start();
    await fixture.stop();
    fixture.ctx.sessionManager.getBranch.mockClear();
    const count = requests.length;
    await fireCostEvent(fixture, "message_end");
    await fireCostEvent(fixture, "turn_end");
    await flushUpdates();
    expect(fixture.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces all four extension events into one metadata snapshot", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Fix auth", status: "active" });
    fixture.emit("workers:state", { running: 2, workerCostUsd: 0.125, workerTokens: 1200 });
    fixture.emit("todos:changed", { items: [{ completed: true }, { completed: false }] });
    fixture.emit("messenger:state", { name: "auth-parent", unread: 4 });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    expect(latestRequest().params.tokens).toEqual({
      pi_session_name: null,
      pi_mission: "Fix auth",
      pi_mission_status: "active",
      pi_workers: "Workers: 2",
      pi_worker_cost: "$0.1250",
      pi_worker_tokens: "1200",
      pi_cost: "$0.125",
      pi_context: null,
      pi_todos: "1/2",
      pi_messenger: "auth-parent",
      pi_unread: "4",
    });
  });

  it("clears removed state and does not repeat unchanged event updates", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Auth", status: "paused" });
    fixture.emit("messenger:state", { name: "auth", unread: 0 });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_messenger).toBe("auth");
    fixture.emit("missions:state", { active: true, title: "Auth", status: "paused" });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    fixture.emit("missions:state", { active: false, title: null, status: null });
    fixture.emit("messenger:state", { name: null, unread: 0 });
    await flushUpdates();
    expect(latestRequest().params.tokens).toMatchObject({
      pi_mission: null,
      pi_mission_status: null,
      pi_messenger: null,
      pi_unread: "0",
    });
  });

  it("normalizes display text and ignores malformed or non-finite event values", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", {
      active: true,
      title: `  Auth\n\t\u001b${"x".repeat(100)}  `,
      status: "active",
    });
    fixture.emit("workers:state", { running: 1, workerCostUsd: Number.NaN, workerTokens: -1 });
    fixture.emit("todos:changed", { items: [{ completed: "yes" }] });
    fixture.emit("messenger:state", null);
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_mission).toBe(`Auth ${"x".repeat(75)}`);
    expect(latestRequest().params.tokens).toMatchObject({
      pi_workers: "Workers: 1",
      pi_worker_cost: null,
      pi_worker_tokens: null,
      pi_todos: null,
      pi_messenger: null,
    });
    fixture.emit("workers:state", { running: -1 });
    fixture.emit("missions:state", "invalid");
    await flushUpdates();
    expect(requests).toHaveLength(2);
  });

  it.each(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"])(
    "does nothing when %s is absent",
    async (key) => {
      vi.stubEnv(key, "");
      const fixture = await setup();
      await fixture.start();
      fixture.emit("workers:state", { running: 2 });
      await flushUpdates();
      expect(connect).not.toHaveBeenCalled();
      expect(fixture.pi.events.on).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["rpc", "json", "print"] as const)(
    "does not report inherited parent pane identifiers in %s mode",
    async (mode) => {
      const fixture = await setup(mode);
      await fixture.start();
      fixture.emit("workers:state", { running: 2 });
      await flushUpdates();
      expect(connect).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does nothing in a worker even with TUI mode and inherited Herdr variables", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const fixture = await setup();
    await fixture.start();
    expect(connect).not.toHaveBeenCalled();
    expect(fixture.pi.events.on).not.toHaveBeenCalled();
  });

  it("renews token expiry and sends strictly increasing safe sequence numbers", async () => {
    const fixture = await setup();
    await fixture.start();
    const first = latestRequest();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(2);
    expect(latestRequest().params.tokens).toEqual(first.params.tokens);
    expect(latestRequest().params.seq).toBeGreaterThan(first.params.seq);
    expect(Number.isSafeInteger(latestRequest().params.seq)).toBe(true);
    expect(latestRequest().params.ttl_ms).toBe(60_000);
  });

  it("removes listeners, timers, and owned tokens on idempotent shutdown", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Auth", status: "active" });
    await flushUpdates();
    fixture.emit("workers:state", { running: 3 });
    await fixture.stop();
    expect(Object.values(latestRequest().params.tokens).every((value) => value === null)).toBe(
      true,
    );
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(4);
    expect(fixture.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const count = requests.length;
    await fixture.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(count);
  });

  it("does not retain old state when the extension starts another session", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Old mission", status: "active" });
    await flushUpdates();
    await fixture.stop();
    await fixture.start();
    expect(fixture.listeners.size).toBe(4);
    expect(latestRequest().params.tokens.pi_mission).toBeNull();
    fixture.emit("missions:state", { active: true, title: "Current mission", status: "paused" });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_mission).toBe("Current mission");
  });

  it("keeps extension instances independent", async () => {
    const first = await setup();
    await first.start();
    const second = await setup();
    await second.start();
    first.emit("missions:state", { active: true, title: "First", status: "active" });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_mission).toBe("First");
    second.emit("workers:state", { running: 1 });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_mission).toBeNull();
  });

  it("warns once per transport failure episode and retries on the next refresh", async () => {
    respond = (socket, request) => {
      socket.emit(
        "data",
        `${JSON.stringify({ id: request.id, error: { code: "unsupported", message: "metadata unavailable" } })}\n`,
      );
    };
    const fixture = await setup();
    await fixture.start();
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("metadata unavailable"),
      "warning",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1);
    respond = acknowledge;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(3);
    respond = (socket) => socket.emit("error", new Error("socket unavailable"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(fixture.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("waits for a complete matching JSON response and handles fragmented frames", async () => {
    respond = (socket, request) => {
      socket.emit("data", Buffer.from('{"id":"unrelated","result":{}}\n'));
      const line = `${JSON.stringify({ id: request.id, result: {} })}\n`;
      socket.emit("data", Buffer.from(line.slice(0, 12)));
      socket.emit("data", Buffer.from(line.slice(12)));
    };
    const fixture = await setup();
    await fixture.start();
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it.each(["invalid JSON", "end", "oversized"])(
    "closes sockets and reports %s responses",
    async (failure) => {
      respond = (socket) => {
        if (failure === "end") socket.emit("end");
        else socket.emit("data", failure === "oversized" ? "x".repeat(70_000) : "invalid\n");
      };
      const fixture = await setup();
      await fixture.start();
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Herdr"),
        "warning",
      );
      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    },
  );

  it("times out a silent server without leaving an open socket", async () => {
    respond = () => {};
    const fixture = await setup();
    const starting = fixture.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await starting;
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      "warning",
    );
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("does not start a refresh timer when shutdown interrupts startup", async () => {
    respond = () => {};
    const fixture = await setup();
    const starting = fixture.start();
    await vi.advanceTimersByTimeAsync(0);
    respond = acknowledge;
    await fixture.stop();
    await starting;
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes slow reports and retains only the latest queued snapshot", async () => {
    const fixture = await setup();
    await fixture.start();
    respond = () => {};
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    const slowSocket = sockets.at(-1);
    const slowRequest = latestRequest();
    if (!slowSocket) throw new Error("Missing update socket");
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    fixture.emit("workers:state", { running: 3 });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    respond = acknowledge;
    acknowledge(slowSocket, slowRequest);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(3);
    expect(latestRequest().params.tokens.pi_workers).toBe("Workers: 3");
    expect(latestRequest().params.seq).toBeGreaterThan(slowRequest.params.seq);
  });

  it("does not report when terminal UI is unavailable", async () => {
    const fixture = await setup();
    fixture.ctx.hasUI = false;
    await fixture.start();
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns when a socket cannot connect", async () => {
    connect.mockImplementation(() => {
      const socket = new TestSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("error", new Error("connection refused")));
      return socket;
    });
    const fixture = await setup();
    await fixture.start();
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("connection refused"),
      "warning",
    );
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("cancels an in-flight update before clearing tokens during shutdown", async () => {
    const fixture = await setup();
    await fixture.start();
    respond = () => {};
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    const updatingSocket = sockets.at(-1);
    respond = acknowledge;
    await fixture.stop();
    expect(updatingSocket?.destroyed).toBe(true);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(Object.values(latestRequest().params.tokens).every((value) => value === null)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Herdr sidebar session name metadata", () => {
  function latestTokens() {
    const request = paneRequests("pane.report_metadata").at(-1);
    if (!request) throw new Error("No metadata request recorded");
    return request.params.tokens;
  }

  it("publishes the saved startup name without changing the Pi session", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Manual authentication review");
    await fixture.start();
    expect(latestTokens().pi_session_name).toBe("Manual authentication review");
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("follows temporary, generated, and manual names and coalesces rapid changes", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Pi · project · 12345678");
    await fixture.start();
    expect(latestTokens().pi_session_name).toBe("Pi · project · 12345678");
    const before = paneRequests("pane.report_metadata").length;
    fixture.emit("session_info_changed", { name: "Generated topic" });
    fixture.emit("session_info_changed", { name: "Manual topic" });
    await flushUpdates();
    expect(paneRequests("pane.report_metadata")).toHaveLength(before + 1);
    expect(latestTokens().pi_session_name).toBe("Manual topic");
    fixture.emit("session_info_changed", { name: "  Manual\n\ttopic  " });
    await flushUpdates();
    expect(paneRequests("pane.report_metadata")).toHaveLength(before + 1);
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "  \n\t "])("clears metadata when a name becomes %j", async (name) => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Named session");
    await fixture.start();
    fixture.emit("session_info_changed", { name });
    await flushUpdates();
    expect(latestTokens().pi_session_name).toBeNull();
  });

  it("normalizes names, strips controls, and bounds Unicode names to 80 code points", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue(`  Auth\n\t\u001b\u009b\u202e${"😀".repeat(100)}  `);
    await fixture.start();
    expect(latestTokens().pi_session_name).toBe(`Auth ${"😀".repeat(75)}`);
  });

  it("refreshes the latest name periodically and clears it across shutdown and session replacement", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("First session");
    await fixture.start();
    fixture.emit("session_info_changed", { name: "Latest first name" });
    await flushUpdates();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestTokens().pi_session_name).toBe("Latest first name");
    await fixture.stop();
    expect(latestTokens().pi_session_name).toBeNull();
    const count = requests.length;
    fixture.emit("session_info_changed", { name: "After shutdown" });
    await flushUpdates();
    expect(requests).toHaveLength(count);
    fixture.pi.getSessionName.mockReturnValue(undefined);
    await fixture.start();
    expect(latestTokens().pi_session_name).toBeNull();
    fixture.pi.getSessionName.mockReturnValue("Replacement session");
    await fixture.start();
    expect(latestTokens().pi_session_name).toBe("Replacement session");
  });

  it("does not publish pre-start or headless name events", async () => {
    const fixture = await setup();
    fixture.emit("session_info_changed", { name: "Before startup" });
    await flushUpdates();
    expect(connect).not.toHaveBeenCalled();
    await fixture.start();
    expect(latestTokens().pi_session_name).toBeNull();
    await fixture.stop();
    requests.length = 0;
    const headless = await setup("rpc");
    headless.pi.getSessionName.mockReturnValue("Headless session");
    await headless.start();
    headless.emit("session_info_changed", { name: "Headless rename" });
    await flushUpdates();
    expect(requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Herdr pane name sync", () => {
  it("renames its own pane from the startup session name without touching tabs or workers", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Auth refactor");
    await fixture.start();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    expect(paneRequests("pane.current")).toHaveLength(1);
    expect(paneRequests("pane.current")[0].params).toEqual({ caller_pane_id: "w1:p1" });
    expect(paneRequests("pane.rename")[0].params).toEqual({
      pane_id: "w1:p1",
      label: "Auth refactor",
    });
    expect(paneRequests("tab.create")).toHaveLength(0);
    expect(paneRequests("pane.close")).toHaveLength(0);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("reapplies the stored name when the session resumes", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Resumed name");
    await fixture.start();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    await fixture.stop();
    const handler = fixture.pi.on.mock.calls.find(([event]) => event === "session_start")?.[1];
    await handler?.({ type: "session_start", reason: "resume" }, fixture.ctx);
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(2));
    expect(paneRequests("pane.rename")[1].params).toEqual({
      pane_id: "w1:p1",
      label: "Resumed name",
    });
  });

  it("sends no pane requests when the startup name is missing or blank", async () => {
    const missing = await setup();
    await missing.start();
    await flushUpdates();
    expect(paneRequests("pane.current")).toHaveLength(0);
    expect(paneRequests("pane.rename")).toHaveLength(0);
    expect(requests.every((request) => request.method === "pane.report_metadata")).toBe(true);
    const blank = await setup();
    blank.pi.getSessionName.mockReturnValue("   ");
    await blank.start();
    await flushUpdates();
    expect(paneRequests("pane.current")).toHaveLength(0);
    expect(paneRequests("pane.rename")).toHaveLength(0);
  });

  it("mirrors rename events, coalesces rapid changes, and skips duplicates", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("session_info_changed", { name: "First" });
    fixture.emit("session_info_changed", { name: "Second" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    expect(paneRequests("pane.rename")[0].params).toEqual({ pane_id: "w1:p1", label: "Second" });
    expect(paneRequests("pane.current")).toHaveLength(1);
    fixture.emit("session_info_changed", { name: "Second" });
    await flushUpdates();
    expect(paneRequests("pane.rename")).toHaveLength(1);
    expect(paneRequests("pane.current")).toHaveLength(1);
  });

  it("keeps the latest name when a queued change returns to the in-flight name", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("session_info_changed", { name: "One" });
    fixture.emit("session_info_changed", { name: "Two" });
    fixture.emit("session_info_changed", { name: "One" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    await flushUpdates();
    expect(paneRequests("pane.rename").map((request) => request.params.label)).toEqual(["One"]);
  });

  it("does not erase a manual pane label when naming clears before the first rename", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("session_info_changed", { name: "Temporary" });
    fixture.emit("session_info_changed", { name: undefined });
    await flushUpdates();
    expect(paneRequests("pane.rename")).toHaveLength(0);
  });

  it("does not wait for socket I/O when handling rename events", async () => {
    const fixture = await setup();
    await fixture.start();
    const listener = fixture.pi.on.mock.calls.find(
      ([event]) => event === "session_info_changed",
    )?.[1];
    if (!listener) throw new Error("Missing session_info_changed handler");
    expect(
      listener({ type: "session_info_changed", name: "Prompt name" }, fixture.ctx),
    ).toBeUndefined();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    expect(paneRequests("pane.rename")[0].params.label).toBe("Prompt name");
  });

  it("resolves a moved pane alias before renaming the canonical pane", async () => {
    respond = (socket, request) => {
      if (request.method === "pane.current")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, result: { pane: paneInfo("w2:p7") } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Moved pane");
    await fixture.start();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    expect(paneRequests("pane.rename")[0].params).toEqual({
      pane_id: "w2:p7",
      label: "Moved pane",
    });
    expect(paneRequests("pane.rename").every((request) => request.params.pane_id !== "w1:p2")).toBe(
      true,
    );
  });

  it("clears only a label this adapter set during the session", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("session_info_changed", { name: undefined });
    fixture.emit("session_info_changed", null);
    await flushUpdates();
    expect(paneRequests("pane.current")).toHaveLength(0);
    expect(paneRequests("pane.rename")).toHaveLength(0);
    fixture.emit("session_info_changed", { name: "Temporary" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    fixture.emit("session_info_changed", { name: undefined });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(2));
    expect(paneRequests("pane.rename")[1].params).toEqual({ pane_id: "w1:p1", label: "" });
    fixture.emit("session_info_changed", { name: undefined });
    await flushUpdates();
    expect(paneRequests("pane.rename")).toHaveLength(2);
    expect(paneRequests("pane.current")).toHaveLength(2);
  });

  it("warns once per failure episode and renames after recovery", async () => {
    const failRenames = () => {
      respond = (socket, request) => {
        if (request.method === "pane.rename")
          socket.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ id: request.id, error: { message: "rename rejected" } })}\n`,
            ),
          );
        else acknowledge(socket, request);
      };
    };
    failRenames();
    const fixture = await setup();
    await fixture.start();
    fixture.emit("session_info_changed", { name: "One" });
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("rename rejected"),
        "warning",
      ),
    );
    await fireCostEvent(fixture, "message_end");
    await flushUpdates();
    fixture.emit("session_info_changed", { name: "Two" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(2));
    expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1);
    respond = acknowledge;
    fixture.emit("session_info_changed", { name: "Three" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")[2]?.params.label).toBe("Three"));
    failRenames();
    fixture.emit("session_info_changed", { name: "Four" });
    await vi.waitFor(() => expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(2));
  });

  it("retries a failed startup rename on the periodic refresh", async () => {
    respond = (socket, request) => {
      if (request.method === "pane.rename")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, error: { message: "rename rejected" } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Startup name");
    await fixture.start();
    await vi.waitFor(() => expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1));
    expect(paneRequests("pane.rename")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.rename")).toHaveLength(2);
    expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1);
    respond = acknowledge;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.rename")).toHaveLength(3);
    expect(paneRequests("pane.rename")[2].params).toEqual({
      pane_id: "w1:p1",
      label: "Startup name",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.rename")).toHaveLength(3);
  });

  it("retries the latest event name, not a stale startup name, on refresh", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Startup name");
    await fixture.start();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(1));
    respond = (socket, request) => {
      if (request.method === "pane.rename")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, error: { message: "rename rejected" } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    fixture.emit("session_info_changed", { name: "Renamed" });
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(2));
    respond = acknowledge;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.rename").map((request) => request.params.label)).toEqual([
      "Startup name",
      "Renamed",
      "Renamed",
    ]);
  });

  it("drops queued names, aborts in-flight requests, and ignores events after shutdown", async () => {
    const fixture = await setup();
    await fixture.start();
    respond = () => {};
    fixture.emit("session_info_changed", { name: "Slow" });
    await vi.waitFor(() => expect(paneRequests("pane.current")).toHaveLength(1));
    fixture.emit("session_info_changed", { name: "Queued" });
    const hangingSocket = sockets.at(-1);
    respond = acknowledge;
    await fixture.stop();
    expect(hangingSocket?.destroyed).toBe(true);
    expect(paneRequests("pane.rename")).toHaveLength(0);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const count = requests.length;
    fixture.emit("session_info_changed", { name: "After shutdown" });
    await flushUpdates();
    expect(requests).toHaveLength(count);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("stays inactive outside interactive main-pane sessions", async () => {
    const headless = await setup("json");
    headless.pi.getSessionName.mockReturnValue("Named");
    await headless.start();
    headless.emit("session_info_changed", { name: "Named" });
    await flushUpdates();
    expect(connect).not.toHaveBeenCalled();
    vi.stubEnv("PI_WORKER", "1");
    const worker = await setup();
    worker.pi.getSessionName.mockReturnValue("Named");
    await worker.start();
    worker.emit("session_info_changed", { name: "Named" });
    await flushUpdates();
    expect(worker.pi.events.on).not.toHaveBeenCalled();
    vi.stubEnv("PI_WORKER", "0");
    const fixture = await setup();
    fixture.ctx.hasUI = false;
    fixture.pi.getSessionName.mockReturnValue("Named");
    await fixture.start();
    fixture.emit("session_info_changed", { name: "Named" });
    await flushUpdates();
    expect(paneRequests("pane.current")).toHaveLength(0);
    expect(paneRequests("pane.rename")).toHaveLength(0);
  });

  it("reports workers and names without creating or closing board panes", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Named session");
    fixture.ctx.sessionManager.getBranch.mockReturnValue(
      sessionEntries([workerEntry("w-owned-1")]),
    );
    fixture.emit("workers:state", { running: 1, workerCostUsd: 0.125, workerTokens: 300 });
    await fixture.start();
    await flushUpdates();
    expect(paneRequests("pane.rename").map((request) => request.params)).toEqual([
      { pane_id: "w1:p1", label: "Named session" },
    ]);
    expect(paneRequests("pane.report_metadata").at(-1)?.params.tokens).toMatchObject({
      pi_workers: "Workers: 1",
      pi_cost: "$0.125",
      pi_worker_tokens: "300",
      pi_session_name: "Named session",
    });
    fixture.emit("workers:state", { running: 2, workerCostUsd: 0.25, workerTokens: 600 });
    await flushUpdates();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.report_metadata").at(-1)?.params.tokens).toMatchObject({
      pi_workers: "Workers: 2",
      pi_cost: "$0.250",
    });
    await fixture.stop();
    expect(
      requests.every((request) =>
        ["pane.report_metadata", "pane.current", "pane.rename"].includes(request.method),
      ),
    ).toBe(true);
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
    expect(fixture.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(await readdir(getAgentDir())).toEqual([]);
  });
});
