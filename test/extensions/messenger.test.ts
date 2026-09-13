import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messengerExtension from "../../extensions/messenger/messenger.ts";
import { checkToolCall } from "../../extensions/messenger/src/enforce.ts";
import { withFileLock } from "../../extensions/messenger/src/lock.ts";
import {
  findBlockingReservation,
  heartbeat,
  inboxPath,
  leaveRegistry,
  loadRegistry,
  loadReservations,
  markRead,
  normalizePathPrefix,
  readInbox,
  release,
  reserve,
  sendMessage,
} from "../../extensions/messenger/src/store.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

  it("session_start reuses the identity persisted in the session", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "messenger-identity", data: { name: "persisted-agent" } },
    ]);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    expect((await loadRegistry(cwd))["persisted-agent"]).toBeDefined();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("session_start generates and persists an identity for future resumes", async () => {
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "messenger-identity",
      expect.objectContaining({ name: expect.any(String) }),
    );
    const persisted = mockPi.appendEntry.mock.calls[0][1] as { name: string };
    expect((await loadRegistry(cwd))[persisted.name]).toBeDefined();
  });

  it("PI_MESSENGER_NAME overrides the persisted identity", async () => {
    process.env.PI_MESSENGER_NAME = "env-agent";
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "messenger-identity", data: { name: "persisted-agent" } },
    ]);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);

    expect((await loadRegistry(cwd))["env-agent"]).toBeDefined();
    expect((await loadRegistry(cwd))["persisted-agent"]).toBeUndefined();
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

  it("agent_settled delivers concurrently arriving mail exactly once", async () => {
    process.env.PI_MESSENGER_NAME = "busy";
    // Busy at start so the inbox watcher cannot deliver first.
    mockCtx.isIdle = vi.fn(() => false);
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await sendMessage(cwd, "busy", "peer", "deliver once");

    mockCtx.isIdle = vi.fn(() => true);
    const settled = getEventHandler("agent_settled");
    await Promise.all([
      settled({ type: "agent_settled" }, mockCtx),
      settled({ type: "agent_settled" }, mockCtx),
    ]);

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(await readInbox(cwd, "busy")).toHaveLength(0);
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
    await vi.waitFor(async () => expect(await readInbox(cwd, "watched")).toHaveLength(0));
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

  it("session_shutdown leaves presence but keeps reservations for the next resume", async () => {
    // Identity persists in the session (messenger-identity entry), so a
    // resumed session re-adopts its claims; shutdown only drops presence.
    process.env.PI_MESSENGER_NAME = "returning";
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await executeTool({ action: "reserve", paths: ["src/kept"] });

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    expect((await loadRegistry(cwd))["returning"]).toBeUndefined();
    expect((await loadReservations(cwd))["src/kept"]).toBeDefined();
    // Mailbox survives on purpose.
    await sendMessage(cwd, "returning", "x", "late mail");
    expect(await readInbox(cwd, "returning")).toHaveLength(1);
  });

  it("session_shutdown keeps claims for session-persisted identities too", async () => {
    // No env name: identity comes from the persisted session entry, so the
    // claim must survive shutdown for the resumed session to re-adopt.
    await getEventHandler("session_start")({ type: "session_start", reason: "startup" }, mockCtx);
    await executeTool({ action: "reserve", paths: ["src/persisted-claim"] });

    await getEventHandler("session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      mockCtx,
    );

    expect((await loadReservations(cwd))["src/persisted-claim"]).toBeDefined();
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

  it("loadReservations marks freshly dead claims orphaned and keeps them", async () => {
    // First read after the owner died: stamp orphanedAt so other sessions'
    // reads during a death-to-resume gap cannot destroy the claim.
    await reserve(cwd, "crashed", ["src/dead"], undefined, 999999999);
    const claims = await loadReservations(cwd);
    expect(claims["src/dead"]).toBeDefined();
    expect(claims["src/dead"]?.orphanedAt).toBeDefined();
  });

  it("loadReservations prunes claims orphaned past the grace window", async () => {
    await reserve(cwd, "crashed", ["src/dead"], undefined, 999999999);
    await loadReservations(cwd); // stamps orphanedAt = now

    // Age the orphan past the grace window.
    const path = join(cwd, ".pi/messenger/reservations.json");
    const claims = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      { orphanedAt?: number }
    >;
    claims["src/dead"].orphanedAt = Date.now() - 11 * 60_000;
    await writeFile(path, JSON.stringify(claims), "utf8");

    expect((await loadReservations(cwd))["src/dead"]).toBeUndefined();
  });

  it("loadReservations keeps claims whose owner is live in the registry", async () => {
    // Stable identity restart: the recorded pid is stale but the owner has
    // re-heartbeated, so the claim must survive until re-adoption.
    await heartbeat(cwd, "live-owner", { pid: process.pid, cwd });
    await reserve(cwd, "live-owner", ["src/live"], undefined, 999999999);
    const claims = await loadReservations(cwd);
    expect(claims["src/live"]).toBeDefined();
    expect(claims["src/live"]?.orphanedAt).toBeUndefined();
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

  it("heartbeat writes one shard per agent and never rewrites another agent's shard", async () => {
    await heartbeat(cwd, "agent-a", { pid: process.pid, cwd });
    const shardA = join(cwd, ".pi/messenger/registry/agent-a.json");
    await heartbeat(cwd, "agent-b", { pid: process.pid, cwd, status: "working" });
    const aBefore = await readFile(shardA, "utf8");

    // Concurrent agents heartbeating must not clobber each other: agent-b's
    // update goes to agent-b's shard only.
    await heartbeat(cwd, "agent-b", { pid: process.pid, cwd, status: "still working" });

    expect(await readFile(shardA, "utf8")).toBe(aBefore);
    const registry = await loadRegistry(cwd);
    expect(registry["agent-a"]).toBeDefined();
    expect(registry["agent-b"]?.status).toBe("still working");
  });

  it("legacy single-file registry migrates to shards on read", async () => {
    await mkdir(join(cwd, ".pi/messenger"), { recursive: true });
    const legacyPath = join(cwd, ".pi/messenger/registry.json");
    const legacy = {
      "live-agent": { name: "live-agent", pid: process.pid, cwd, startedAt: 1, lastSeenAt: 2 },
      "dead-agent": { name: "dead-agent", pid: 999999999, cwd, startedAt: 1, lastSeenAt: 2 },
    };
    await writeFile(legacyPath, JSON.stringify(legacy), "utf8");

    const registry = await loadRegistry(cwd);

    expect(registry["live-agent"]).toBeDefined();
    expect(registry["dead-agent"]).toBeUndefined();
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(cwd, ".pi/messenger/registry/live-agent.json"))).toBe(true);
    expect(existsSync(join(cwd, ".pi/messenger/registry/dead-agent.json"))).toBe(false);
  });

  it("leaveRegistry removes only the agent's shard", async () => {
    await heartbeat(cwd, "agent-a", { pid: process.pid, cwd });
    await heartbeat(cwd, "agent-b", { pid: process.pid, cwd });

    await leaveRegistry(cwd, "agent-a");

    const registry = await loadRegistry(cwd);
    expect(registry["agent-a"]).toBeUndefined();
    expect(registry["agent-b"]).toBeDefined();
    expect(existsSync(join(cwd, ".pi/messenger/registry/agent-a.json"))).toBe(false);
  });

  it("mailbox preserves malformed lines when marking read", async () => {
    await mkdir(join(cwd, ".pi/messenger/inbox"), { recursive: true });
    const path = join(cwd, ".pi/messenger/inbox/a.jsonl");
    const good = { id: "m1", from: "x", to: "a", text: "hi", at: 1 };
    await writeFile(path, `${JSON.stringify(good)}\nnot-json\n`, "utf8");

    const unread = await readInbox(cwd, "a");
    expect(unread).toHaveLength(1);

    await markRead(cwd, "a", ["m1"]);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("not-json");
    expect(raw).not.toContain("m1");
  });

  it("inboxPath encodes the agent name so traversal names stay inside the inbox", () => {
    const inbox = join(cwd, ".pi", "messenger", "inbox");
    const path = inboxPath(cwd, "../../escape");

    expect(path).toBe(join(inbox, `${encodeURIComponent("../../escape")}.jsonl`));
    expect(path.startsWith(`${inbox}${sep}`)).toBe(true);
  });

  it("sendMessage rejects a recipient name that would escape the inbox", async () => {
    await expect(sendMessage(cwd, "../escape", "me", "hi")).rejects.toThrow(/recipient/i);
    await expect(sendMessage(cwd, "..\\escape", "me", "hi")).rejects.toThrow(/recipient/i);
    expect(existsSync(join(cwd, ".pi", "messenger", "escape.jsonl"))).toBe(false);
    expect(existsSync(join(cwd, ".pi", "escape.jsonl"))).toBe(false);
  });

  it("concurrent reserve calls keep every claim", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => reserve(cwd, `agent-${i}`, [`src/dir-${i}`])),
    );

    const claims = await loadReservations(cwd);
    for (let i = 0; i < 8; i += 1) {
      expect(claims[`src/dir-${i}`]).toMatchObject({ owner: `agent-${i}` });
    }
  });

  it("concurrent reserve and release do not clobber each other", async () => {
    await reserve(cwd, "keeper", ["src/kept"]);
    await reserve(cwd, "dropper", ["src/dropped"]);

    await Promise.all([release(cwd, "dropper"), reserve(cwd, "newcomer", ["src/fresh"])]);

    const claims = await loadReservations(cwd);
    expect(claims["src/kept"]).toBeDefined();
    expect(claims["src/dropped"]).toBeUndefined();
    expect(claims["src/fresh"]).toMatchObject({ owner: "newcomer" });
  });

  it("reservations from separate processes keep every claim", async () => {
    const storeUrl = new URL("../../extensions/messenger/src/store.ts", import.meta.url).href;
    const script = [
      `const { reserve } = await import(${JSON.stringify(storeUrl)});`,
      "const [dir, owner, path] = process.argv.slice(1);",
      "await reserve(dir, owner, [path]);",
    ].join("\n");

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            cwd,
            `proc-${i}`,
            `src/proc-${i}`,
          ],
          { cwd: REPO_ROOT },
        ),
      ),
    );

    const claims = await loadReservations(cwd);
    for (let i = 0; i < 4; i += 1) {
      expect(claims[`src/proc-${i}`]).toMatchObject({ owner: `proc-${i}` });
    }
  });

  it("reserve rejects a claim under another agent's prefix", async () => {
    await reserve(cwd, "owner", ["src/auth"]);

    const result = await reserve(cwd, "other", ["src/auth/login.ts"]);

    expect(result.reserved).toEqual([]);
    expect(result.conflicts).toEqual([{ path: "src/auth/login.ts", owner: "owner" }]);
  });

  it("reserve rejects a claim that would cover another agent's prefix", async () => {
    await reserve(cwd, "owner", ["src/auth/login.ts"]);

    const result = await reserve(cwd, "other", ["src/auth"]);

    expect(result.reserved).toEqual([]);
    expect(result.conflicts).toEqual([{ path: "src/auth", owner: "owner" }]);
  });

  it("reserve lets an agent extend its own prefix", async () => {
    await reserve(cwd, "owner", ["src/auth"]);

    const result = await reserve(cwd, "owner", ["src/auth/login.ts"]);

    expect(result.reserved).toEqual(["src/auth/login.ts"]);
    expect(result.conflicts).toEqual([]);
  });

  it("concurrent markRead and sendMessage keep newly arrived mail", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => sendMessage(cwd, "a", "peer", `old-${i}`)),
    );
    const unread = await readInbox(cwd, "a");
    const oldIds = unread.slice(0, 15).map((m) => m.id);

    await Promise.all([
      markRead(cwd, "a", oldIds),
      ...Array.from({ length: 15 }, (_, i) => sendMessage(cwd, "a", "peer", `new-${i}`)),
    ]);

    const remaining = await readInbox(cwd, "a");
    expect(remaining.filter((m) => m.text.startsWith("new-"))).toHaveLength(15);
    expect(remaining.filter((m) => m.text.startsWith("old-"))).toHaveLength(15);
  });

  it("sendMessage ids stay unique for sends in the same millisecond", async () => {
    // A duplicate id makes markRead delete every message sharing it, so ids
    // must carry enough entropy to survive a burst inside one millisecond.
    // Freeze time so every send draws from the same id timestamp bucket; the
    // random suffix alone must keep the ids apart.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const messages: Array<{ id: string }> = [];
      for (let i = 0; i < 1000; i += 1) {
        messages.push(await sendMessage(cwd, "a", "peer", `burst-${i}`));
      }
      const ids = new Set(messages.map((m) => m.id));
      expect(ids.size).toBe(messages.length);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("file lock serializes overlapping critical sections", async () => {
    const lockPath = join(cwd, "test.lock");
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(lockPath, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-start"));

    const second = withFileLock(lockPath, async () => {
      events.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).not.toContain("second");

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});
