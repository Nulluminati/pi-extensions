import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messengerExtension from "../../extensions/messenger/messenger.ts";
import { checkToolCall } from "../../extensions/messenger/src/enforce.ts";
import {
  findBlockingReservation,
  heartbeat,
  loadRegistry,
  loadReservations,
  normalizePathPrefix,
  readInbox,
  reserve,
  sendMessage,
} from "../../extensions/messenger/src/store.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

describe("messenger-extension", () => {
  let cwd: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;

  const executeTool = async (params: Record<string, unknown>) => {
    const tool = mockPi.registerTool.mock.calls[0][0];
    return tool.execute("call-1", params as never, undefined, undefined, mockCtx);
  };

  const getEventHandler = (eventType: string) => {
    for (const call of mockPi.on.mock.calls) {
      if (call[0] === eventType) return call[1];
    }
    throw new Error(`handler for ${eventType} not found`);
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "messenger-test-"));
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    (mockCtx as { cwd: string }).cwd = cwd;
    delete process.env.PI_MESSENGER_NAME;
    await messengerExtension(mockPi);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    delete process.env.PI_MESSENGER_NAME;
  });

  it("registers the messenger tool and lifecycle handlers", () => {
    expect(mockPi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "messenger" }),
    );
    const events = mockPi.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("tool_call");
    expect(events).toContain("session_start");
    expect(events).toContain("agent_settled");
    expect(events).toContain("session_shutdown");
  });

  it("session_start joins presence under PI_MESSENGER_NAME when set", async () => {
    process.env.PI_MESSENGER_NAME = "test-agent";
    const handler = getEventHandler("session_start");
    await handler({ type: "session_start", reason: "startup" }, mockCtx);

    const registry = await loadRegistry(cwd);
    expect(registry["test-agent"]).toBeDefined();
    expect(registry["test-agent"].pid).toBe(process.pid);
  });

  it("send delivers to a mailbox and inbox reads and clears it", async () => {
    process.env.PI_MESSENGER_NAME = "receiver";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    // Busy while the mail arrives, so the watcher does not auto-deliver and
    // the manual inbox read below has something to read.
    mockCtx.isIdle = vi.fn(() => false);

    await executeTool({ action: "send", to: "receiver", text: "hello from tests" });
    expect(await readInbox(cwd, "receiver")).toHaveLength(1);

    const res = await executeTool({ action: "inbox" });
    expect(res.content[0].text).toContain("hello from tests");
    expect(res.details.count).toBe(1);
    // Cleared after reading.
    expect(await readInbox(cwd, "receiver")).toHaveLength(0);
  });

  it("send warns when the recipient is offline but still stores mail", async () => {
    process.env.PI_MESSENGER_NAME = "sender";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const res = await executeTool({ action: "send", to: "ghost", text: "anyone there?" });
    expect(res.content[0].text).toContain("not currently online");
    expect(await readInbox(cwd, "ghost")).toHaveLength(1);
  });

  it("reserve claims paths and tool_call blocks other agents from editing them", async () => {
    process.env.PI_MESSENGER_NAME = "owner";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const res = await executeTool({ action: "reserve", paths: ["src/auth"], reason: "refactor" });
    expect(res.details.reserved).toEqual(["src/auth"]);

    // Another agent's edit is blocked.
    const otherReservations = await loadReservations(cwd);
    const block = checkToolCall(
      "edit",
      { path: "src/auth/login.ts" },
      cwd,
      "intruder",
      otherReservations,
    );
    expect(block).toBeDefined();
    expect(block?.owner).toBe("owner");

    // The owner's own edit passes.
    expect(
      checkToolCall("edit", { path: "src/auth/login.ts" }, cwd, "owner", otherReservations),
    ).toBeUndefined();

    // Sibling paths are not covered.
    expect(
      checkToolCall("write", { path: "src/auth2/x.ts" }, cwd, "intruder", otherReservations),
    ).toBeUndefined();

    // Unrelated tools are never blocked.
    expect(
      checkToolCall(
        "bash",
        { command: "echo hi > src/auth/x" },
        cwd,
        "intruder",
        otherReservations,
      ),
    ).toBeUndefined();
  });

  it("tool_call handler blocks a reserved edit from another session", async () => {
    // Another session (simulated by direct store calls) reserves src/db.
    await reserve(cwd, "other-session", ["src/db"], "migration");

    process.env.PI_MESSENGER_NAME = "me";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const handler = getEventHandler("tool_call");
    const result = await handler(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "t1",
        input: { path: "src/db/schema.ts" },
      },
      mockCtx,
    );
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("other-session");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("reserved by other-session"),
      "warning",
    );
  });

  it("release drops only the caller's reservations", async () => {
    await reserve(cwd, "a", ["src/a"]);
    await reserve(cwd, "b", ["src/b"]);

    process.env.PI_MESSENGER_NAME = "a";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    await executeTool({ action: "release" });
    const reservations = await loadReservations(cwd);
    expect(reservations["src/a"]).toBeUndefined();
    expect(reservations["src/b"]).toBeDefined();
  });

  it("agent_settled delivers unread mail into the conversation and marks it read", async () => {
    process.env.PI_MESSENGER_NAME = "busy";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    // Mail arrives mid-turn: the watcher must defer to the settle handler.
    mockCtx.isIdle = vi.fn(() => false);
    await sendMessage(cwd, "busy", "peer", "please sync on the API shape");

    mockCtx.isIdle = vi.fn(() => true);
    const settled = getEventHandler("agent_settled");
    await settled({ type: "agent_settled" }, mockCtx);

    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "messenger-inbox",
        content: [
          expect.objectContaining({
            text: expect.stringContaining("please sync on the API shape"),
          }),
        ],
      }),
      { triggerTurn: true },
    );
    expect(await readInbox(cwd, "busy")).toHaveLength(0);
  });

  it("incoming mail wakes an idle session without a settle", async () => {
    process.env.PI_MESSENGER_NAME = "watched";
    mockCtx.isIdle = vi.fn(() => true);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    // No turn has ever run; only the inbox watcher can deliver this.
    await sendMessage(cwd, "watched", "peer", "wake up call");
    await vi.waitFor(() =>
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "messenger-inbox" }),
        { triggerTurn: true },
      ),
    );
    expect(await readInbox(cwd, "watched")).toHaveLength(0);
  });

  it("inbox watcher ignores other agents' mailboxes", async () => {
    process.env.PI_MESSENGER_NAME = "watched";
    mockCtx.isIdle = vi.fn(() => true);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    await sendMessage(cwd, "someone-else", "peer", "not for you");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("inbox watcher stops after session_shutdown", async () => {
    process.env.PI_MESSENGER_NAME = "watched";
    mockCtx.isIdle = vi.fn(() => true);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    await sendMessage(cwd, "watched", "peer", "too late");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("session_shutdown leaves presence and releases generated-name reservations", async () => {
    // No PI_MESSENGER_NAME: the generated identity cannot be re-adopted by a
    // restarted session, so claims are released on shutdown.
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await executeTool({ action: "reserve", paths: ["src/leaver"] });
    const ownName = Object.entries(await loadRegistry(cwd)).find(
      ([, presence]) => presence.pid === process.pid,
    )?.[0];
    expect(ownName).toBeDefined();

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    expect(Object.keys(await loadRegistry(cwd))).toHaveLength(0);
    expect((await loadReservations(cwd))["src/leaver"]).toBeUndefined();
    // Mailbox survives on purpose.
    await sendMessage(cwd, "leaver", "x", "late mail");
    expect(await readInbox(cwd, "leaver")).toHaveLength(1);
  });

  it("session_shutdown keeps reservations under a stable name for restart", async () => {
    process.env.PI_MESSENGER_NAME = "stable-owner";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await executeTool({ action: "reserve", paths: ["src/stable"] });

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    // Presence is gone, but the claim survives so the restarted session can
    // re-adopt it (pi -c with the same PI_MESSENGER_NAME).
    expect((await loadRegistry(cwd))["stable-owner"]).toBeUndefined();
    expect((await loadReservations(cwd))["src/stable"]).toBeDefined();
  });

  it("session_start re-adopts own reservations with the current pid", async () => {
    process.env.PI_MESSENGER_NAME = "returning";
    // Simulate a claim left behind by a previous process that died.
    await reserve(cwd, "returning", ["src/kept"], "before restart", 999999999);

    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    const claim = (await loadReservations(cwd))["src/kept"];
    expect(claim).toBeDefined();
    expect(claim?.pid).toBe(process.pid);
  });

  it("list shows online agents from the registry", async () => {
    process.env.PI_MESSENGER_NAME = "viewer";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await heartbeat(cwd, "peer-session", { pid: process.pid, cwd, status: "testing" });

    const res = await executeTool({ action: "list" });
    expect(res.content[0].text).toContain("(you)");
    expect(res.content[0].text).toContain("peer-session");
  });
});

describe("messenger-store", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "messenger-store-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("normalizePathPrefix handles relative, absolute, and outside paths", () => {
    expect(normalizePathPrefix(cwd, "src/x.ts")).toBe("src/x.ts");
    expect(normalizePathPrefix(cwd, join(cwd, "src/x.ts"))).toBe("src/x.ts");
    expect(normalizePathPrefix(cwd, "/etc/passwd")).toBeUndefined();
    expect(normalizePathPrefix(cwd, ".")).toBe(".");
    expect(normalizePathPrefix(cwd, "@src/y.ts")).toBe("src/y.ts");
  });

  it("normalizePathPrefix accepts relative paths when cwd equals process.cwd()", () => {
    // Real pi sessions pass their own cwd, which is the process cwd. Those
    // paths must not be misclassified as outside the project.
    expect(normalizePathPrefix(process.cwd(), "src/x.ts")).toBe("src/x.ts");
    expect(normalizePathPrefix(process.cwd(), "extensions/missions")).toBe("extensions/missions");
    expect(normalizePathPrefix(process.cwd(), "/etc/passwd")).toBeUndefined();
  });

  it("reserve records the owning pid", async () => {
    await reserve(cwd, "owner", ["src/a"], "refactor", process.pid);
    const claims = await loadReservations(cwd);
    expect(claims["src/a"]).toMatchObject({ owner: "owner", pid: process.pid });
  });

  it("loadReservations prunes claims whose process died and left the registry", async () => {
    // No registry entry: a dead pid means the owner is gone for good.
    await reserve(cwd, "crashed", ["src/dead"], undefined, 999999999);
    const claims = await loadReservations(cwd);
    expect(claims["src/dead"]).toBeUndefined();
  });

  it("loadReservations keeps claims whose owner is live in the registry", async () => {
    // Stable-name restart: the recorded pid is stale but the owner has
    // re-heartbeated, so the claim must survive until re-adoption.
    await heartbeat(cwd, "live-owner", { pid: process.pid, cwd });
    await reserve(cwd, "live-owner", ["src/live"], undefined, 999999999);
    const claims = await loadReservations(cwd);
    expect(claims["src/live"]).toBeDefined();
  });

  it("loadReservations keeps legacy claims without a pid", async () => {
    await reserve(cwd, "old-owner", ["src/legacy"]);
    const claims = await loadReservations(cwd);
    expect(claims["src/legacy"]).toBeDefined();
  });

  it("findBlockingReservation covers directories by boundary", async () => {
    await reserve(cwd, "owner", ["src/auth"]);
    const reservations = await loadReservations(cwd);
    expect(findBlockingReservation(cwd, "src/auth/login.ts", "other", reservations)).toMatchObject({
      owner: "owner",
    });
    expect(findBlockingReservation(cwd, "src/auth/deep/x.ts", "other", reservations)).toBeDefined();
    expect(findBlockingReservation(cwd, "src/auth2/x.ts", "other", reservations)).toBeUndefined();
    expect(
      findBlockingReservation(cwd, "src/auth/login.ts", "owner", reservations),
    ).toBeUndefined();
  });

  it("mailbox preserves malformed lines when marking read", async () => {
    await mkdir(join(cwd, ".pi/messenger/inbox"), { recursive: true });
    const path = join(cwd, ".pi/messenger/inbox/a.jsonl");
    const good = { id: "m1", from: "x", to: "a", text: "hi", at: 1 };
    await writeFile(path, `${JSON.stringify(good)}\nnot-json\n`, "utf8");

    const unread = await readInbox(cwd, "a");
    expect(unread).toHaveLength(1);

    const { markRead } = await import("../../extensions/messenger/src/store.ts");
    await markRead(cwd, "a", ["m1"]);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("not-json");
    expect(raw).not.toContain("m1");
  });
});
