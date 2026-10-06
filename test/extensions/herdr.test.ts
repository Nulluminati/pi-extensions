import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import herdrExtension from "../../extensions/herdr/herdr.ts";
import { replayTranscriptEvents } from "../../extensions/herdr/src/transcript-events.ts";
import {
  createTranscriptViewport,
  renderTranscriptBlocks,
} from "../../extensions/herdr/src/transcript-view.ts";
import { createWorkerMonitors } from "../../extensions/herdr/src/worker-monitors.ts";
import { readTranscriptPage } from "../../extensions/herdr/src/worker-transcript.ts";
import {
  readWorkerIds,
  readWorkerRecord,
  readWorkerReferences,
  readWorkersView,
  readWorkerView,
  readWorkspaceWorkersView,
} from "../../extensions/herdr/src/worker-view.ts";
import {
  runWorkersViewer,
  runWorkerTranscriptViewer,
  runWorkerViewer,
} from "../../extensions/herdr/src/worker-viewer.ts";
import { recordPath, stderrLogPath, streamPath } from "../../extensions/workers/src/store.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

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
    target_pane_id?: string;
    direction?: string;
    focus?: boolean;
    cwd?: string;
    text?: string;
    keys?: string[];
    label?: string;
    caller_pane_id?: string;
    workspace_id?: string;
  };
}

const requests: MetadataRequest[] = [];
const sockets: TestSocket[] = [];
const fixtures: Array<{ stop(): Promise<void> }> = [];
const artifactDirs: string[] = [];
let respond: (socket: TestSocket, request: MetadataRequest) => void;
let paneCounter = 1;
const closedPanes = new Set<string>();
const movedParents = new Map<string, string>();
const paneTabs = new Map<string, string>();

function paneInfo(id: string) {
  const workspace = movedParents.get(id) ?? id.split(":")[0];
  return {
    pane_id: id,
    workspace_id: workspace,
    tab_id: paneTabs.get(id) ?? `${workspace}:${id.endsWith(":p9") ? "t2" : "t1"}`,
    terminal_id: `terminal-${id}`,
  };
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
  if (request.method === "pane.layout") {
    result = {
      layout: { panes: [{ pane_id: request.params.pane_id, rect: { width: 180, height: 50 } }] },
    };
  } else if (request.method === "tab.create") {
    const workspace = request.params.workspace_id ?? "w1";
    const pane = paneInfo(`${workspace}:p${++paneCounter}`);
    pane.tab_id = `${workspace}:t-workers-${paneCounter}`;
    paneTabs.set(pane.pane_id, pane.tab_id);
    result = {
      tab: { tab_id: pane.tab_id, workspace_id: workspace, label: request.params.label },
      root_pane: pane,
    };
  } else if (request.method === "pane.split") {
    if (request.params.direction !== "right" && request.params.direction !== "down") {
      socket.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            id: request.id,
            error: { code: "invalid_request", message: "Invalid pane split direction" },
          }) + "\n",
        ),
      );
      return;
    }
    const anchor = paneInfo(request.params.target_pane_id ?? "w1:p1");
    const pane = paneInfo(`${anchor.workspace_id}:p${++paneCounter}`);
    pane.tab_id = anchor.tab_id;
    paneTabs.set(pane.pane_id, pane.tab_id);
    result = { pane };
  } else if (request.method === "pane.current") {
    result = { pane: paneInfo(request.params.caller_pane_id ?? "w1:p1") };
  } else if (request.method === "pane.get") {
    if (closedPanes.has(request.params.pane_id)) {
      socket.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "pane missing" } })}\n`,
        ),
      );
      return;
    }
    result = { pane: paneInfo(request.params.pane_id) };
  } else if (request.method === "pane.close") closedPanes.add(request.params.pane_id);
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
  paneCounter = 1;
  closedPanes.clear();
  movedParents.clear();
  paneTabs.clear();
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

async function workerArtifacts(record: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-herdr-worker-"));
  artifactDirs.push(cwd);
  const id = "w-test-123";
  const paths = [recordPath(cwd, id), streamPath(cwd, id), stderrLogPath(cwd, id)];
  for (const path of paths) await mkdir(dirname(path), { recursive: true });
  await writeFile(
    paths[0],
    JSON.stringify({ id, name: "scout", status: "running", streamFormat: "raw", ...record }),
  );
  await writeFile(paths[1], "");
  await writeFile(paths[2], "");
  return { cwd, id, paths };
}

describe("Herdr single-worker transcript terminal", () => {
  function input() {
    return Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      isPaused: () => true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
  }

  it("shows complete task and report text when the raw stream is unavailable", async () => {
    const task = "TASK-BEGIN\n" + "Task body\n".repeat(30) + "TASK-END";
    const report = "REPORT-BEGIN\n" + "Report body\n".repeat(50) + "REPORT-END";
    const { cwd, id, paths } = await workerArtifacts({
      task,
      outputText: report,
      status: "completed",
    });
    await writeFile(paths[1], "");
    const controller = new AbortController();
    const frames: string[] = [];
    await runWorkerTranscriptViewer(cwd, id, controller.signal, {
      write: (text) => {
        frames.push(text);
        controller.abort();
      },
    });
    const plain = stripVTControlCharacters(frames.join("\n"));
    for (const expected of ["TASK-BEGIN", "TASK-END", "REPORT-BEGIN", "REPORT-END"])
      expect(plain).toContain(expected);
  });

  // History loading renders 180 large events; allow for loaded CI machines.
  it("loads older history on Home and quits only the viewer with terminal restoration", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    await writeFile(
      paths[1],
      Array.from({ length: 180 }, (_, n) =>
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            timestamp: n,
            content: [{ type: "text", text: `Turn ${n}: ${"Full output ".repeat(800)}` }],
          },
        }),
      ).join("\n") + "\n",
    );
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const keys = input();
    const frames: string[] = [];
    const output = {
      write(text: string) {
        if (!text.includes("Status:")) return;
        frames.push(stripVTControlCharacters(text));
        keys.emit("data", frames.length === 1 ? "\u001b[H" : "q");
      },
    };
    await runWorkerTranscriptViewer(cwd, id, new AbortController().signal, output, keys);
    expect(frames[0]).toContain("Turn 179:");
    expect(frames[1]).toContain("Turn 0:");
    expect(keys.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(keys.pause).toHaveBeenCalledOnce();
    expect(keys.listenerCount("data")).toBe(0);
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  }, 20_000);

  it("switches to full stderr without changing worker artifacts", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    await writeFile(paths[2], "STDERR-BEGIN\n" + "Diagnostic\n".repeat(100) + "STDERR-END\n");
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const keys = input();
    const frames: string[] = [];
    await runWorkerTranscriptViewer(
      cwd,
      id,
      new AbortController().signal,
      {
        write(text: string) {
          if (!text.includes("Status:")) return;
          frames.push(stripVTControlCharacters(text));
          keys.emit("data", frames.length === 1 ? "e" : "q");
        },
      },
      keys,
    );
    expect(frames[1]).toContain("STDERR-BEGIN");
    expect(frames[1]).toContain("STDERR-END");
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });

  it("refreshes a live assistant snapshot when new events arrive", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const line = (type: string, text: string) =>
      JSON.stringify({
        type,
        message: { role: "assistant", timestamp: 1, content: [{ type: "text", text }] },
      }) + "\n";
    await writeFile(paths[1], line("message_update", "Initial live text"));
    const keys = input();
    const frames: string[] = [];
    let append: Promise<void> | undefined;
    await runWorkerTranscriptViewer(
      cwd,
      id,
      new AbortController().signal,
      {
        write(text: string) {
          if (!text.includes("Status:")) return;
          frames.push(stripVTControlCharacters(text));
          if (frames.length === 1) {
            append = appendFile(
              paths[1],
              line("message_end", "Initial live text and complete response"),
            );
            void append.then(() => keys.emit("data", "\u001b[F"));
          } else keys.emit("data", "q");
        },
      },
      keys,
    );
    await append;
    expect(frames[0]).toContain("Initial live text");
    expect(frames[1]).toContain("Initial live text and complete response");
  });

  it("ends only the transcript viewer when workspace discovery disappears", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const list = join(cwd, "live-list.json");
    await writeFile(list, JSON.stringify({ workerIds: [id] }));
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const keys = input();
    let removal: Promise<void> | undefined;
    await runWorkerTranscriptViewer(
      cwd,
      id,
      new AbortController().signal,
      {
        isTTY: true,
        write(text: string) {
          if (!text.includes("Status:")) return;
          removal = rm(list);
          void removal.then(() => keys.emit("data", "\u001b[F"));
        },
      },
      keys,
      list,
    );
    await removal;
    expect(keys.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });

  it("releases standalone stdin after q when the inherited stream was not paused", async () => {
    const { cwd, id } = await workerArtifacts();
    const viewer = resolve("extensions/herdr/src/worker-viewer.ts");
    const script = `
      const write = process.stdout.write.bind(process.stdout);
      const pause = process.stdin.pause.bind(process.stdin);
      let paused = false;
      process.stdin.isTTY = true;
      process.stdin.isPaused = () => false;
      process.stdin.setRawMode = () => process.stdin;
      process.stdin.pause = () => { paused = true; return pause(); };
      process.stdout.write = text => { if (text.includes("Status:")) process.stdin.emit("data", "q"); return true; };
      process.argv = [process.execPath, ${JSON.stringify(viewer)}, ${JSON.stringify(cwd)}, "--transcript", ${JSON.stringify(id)}];
      await import(${JSON.stringify(pathToFileURL(viewer).href)});
      write(JSON.stringify({paused}));
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 5_000 },
    );
    expect(JSON.parse(result.stdout)).toEqual({ paused: true });
    expect(result.stderr).toBe("");
  });

  it("launches transcript mode directly with strip-only Node without Pi theme initialization", async () => {
    const { cwd, id, paths } = await workerArtifacts({
      task: "Runtime task",
      outputText: "Runtime report",
      status: "completed",
    });
    await writeFile(paths[1], "");
    const result = await new Promise<{ stdout: string; stderr: string }>((done, reject) => {
      const child = execFile(
        process.execPath,
        [resolve("extensions/herdr/src/worker-viewer.ts"), cwd, "--transcript", id],
        { timeout: 5_000 },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else done({ stdout, stderr });
        },
      );
      child.stdout?.once("data", () => child.kill("SIGTERM"));
    });
    expect(stripVTControlCharacters(result.stdout)).toContain("Runtime task");
    expect(stripVTControlCharacters(result.stdout)).toContain("Runtime report");
    expect(result.stderr).toBe("");
  });

  it("hides expired workspace sources rather than exposing artifacts outside the active list", async () => {
    const { cwd, id } = await workerArtifacts();
    const list = join(cwd, "expired-list.json");
    await writeFile(list, JSON.stringify({ sources: [] }));
    const controller = new AbortController();
    const frames: string[] = [];
    await runWorkerTranscriptViewer(
      cwd,
      id,
      controller.signal,
      {
        write(text: string) {
          frames.push(text);
          controller.abort();
        },
      },
      input(),
      list,
    );
    expect(frames.join("\n")).toContain("No active worker registration");
    expect(frames.join("\n")).not.toContain("Report:");
  });
});

describe("Herdr Pi-style transcript view", () => {
  it("renders complete messages, thinking, arguments, results, and details without cards", () => {
    const lines = renderTranscriptBlocks(
      [
        { kind: "user", text: "Task text" },
        { kind: "thinking", text: "Recorded reasoning" },
        { kind: "assistant", text: "## Reply\nFull response" },
        {
          kind: "tool_call",
          toolName: "bash",
          text: JSON.stringify({ command: "printf full-output" }, null, 2),
        },
        {
          kind: "tool_result",
          toolName: "bash",
          text: "Full output\n".repeat(100) + "Last output line",
          details: '{"exitCode":0}',
          isError: false,
        },
      ],
      80,
    );
    const plain = stripVTControlCharacters(lines.join("\n"));
    for (const expected of [
      "Task text",
      "Recorded reasoning",
      "Reply",
      "Full response",
      "bash",
      "printf full-output",
      "Last output line",
      "exitCode",
    ])
      expect(plain).toContain(expected);
    expect(plain).not.toContain("╭");
    expect(lines.length).toBeGreaterThan(100);
  });

  it("removes terminal commands and direction controls from content and tool names", () => {
    const attack = "\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[2J\u202e";
    const plain = stripVTControlCharacters(
      renderTranscriptBlocks(
        [
          { kind: "assistant", text: `Before${attack}After` },
          {
            kind: "tool_result",
            toolName: `tool${attack}`,
            text: `Output${attack}Safe`,
            isError: true,
          },
        ],
        80,
      ).join("\n"),
    );
    expect(plain).toContain("BeforeAfter");
    expect(plain).toContain("OutputSafe");
    expect(plain).not.toContain("Y2xpcGJvYXJk");
    expect(plain).not.toContain("\u202e");
  });

  it("wraps long Unicode tool output without discarding its end", async () => {
    const actual = await vi.importActual<typeof tui>("@earendil-works/pi-tui");
    const wrap = vi.spyOn(tui, "wrapTextWithAnsi").mockImplementation(actual.wrapTextWithAnsi);
    try {
      const lines = renderTranscriptBlocks(
        [
          {
            kind: "tool_result",
            toolName: "read",
            text: "😀 long output ".repeat(100) + "END-OF-OUTPUT",
          },
        ],
        18,
      );
      expect(stripVTControlCharacters(lines.join("\n"))).toContain("END-OF-OUTPUT");
      for (const line of lines) expect(actual.visibleWidth(line)).toBeLessThanOrEqual(18);
    } finally {
      wrap.mockRestore();
    }
  });

  it("follows live output, pauses while scrolling, and returns to the newest text", () => {
    const viewport = createTranscriptViewport();
    const block = (count: number) => [
      {
        kind: "tool_result" as const,
        toolName: "read",
        text: Array.from({ length: count }, (_, n) => `Line ${n}`).join("\n"),
      },
    ];
    viewport.setBlocks(block(30));
    expect(stripVTControlCharacters(viewport.render(80, 6).join("\n"))).toContain("Line 29");
    expect(viewport.following).toBe(true);
    viewport.scrollBy(-15);
    const position = viewport.scrollTop;
    expect(viewport.following).toBe(false);
    viewport.setBlocks(block(40));
    const paused = stripVTControlCharacters(viewport.render(80, 6).join("\n"));
    expect(viewport.scrollTop).toBe(position);
    expect(paused).not.toContain("Line 39");
    viewport.scrollToEnd();
    expect(stripVTControlCharacters(viewport.render(80, 6).join("\n"))).toContain("Line 39");
    expect(viewport.following).toBe(true);
  });

  it("preserves a paused historical end and reports unconsumed boundary scroll", () => {
    const viewport = createTranscriptViewport();
    viewport.setBlocks([{ kind: "assistant", text: "Old page" }]);
    viewport.render(80, 10);
    viewport.pauseAtEnd();
    viewport.render(80, 10);
    expect(viewport.following).toBe(false);
    viewport.scrollToStart();
    expect(viewport.scrollBy(-10)).toBeLessThan(0);
  });
});

describe("Herdr historical worker transcript reader", () => {
  function messageLine(text: string, timestamp: number): string {
    return (
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", timestamp, content: [{ type: "text", text }] },
      }) + "\n"
    );
  }

  it("reads complete content beyond the old 64 KiB tail without changing artifacts", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const text = "Full content 😀\n".repeat(8_000);
    await writeFile(paths[1], messageLine(text, 1));
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const page = await readTranscriptPage(cwd, id);
    expect(page.blocks).toEqual([{ kind: "assistant", text }]);
    expect(page).toMatchObject({ start: 0, hasPrevious: false, hasNext: false, warnings: [] });
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });

  it("pages backward and forward through recorded history instead of dropping older output", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const events = Array.from({ length: 180 }, (_, index) =>
      messageLine(`Turn ${index}: ${"long output ".repeat(800)}`, index),
    );
    await writeFile(paths[1], events.join(""));
    const latest = await readTranscriptPage(cwd, id);
    expect(latest.hasPrevious).toBe(true);
    expect(latest.blocks.at(-1)?.text).toContain("Turn 179:");
    const previous = await readTranscriptPage(cwd, id, { before: latest.start });
    expect(previous.end).toBe(latest.start);
    expect(previous.hasNext).toBe(true);
    expect(previous.blocks.length).toBeGreaterThan(0);
    const forward = await readTranscriptPage(cwd, id, { after: previous.end });
    expect(forward.start).toBe(previous.end);
    expect(forward.blocks[0]?.text).toBe(latest.blocks[0]?.text);
    const first = await readTranscriptPage(cwd, id, { after: 0 });
    expect(first.start).toBe(0);
    expect(first.hasPrevious).toBe(false);
    expect(first.blocks[0]?.text).toContain("Turn 0:");
    expect(first.hasNext).toBe(true);
  });

  it("reads an event larger than one page rather than splitting or summarizing it", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const text = "Large event content\n".repeat(50_000);
    await writeFile(paths[1], messageLine(text, 1));
    expect((await readTranscriptPage(cwd, id)).blocks).toEqual([{ kind: "assistant", text }]);
    expect((await readTranscriptPage(cwd, id, { after: 0 })).blocks).toEqual([
      { kind: "assistant", text },
    ]);
  });

  it("retains complete events around corrupt and still-written records", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    await writeFile(
      paths[1],
      messageLine("Complete first message", 1) + "not-json\n" + '{"type":"message_end","message":',
    );
    const page = await readTranscriptPage(cwd, id);
    expect(page.blocks).toEqual([{ kind: "assistant", text: "Complete first message" }]);
    expect(page.warnings.join(" ")).toContain("Invalid transcript event");
    expect(page.warnings.join(" ")).toContain("still being written");
    await appendFile(
      paths[1],
      '{"role":"assistant","timestamp":2,"content":[{"type":"text","text":"Completed second message"}]}}\n',
    );
    expect((await readTranscriptPage(cwd, id)).blocks.at(-1)?.text).toBe(
      "Completed second message",
    );
  });

  it("rejects symlink and directory artifacts without following them", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const target = join(cwd, "unrelated.txt");
    await writeFile(target, messageLine("Must not follow this file", 1));
    await rm(paths[1]);
    await symlink(target, paths[1]);
    await expect(readTranscriptPage(cwd, id)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(messageLine("Must not follow this file", 1));
    await rm(paths[1]);
    await mkdir(paths[1]);
    await expect(readTranscriptPage(cwd, id)).rejects.toThrow("not a regular file");
  });

  it("shows complete stderr text with the same safe historical paging", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const text = `FIRST-ERROR\n${"Diagnostic text\n".repeat(40_000)}LAST-ERROR\n`;
    await writeFile(paths[2], text);
    const latest = await readTranscriptPage(cwd, id, { channel: "stderr" });
    expect(latest.blocks.at(-1)?.kind).toBe("error");
    expect(latest.blocks.at(-1)?.text).toContain("LAST-ERROR");
    expect(latest.hasPrevious).toBe(true);
    const first = await readTranscriptPage(cwd, id, { channel: "stderr", after: 0 });
    expect(first.blocks[0]?.text).toContain("FIRST-ERROR");
    expect(first.warnings).toEqual([]);
    expect(await readFile(paths[2], "utf8")).toBe(text);
  });

  it("preserves a split UTF-8 character until the next live append completes it", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const glyph = Buffer.from("😀");
    await writeFile(paths[2], Buffer.concat([Buffer.from("Before "), glyph.subarray(0, 2)]));
    const partial = await readTranscriptPage(cwd, id, { channel: "stderr" });
    expect(partial.blocks[0]?.text).toBe("Before ");
    expect(partial.warnings.join(" ")).toContain("UTF-8 character");
    await appendFile(paths[2], Buffer.concat([glyph.subarray(2), Buffer.from(" after\n")]));
    const complete = await readTranscriptPage(cwd, id, { channel: "stderr" });
    expect(complete.blocks[0]?.text).toBe("Before 😀 after\n");
    expect(complete.warnings).toEqual([]);
  });

  it("reads full task and report metadata beyond the summary record bound", async () => {
    const outputText = "REPORT-BEGIN\n" + "Full recorded report\n".repeat(20_000) + "REPORT-END";
    const { cwd, id } = await workerArtifacts({
      task: "Full original task",
      outputText,
      status: "completed",
    });
    expect(await readWorkerRecord(cwd, id)).toBeUndefined();
    const record = await readWorkerRecord(cwd, id, 8 * 1024 * 1024);
    expect(record?.task).toBe("Full original task");
    expect(record?.outputText).toBe(outputText);
    await expect(readWorkerRecord(cwd, id, Number.POSITIVE_INFINITY)).rejects.toThrow(
      "Invalid worker record read limit",
    );
    await expect(readWorkerRecord(cwd, id, 0)).rejects.toThrow("Invalid worker record read limit");
  });

  it("validates page boundaries and accepts complete final events without a newline", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    await writeFile(paths[1], messageLine("Final event", 1).trimEnd());
    expect((await readTranscriptPage(cwd, id)).blocks).toEqual([
      { kind: "assistant", text: "Final event" },
    ]);
    await expect(readTranscriptPage(cwd, id, { before: -1 })).rejects.toThrow(
      "Invalid transcript page boundary",
    );
    await expect(readTranscriptPage(cwd, id, { after: Number.NaN })).rejects.toThrow(
      "Invalid transcript page boundary",
    );
    await expect(readTranscriptPage(cwd, id, { before: 1, after: 0 })).rejects.toThrow(
      "Choose one transcript page boundary",
    );
  });

  it("handles missing files and stale page offsets after stream replacement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-transcript-empty-"));
    artifactDirs.push(cwd);
    expect((await readTranscriptPage(cwd, "w-missing-123")).blocks).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
    const { cwd: project, id, paths } = await workerArtifacts();
    await writeFile(paths[1], messageLine("Replacement message", 1));
    const page = await readTranscriptPage(project, id, { before: 99_999_999 });
    expect(page.blocks).toEqual([{ kind: "assistant", text: "Replacement message" }]);
    await expect(readTranscriptPage(project, "../escape")).rejects.toThrow("Invalid worker id");
  });
});

describe("Herdr worker transcript replay", () => {
  it("preserves complete user, thinking, and assistant text without summary limits", () => {
    const text = "Full response 😀\n".repeat(100);
    expect(
      replayTranscriptEvents([
        {
          type: "message_end",
          message: { role: "user", content: "Complete task\nSecond line", timestamp: 1 },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            timestamp: 2,
            content: [
              { type: "thinking", thinking: "Recorded thinking\nSecond thought" },
              { type: "text", text },
            ],
          },
        },
      ]),
    ).toEqual([
      { kind: "user", text: "Complete task\nSecond line" },
      { kind: "thinking", text: "Recorded thinking\nSecond thought" },
      { kind: "assistant", text },
    ]);
  });

  it("replaces streaming snapshots instead of repeating the same message", () => {
    const message = (text: string) => ({
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text }],
    });
    expect(
      replayTranscriptEvents([
        { type: "message_start", message: message("") },
        { type: "message_update", message: message("Partial") },
        { type: "message_update", message: message("Partial response") },
        { type: "message_end", message: message("Complete response") },
      ]),
    ).toEqual([{ kind: "assistant", text: "Complete response" }]);
    expect(
      replayTranscriptEvents([{ type: "message_update", message: message("Live response") }]),
    ).toEqual([{ kind: "assistant", text: "Live response" }]);
  });

  it("shows full tool arguments and results once, including streamed updates", () => {
    const args = { path: "source.ts", content: "Complete content\n".repeat(80) };
    const result = {
      content: [{ type: "text", text: "Complete output\n".repeat(80) }],
      details: { exitCode: 0 },
    };
    const blocks = replayTranscriptEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "write", arguments: args }],
        },
      },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "write",
        partialResult: { content: [{ type: "text", text: "Partial output" }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "write",
        result,
        isError: false,
      },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: result.content,
          details: result.details,
          isError: false,
        },
      },
    ]);
    expect(blocks.filter((block) => block.kind === "tool_call")).toHaveLength(1);
    expect(blocks.filter((block) => block.kind === "tool_result")).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "tool_call",
      toolName: "write",
      text: JSON.stringify(args, null, 2),
    });
    expect(blocks[1]).toMatchObject({
      kind: "tool_result",
      toolName: "write",
      text: result.content[0].text,
      isError: false,
    });
  });

  it("keeps repeated tool calls and distinct assistant turns in order", () => {
    const blocks = replayTranscriptEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "First turn" }],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "one",
        toolName: "read",
        args: { path: "same.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "one",
        toolName: "read",
        result: { content: "First result" },
        isError: false,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 2,
          content: [{ type: "text", text: "Second turn" }],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "two",
        toolName: "read",
        args: { path: "same.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "two",
        toolName: "read",
        result: { content: "Second result" },
        isError: true,
      },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual([
      "assistant",
      "tool_call",
      "tool_result",
      "assistant",
      "tool_call",
      "tool_result",
    ]);
    expect(blocks.at(-1)).toMatchObject({ text: "Second result", isError: true });
  });

  it("keeps legacy projected text and explicit worker errors without inventing missing content", () => {
    const blocks = replayTranscriptEvents([
      { kind: "assistant", text: "Legacy response\n".repeat(100) },
      { kind: "tool_end", tool: "read", detail: "Legacy tool output" },
      { type: "workers_end", status: "failed", error: "Worker failed\nFull error detail" },
    ]);
    expect(blocks.some((block) => block.text === "Legacy response\n".repeat(100))).toBe(true);
    expect(blocks.some((block) => block.text === "Legacy tool output")).toBe(true);
    expect(
      blocks.some((block) => block.kind === "error" && block.text.includes("Full error detail")),
    ).toBe(true);
  });

  it("retains string user messages and recorded custom notices", () => {
    const blocks = replayTranscriptEvents([
      {
        type: "message_end",
        message: { role: "user", content: "Full string task\nMore task text", timestamp: 1 },
      },
      {
        type: "message_end",
        message: {
          role: "custom",
          content: [{ type: "text", text: "Recorded notice" }],
          timestamp: 2,
        },
      },
    ]);
    expect(blocks).toEqual([
      { kind: "user", text: "Full string task\nMore task text" },
      { kind: "info", text: "Recorded notice" },
    ]);
  });

  it("retains recorded thinking and tool calls when a final snapshot omits them", () => {
    const blocks = replayTranscriptEvents([
      {
        type: "message_update",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [
            { type: "thinking", thinking: "Recorded thought" },
            {
              type: "toolCall",
              id: "call-retained",
              name: "read",
              arguments: { path: "complete-file.ts" },
            },
            { type: "text", text: "Draft" },
          ],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "Final response" }],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-retained",
        toolName: "read",
        args: { path: "complete-file.ts" },
      },
    ]);
    expect(
      blocks.some((block) => block.kind === "thinking" && block.text === "Recorded thought"),
    ).toBe(true);
    expect(blocks.filter((block) => block.kind === "tool_call")).toHaveLength(1);
    expect(
      blocks.some((block) => block.kind === "tool_call" && block.text.includes("complete-file.ts")),
    ).toBe(true);
    expect(blocks.filter((block) => block.kind === "assistant")).toEqual([
      { kind: "assistant", text: "Final response" },
    ]);
  });

  it("keeps explicit assistant errors and final legacy details", () => {
    const blocks = replayTranscriptEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [],
          errorMessage: "Provider failure\nComplete diagnostic",
        },
      },
      { kind: "end", status: "failed", detail: "Complete legacy diagnostic" },
    ]);
    expect(
      blocks.some(
        (block) => block.kind === "error" && block.text === "Provider failure\nComplete diagnostic",
      ),
    ).toBe(true);
    expect(blocks.some((block) => block.text.includes("Complete legacy diagnostic"))).toBe(true);
  });

  it("ignores malformed events and image-only content without changing its inputs", () => {
    const events = [
      null,
      [],
      "invalid",
      { type: { toString: null } },
      { type: "message_end", message: null },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "image", data: "not terminal text" }] },
      },
    ];
    const before = JSON.stringify(events);
    expect(replayTranscriptEvents(events)).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("Herdr Workers tab styling", () => {
  let restoreSizing: () => void;
  beforeEach(async () => {
    // Visual tests need ANSI-aware clipping and Unicode display-cell widths.
    const actual = await vi.importActual<typeof tui>("@earendil-works/pi-tui");
    const truncate = vi.spyOn(tui, "truncateToWidth").mockImplementation(actual.truncateToWidth);
    const width = vi.spyOn(tui, "visibleWidth").mockImplementation(actual.visibleWidth);
    restoreSizing = () => {
      truncate.mockRestore();
      width.mockRestore();
    };
  });
  afterEach(() => restoreSizing());

  async function captureFrame(cwd: string, list: string, rows = 28, columns = 90): Promise<string> {
    const controller = new AbortController();
    let frame = "";
    const output = {
      isTTY: true,
      rows,
      columns,
      write: vi.fn((text: string) => {
        if (text.startsWith("\u001b[H")) {
          frame = text;
          controller.abort();
        }
      }),
    };
    await runWorkersViewer(cwd, list, controller.signal, output);
    expect(output.write).toHaveBeenLastCalledWith("\u001b[?25h\u001b[?1049l");
    return frame;
  }

  function plainFrame(frame: string): string {
    return stripVTControlCharacters(frame);
  }

  it("uses our rounded frames, state colors, model details, and key hints", async () => {
    const { cwd, id, paths } = await workerArtifacts({
      model: "provider/model",
      status: "completed",
      outputText: "Checked all files",
    });
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id] }));
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const frame = await captureFrame(cwd, list);
    const plain = plainFrame(frame);
    expect(plain).toContain("╭");
    expect(plain).toContain("╰");
    expect(plain).toContain("Workers");
    expect(plain).toContain("scout");
    expect(plain).toContain("✓");
    expect(plain).toContain("provider/model");
    expect(plain).toContain("Checked all files");
    expect(plain).toContain("q: close monitor");
    expect(frame).toContain("\u001b[");
    expect(frame).toContain("\u001b[32m");
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });

  it.each([
    [8, 18],
    [12, 40],
    [24, 80],
    [6, 3],
    [4, 1],
  ])("fits a %i-row, %i-column terminal", async (rows, columns) => {
    const { cwd, id } = await workerArtifacts({
      name: "Long name 😀 ".repeat(12),
      error: "Failure ".repeat(100),
    });
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id, "w-second-123"] }));
    const frame = plainFrame(await captureFrame(cwd, list, rows, columns));
    const lines = frame.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(rows - 1);
    for (const line of lines)
      expect([...line].length).toBeLessThanOrEqual(Math.max(1, columns - 1));
  });

  it("keeps worker identity and newest activity visible in compact cards", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id] }));
    await writeFile(
      paths[1],
      Array.from({ length: 24 }, (_, index) =>
        JSON.stringify({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: `file-${index}.ts` },
        }),
      ).join("\n") + "\n",
    );
    const plain = plainFrame(await captureFrame(cwd, list, 12, 90));
    expect(plain).toContain(id);
    expect(plain).toContain("file-23.ts");
    expect(plain).toContain("running");
  });

  it.each([
    ["running", "◌", 33],
    ["failed", "✗", 31],
    ["timeout", "⏱", 33],
    ["cancelled", "⊘", 90],
  ])("uses the existing worker symbol for %s", async (status, icon, color) => {
    const { cwd, id } = await workerArtifacts({ status });
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id] }));
    const frame = await captureFrame(cwd, list);
    expect(plainFrame(frame)).toContain(icon);
    expect(plainFrame(frame)).toContain(status);
    expect(frame).toContain(`\u001b[${color}m`);
  });

  it("preserves card borders and status labels beside long Unicode names", async () => {
    const { cwd, id } = await workerArtifacts({ name: "Long name 😀 ".repeat(12) });
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id] }));
    const plain = plainFrame(await captureFrame(cwd, list, 24, 60));
    expect(plain).toContain("running");
    for (const line of plain.trimEnd().split("\n")) {
      if (line.includes("╭")) expect(line.trimEnd()).toMatch(/╮(?:\s*│)?$/u);
      if (line.includes("╰")) expect(line.trimEnd()).toMatch(/╯(?:\s*│)?$/u);
    }
  });

  it("shows the close key before page hints in a narrow terminal", async () => {
    const { cwd } = await workerArtifacts();
    const plain = plainFrame(await captureFrame(cwd, join(cwd, "missing.json"), 8, 18));
    expect(plain).toContain("q: close");
  });

  it("gives the empty Workers tab a framed read-only state", async () => {
    const { cwd } = await workerArtifacts();
    const plain = plainFrame(await captureFrame(cwd, join(cwd, "missing.json")));
    expect(plain).toContain("╭");
    expect(plain).toContain("No monitored workers");
    expect(plain).toContain("Read-only");
    expect(plain).toContain("q: close monitor");
  });
});

describe("Herdr workspace Workers viewer", () => {
  it("combines live sessions from different projects without changing worker artifacts", async () => {
    const first = await workerArtifacts();
    const second = await workerArtifacts({
      name: "second",
      status: "completed",
      outputText: "Second project report",
    });
    const list = join(first.cwd, "workspace-workers.json");
    await writeFile(
      list,
      JSON.stringify({
        sources: [
          {
            name: "one",
            pid: process.pid,
            updatedAt: Date.now(),
            cwd: first.cwd,
            workerIds: [first.id],
          },
          {
            name: "two",
            pid: process.pid,
            updatedAt: Date.now(),
            cwd: second.cwd,
            workerIds: [second.id],
          },
        ],
      }),
    );
    const refs = await readWorkerReferences(first.cwd, list);
    expect(refs).toEqual([
      { cwd: first.cwd, id: first.id },
      { cwd: second.cwd, id: second.id },
    ]);
    const before = await Promise.all(
      [...first.paths, ...second.paths].map((path) => readFile(path)),
    );
    const text = (await readWorkspaceWorkersView(refs)).join("\n");
    expect(text).toContain(first.cwd);
    expect(text).toContain(second.cwd);
    expect(text).toContain("Status: running");
    expect(text).toContain("Second project report");
    expect(
      await Promise.all([...first.paths, ...second.paths].map((path) => readFile(path))),
    ).toEqual(before);
  });

  it("ignores dead and expired registrations and rejects malformed sources", async () => {
    const { cwd, id } = await workerArtifacts();
    const list = join(cwd, "workspace-workers.json");
    const live = { name: "live", pid: process.pid, updatedAt: Date.now(), cwd, workerIds: [id] };
    await writeFile(
      list,
      JSON.stringify({
        sources: [
          live,
          { ...live, name: "expired", updatedAt: Date.now() - 61_000, workerIds: ["w-old-123"] },
          { ...live, name: "dead", pid: 999_999_999, workerIds: ["w-dead-123"] },
        ],
      }),
    );
    expect(await readWorkerReferences(cwd, list)).toEqual([{ cwd, id }]);
    await writeFile(list, JSON.stringify({ sources: [{ ...live, workerIds: ["../escape"] }] }));
    await expect(readWorkerReferences(cwd, list)).rejects.toThrow("Invalid worker monitor list");
  });

  it("shows workers from both projects in the shared viewer", async () => {
    const first = await workerArtifacts();
    const second = await workerArtifacts({ name: "second" });
    const list = join(first.cwd, "workspace-workers.json");
    await writeFile(
      list,
      JSON.stringify({
        sources: [
          {
            name: "one",
            pid: process.pid,
            updatedAt: Date.now(),
            cwd: first.cwd,
            workerIds: [first.id],
          },
          {
            name: "two",
            pid: process.pid,
            updatedAt: Date.now(),
            cwd: second.cwd,
            workerIds: [second.id],
          },
        ],
      }),
    );
    const controller = new AbortController();
    const output = { rows: 40, write: vi.fn((_text: string) => controller.abort()) };
    await runWorkersViewer(first.cwd, list, controller.signal, output);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("Workers: 2"));
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining(second.cwd));
  });
});

describe("Herdr shared Workers viewer", () => {
  it("shows running and completed workers in one bounded read-only snapshot", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const second = "w-second-123";
    await writeFile(
      recordPath(cwd, second),
      JSON.stringify({
        id: second,
        name: "second",
        status: "completed",
        outputText: "Final second report",
      }),
    );
    await writeFile(
      paths[1],
      `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "recent.ts" } })}\n`,
    );
    const before = await Promise.all(
      [...paths, recordPath(cwd, second)].map((path) => readFile(path)),
    );
    const lines = await readWorkersView(cwd, [id, second]);
    expect(lines.join("\n")).toContain("Status: running");
    expect(lines.join("\n")).toContain("Status: completed");
    expect(lines.join("\n")).toContain("recent.ts");
    expect(lines.join("\n")).toContain("Final second report");
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(
      await Promise.all([...paths, recordPath(cwd, second)].map((path) => readFile(path))),
    ).toEqual(before);
  });

  it("reads only validated worker ids from a bounded transient list", async () => {
    const { cwd, id } = await workerArtifacts();
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id, "w-other-123"] }));
    expect(await readWorkerIds(list)).toEqual([id, "w-other-123"]);
    await writeFile(list, JSON.stringify({ workerIds: ["../escape"] }));
    await expect(readWorkerIds(list)).rejects.toThrow("Invalid worker monitor list");
    await writeFile(list, "x".repeat(70_000));
    await expect(readWorkerIds(list)).rejects.toThrow("Worker monitor list unavailable");
    expect(await readWorkerIds(join(cwd, "missing.json"))).toEqual([]);
  });

  it("pages workers with arrow keys and restores input on quit", async () => {
    const { cwd, id } = await workerArtifacts();
    const list = join(cwd, "worker-ids.json");
    await writeFile(list, JSON.stringify({ workerIds: [id, "w-second-123"] }));
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      isPaused: () => true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
    const frames: string[] = [];
    const output = {
      isTTY: true,
      rows: 12,
      columns: 100,
      write: vi.fn((text: string) => {
        if (text.includes("Workers")) {
          frames.push(text);
          input.emit("data", frames.length === 1 ? "\u001b[B" : "q");
        }
      }),
    };
    await runWorkersViewer(cwd, list, new AbortController().signal, output, input);
    expect(frames[0]).toContain(id);
    expect(frames[1]).toContain("w-second-123");
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.pause).toHaveBeenCalledWith();
    expect(input.listenerCount("data")).toBe(0);
    expect(output.write).toHaveBeenLastCalledWith("\u001b[?25h\u001b[?1049l");
  });

  it("shows an empty shared pane without creating worker artifacts", async () => {
    const { cwd } = await workerArtifacts();
    const controller = new AbortController();
    const output = { write: vi.fn((_text: string) => controller.abort()) };
    await runWorkersViewer(cwd, join(cwd, "missing-list.json"), controller.signal, output);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("No monitored workers"));
  });
});

describe("Herdr standalone worker viewer", () => {
  it("loads the standalone viewer in the real Node runtime without runner side effects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-herdr-runtime-"));
    artifactDirs.push(cwd);
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../extensions/herdr/src/worker-viewer.ts"),
    ).href;
    const script = `import { runWorkerViewer } from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      const output = { write(text) { process.stdout.write(text); controller.abort(); } };
      await runWorkerViewer(${JSON.stringify(cwd)}, "w-runtime-123", controller.signal, output);`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    expect(result.stdout).toContain("Worker record unavailable");
    expect(result.stderr).toBe("");
    expect(await readdir(cwd)).toEqual([]);
  });
  it("does not write a terminal frame after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = { isTTY: true, write: vi.fn() };
    await runWorkerViewer("/tmp", "w-test-123", controller.signal, output);
    expect(output.write).not.toHaveBeenCalled();
  });

  it("rejects an invalid worker id before the refresh loop", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWorkerViewer("/tmp", "../other", controller.signal, { write: vi.fn() }),
    ).rejects.toThrow("Invalid worker id");
  });

  it("keeps the newest activity visible in a short pane", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    const events = Array.from({ length: 24 }, (_, n) =>
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: `file-${n}.ts` },
      }),
    );
    await writeFile(paths[1], `${events.join("\n")}\n`);
    const controller = new AbortController();
    const output = {
      isTTY: true,
      rows: 8,
      columns: 80,
      write: vi.fn((text: string) => {
        if (text.includes("Status: running")) controller.abort();
        return true;
      }),
    };
    await runWorkerViewer(cwd, id, controller.signal, output);
    expect(output.write).toHaveBeenNthCalledWith(2, expect.stringContaining("file-23.ts"));
    expect(output.write).toHaveBeenNthCalledWith(2, expect.stringContaining("Status: running"));
  });

  it("restores terminal state on exit without changing worker artifacts", async () => {
    const { cwd, id, paths } = await workerArtifacts({
      status: "completed",
      outputText: "Final report",
    });
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const controller = new AbortController();
    const output = {
      isTTY: true,
      rows: 24,
      columns: 80,
      write: vi.fn((text: string) => {
        if (text.includes("Status: completed")) controller.abort();
        return true;
      }),
    };
    await runWorkerViewer(cwd, id, controller.signal, output);
    expect(output.write).toHaveBeenNthCalledWith(1, "\u001b[?1049h\u001b[?25l");
    expect(output.write).toHaveBeenNthCalledWith(2, expect.stringContaining("Status: completed"));
    expect(output.write).toHaveBeenLastCalledWith("\u001b[?25h\u001b[?1049l");
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });
});

describe("Herdr read-only worker viewer", () => {
  it("shows missing artifacts without creating worker files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-herdr-missing-"));
    artifactDirs.push(cwd);
    const lines = await readWorkerView(cwd, "w-missing-123");
    expect(lines.join("\n")).toContain("Worker record unavailable");
    expect(await readdir(cwd)).toEqual([]);
  });

  it("reads raw activity, final status, report, and stderr without changing artifacts", async () => {
    const { cwd, id, paths } = await workerArtifacts({
      status: "completed",
      outputText: "Final report",
      model: "test/model",
    });
    await writeFile(
      paths[1],
      `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" } })}\n`,
    );
    await writeFile(paths[2], "Captured stderr\n");
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const text = (await readWorkerView(cwd, id)).join("\n");
    expect(text).toContain("scout");
    expect(text).toContain("Status: completed");
    expect(text).toContain("read src/app.ts");
    expect(text).toContain("Final report");
    expect(text).toContain("Captured stderr");
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });

  it("reads legacy projected streams", async () => {
    const { cwd, id, paths } = await workerArtifacts({ streamFormat: null });
    await writeFile(
      paths[1],
      `${JSON.stringify({ kind: "tool_start", tool: "bash", detail: "npm test" })}\n`,
    );
    expect((await readWorkerView(cwd, id)).join("\n")).toContain("bash npm test");
  });

  it("ignores malformed and partial records, then shows a completed event", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    await writeFile(
      paths[1],
      'null\n[]\n42\nnot json\n{"type":"tool_execution_start","toolName":"read","args":',
    );
    expect((await readWorkerView(cwd, id)).join("\n")).not.toContain("read app.ts");
    await appendFile(paths[1], '{"path":"app.ts"}}\n');
    expect((await readWorkerView(cwd, id)).join("\n")).toContain("read app.ts");
  });

  it("removes terminal controls from every worker-controlled field", async () => {
    const unsafe = "unsafe\u001b]52;c;clipboard\u0007\r\b\u009b31m\u202e";
    const { cwd, id, paths } = await workerArtifacts({
      name: unsafe,
      outputText: unsafe,
      error: unsafe,
    });
    await writeFile(paths[1], `${JSON.stringify({ type: "workers_start", task: unsafe })}\n`);
    await writeFile(paths[2], unsafe);
    const text = (await readWorkerView(cwd, id)).join("\n");
    expect(text).toContain("unsafe");
    expect(text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("bounds stream, stderr, report, and rendered line lengths", async () => {
    const { cwd, id, paths } = await workerArtifacts({
      status: "completed",
      outputText: "report ".repeat(20_000),
    });
    await writeFile(
      paths[1],
      `${JSON.stringify({ type: "workers_start", task: "old activity" })}\n${"x".repeat(100_000)}\n${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "recent.ts" } })}\n`,
    );
    await writeFile(paths[2], `old stderr\n${"x".repeat(100_000)}\nrecent stderr\n`);
    const lines = await readWorkerView(cwd, id);
    expect(lines.join("\n")).toContain("recent.ts");
    expect(lines.join("\n")).toContain("recent stderr");
    expect(lines.join("\n")).not.toContain("old activity");
    expect(lines.join("\n")).not.toContain("old stderr");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines.every((line) => line.length <= 240)).toBe(true);
  });

  it("rejects path traversal before reading files", async () => {
    await expect(readWorkerView("/tmp", "../other")).rejects.toThrow("Invalid worker id");
  });

  it("keeps output readable when a record is corrupt, mismatched, or oversized", async () => {
    const { cwd, id, paths } = await workerArtifacts();
    for (const value of ["null", '{"id":"w-other-123","status":"running"}', "x".repeat(300_000)]) {
      await writeFile(paths[0], value);
      expect((await readWorkerView(cwd, id)).join("\n")).toContain("Worker record unavailable");
    }
  });
});

function workerEntry(id: string, status = "running") {
  return { type: "custom", customType: "worker-record", data: { id, name: id, status } };
}

function paneRequests(method: string): MetadataRequest[] {
  return requests.filter((request) => request.method === method);
}

function monitorListPath(): string {
  const command = paneRequests("pane.send_input")[0]?.params.text;
  const path = command?.match(/'([^']+\/worker-ids\.json)'$/)?.[1];
  if (!path) throw new Error("Missing shared worker monitor list");
  return path;
}

describe("Herdr workspace monitor ownership", () => {
  it("shares one Workers tab across sessions and keeps panes until the last contributor stops", async () => {
    const first = await setup("tui", "w1:p1");
    const second = await setup("tui", "w1:p9");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await first.start();
    const list = monitorListPath();
    await second.start();
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect((await readWorkerReferences(first.ctx.cwd, list)).map((ref) => ref.id).sort()).toEqual([
      "w-first-123",
      "w-second-123",
    ]);
    await first.stop();
    expect(paneRequests("pane.close")).toHaveLength(0);
    expect((await readWorkerReferences(second.ctx.cwd, list)).map((ref) => ref.id)).toEqual([
      "w-second-123",
    ]);
    await second.stop();
    expect(paneRequests("pane.close").map((req) => req.params.pane_id)).toEqual(["w1:p2", "w1:p3"]);
    await expect(readFile(list)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("separates different workspaces and different Herdr servers", async () => {
    const first = await setup("tui", "w1:p1");
    const second = await setup("tui", "w2:p1");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await first.start();
    const firstList = monitorListPath();
    await second.start();
    expect(second.ctx.ui.notify.mock.calls).toEqual([]);
    const otherCommand = paneRequests("pane.send_input")[1].params.text;
    const secondList = otherCommand?.match(/'([^']+\/worker-ids\.json)'$/)?.[1];
    if (!secondList) throw new Error("Missing second workspace list");
    expect(secondList).not.toBe(firstList);
    expect((await readWorkerReferences(first.ctx.cwd, firstList)).map((ref) => ref.id)).toEqual([
      "w-first-123",
    ]);
    expect((await readWorkerReferences(second.ctx.cwd, secondList)).map((ref) => ref.id)).toEqual([
      "w-second-123",
    ]);
    vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/herdr-other-server.sock");
    const third = await setup("tui", "w1:p8");
    third.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-third-123")]);
    await third.start();
    expect(paneRequests("tab.create")).toHaveLength(3);
  });

  it("serializes simultaneous first contributors without duplicate panes", async () => {
    const first = await setup("tui", "w1:p1");
    const second = await setup("tui", "w1:p9");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    let finished = false;
    const starting = Promise.all([first.start(), second.start()]).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(finished).toBe(true));
    await starting;
    expect(first.ctx.ui.notify.mock.calls).toEqual([]);
    expect(second.ctx.ui.notify.mock.calls).toEqual([]);
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(paneRequests("pane.split")).toHaveLength(1);
  });

  it("does not reopen a manually closed workspace pane for another Pi session", async () => {
    const first = await setup("tui", "w1:p1");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await first.start();
    closedPanes.add("w1:p2");
    const second = await setup("tui", "w1:p9");
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await second.start();
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.send_input")).toHaveLength(1);
    await first.stop();
    await second.stop();
    expect(paneRequests("pane.close")).toHaveLength(0);
  });

  it("does not close a reused pane identifier after the server socket is replaced", async () => {
    const socketPath = join(vi.mocked(getAgentDir)(), "api.sock");
    await writeFile(socketPath, "first server");
    vi.stubEnv("HERDR_SOCKET_PATH", socketPath);
    const first = await setup("tui", "w1:p1");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await first.start();
    await writeFile(`${socketPath}.next`, "second server");
    await rename(`${socketPath}.next`, socketPath);
    paneCounter = 1;
    const second = await setup("tui", "w1:p9");
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await second.start();
    expect(paneRequests("tab.create")).toHaveLength(2);
    await first.stop();
    expect(paneRequests("pane.close")).toHaveLength(0);
    await second.stop();
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual(["w1:p2"]);
  });

  it("accepts reused monitor identifiers in a replacement server", async () => {
    const socketPath = join(vi.mocked(getAgentDir)(), "api.sock");
    await writeFile(socketPath, "first server");
    vi.stubEnv("HERDR_SOCKET_PATH", socketPath);
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await fixture.start();
    await writeFile(`${socketPath}.next`, "second server");
    await rename(`${socketPath}.next`, socketPath);
    paneCounter = 1;
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-first-123"),
      workerEntry("w-next-123"),
    ]);
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("tab.create")).toHaveLength(2));
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(3));
    expect(fixture.ctx.ui.notify.mock.calls).toEqual([]);
  });

  it("does not create panes for worker ids present only in an expired source", async () => {
    const first = await setup("tui", "w1:p1");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await first.start();
    const list = monitorListPath();
    const source = JSON.parse(await readFile(list, "utf8")).sources[0];
    await writeFile(
      join(dirname(list), "sources", `${encodeURIComponent(source.name)}.json`),
      JSON.stringify({
        ...source,
        workerIds: ["w-first-123", "w-expired-123"],
        updatedAt: Date.now() - 61_000,
      }),
    );
    const second = await setup("tui", "w1:p9");
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await second.start();
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(
      paneRequests("pane.send_input").some((request) =>
        request.params.text?.includes("'w-expired-123'"),
      ),
    ).toBe(false);
  });

  it("keeps a live contributor's pane when its heartbeat is stale", async () => {
    const first = await setup("tui", "w1:p1");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await first.start();
    const list = monitorListPath();
    const source = JSON.parse(await readFile(list, "utf8")).sources[0];
    await writeFile(
      join(dirname(list), "sources", `${encodeURIComponent(source.name)}.json`),
      JSON.stringify({ ...source, updatedAt: Date.now() - 61_000 }),
    );
    const second = await setup("tui", "w1:p9");
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await second.start();
    await second.stop();
    expect(paneRequests("pane.close")).toHaveLength(0);
    await first.stop();
    expect(paneRequests("pane.close")).toHaveLength(2);
  });

  it("does not close a pane whose terminal identity no longer matches", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    await fixture.start();
    respond = (socket, req) => {
      if (req.method === "pane.get" && req.params.pane_id === "w1:p2")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: req.id, result: { pane: { ...paneInfo("w1:p2"), terminal_id: "another-terminal" } } })}\n`,
          ),
        );
      else acknowledge(socket, req);
    };
    await fixture.stop();
    expect(paneRequests("pane.close")).toHaveLength(0);
  });

  it("moves a contributor to another workspace without closing another session's shared pane", async () => {
    const first = await setup("tui", "w1:p1");
    const second = await setup("tui", "w1:p9");
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-first-123")]);
    second.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-second-123")]);
    await first.start();
    const oldList = monitorListPath();
    await second.start();
    movedParents.set("w1:p1", "w2");
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(paneRequests("tab.create")).toHaveLength(2));
    expect(paneRequests("pane.close")).toHaveLength(0);
    expect((await readWorkerReferences(second.ctx.cwd, oldList)).map((ref) => ref.id)).toEqual([
      "w-second-123",
    ]);
  });
});

describe("Herdr automatic worker monitors", () => {
  it("opens one transcript pane per initial and later worker in one Workers tab", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.rename")[0].params).toEqual({
      pane_id: "w1:p2",
      label: "Worker w-owned-1",
    });
    expect(paneRequests("pane.split")).toHaveLength(1);
    expect(paneRequests("pane.split")[0].params).toEqual({
      target_pane_id: "w1:p2",
      direction: "right",
      cwd: fixture.ctx.cwd,
      focus: false,
    });
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(paneRequests("pane.send_input")[0].params.text).toContain("'--transcript' 'w-owned-1'");
    expect(paneRequests("pane.send_input")[1].params.text).toContain("'--transcript' 'w-owned-2'");
    const path = monitorListPath();
    expect((await readWorkerReferences(fixture.ctx.cwd, path)).map((ref) => ref.id)).toEqual([
      "w-owned-1",
      "w-owned-2",
    ]);
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1", "completed"),
      workerEntry("w-owned-2"),
      workerEntry("w-owned-3"),
    ]);
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    await vi.waitFor(async () =>
      expect((await readWorkerReferences(fixture.ctx.cwd, path)).map((ref) => ref.id)).toEqual([
        "w-owned-1",
        "w-owned-2",
        "w-owned-3",
      ]),
    );
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.send_input")).toHaveLength(3);
    expect(paneRequests("pane.split")).toHaveLength(2);
    expect(paneRequests("pane.split")[1].params.target_pane_id).toBe("w1:p3");
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual(["w1:p2"]);
  });

  it("deduplicates the same project worker across sessions but separates matching ids in different projects", async () => {
    const first = await setup("tui", "w1:p1");
    const sameProject = await setup("tui", "w1:p9");
    const differentProject = await setup("tui", "w1:p8");
    first.ctx.cwd = "/projects/first";
    sameProject.ctx.cwd = "/projects/first";
    differentProject.ctx.cwd = "/projects/second";
    for (const fixture of [first, sameProject, differentProject])
      fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-shared-1")]);
    let finished = false;
    const starting = Promise.all([
      first.start(),
      sameProject.start(),
      differentProject.start(),
    ]).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(finished).toBe(true));
    await starting;
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(2));
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.split")).toHaveLength(1);
    const commands = paneRequests("pane.send_input").map((request) => request.params.text ?? "");
    expect(
      commands.some((command) => command.includes("'/projects/first' '--transcript' 'w-shared-1'")),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.includes("'/projects/second' '--transcript' 'w-shared-1'"),
      ),
    ).toBe(true);
    expect(paneRequests("tab.focus")).toHaveLength(0);
    expect(paneRequests("pane.focus")).toHaveLength(0);
  });

  it("migrates a validated legacy shared monitor within its tab before closing it", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    const state = join(dirname(monitorListPath()), "pane.json");
    await writeFile(
      state,
      JSON.stringify({
        phase: "active",
        pane: { paneId: "w1:p2", workspaceId: "w1", terminalId: "terminal-w1:p2" },
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(2));
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.split")[0].params.target_pane_id).toBe("w1:p2");
    // The legacy close follows the replacement launch in the same update; on
    // slow machines the send_input request can log between the two writes.
    await vi.waitFor(() => {
      const replacement = requests.findIndex(
        (request) => request.method === "pane.send_input" && request.params.pane_id === "w1:p3",
      );
      const removal = requests.findIndex(
        (request) => request.method === "pane.close" && request.params.pane_id === "w1:p2",
      );
      expect(replacement).toBeGreaterThanOrEqual(0);
      expect(removal).toBeGreaterThan(replacement);
    });
    // The replacement launch precedes the legacy close and final slot write.
    await vi.waitFor(async () => {
      const slot = JSON.parse(await readFile(state, "utf8"));
      expect(slot.pane).toBeUndefined();
    });
    const slot = JSON.parse(await readFile(state, "utf8"));
    expect(Object.values(slot.workers)).toHaveLength(1);
  });

  it("suppresses a manually closed worker while adding other workers to the surviving tab", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    closedPanes.add("w1:p2");
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
      workerEntry("w-owned-3"),
    ]);
    fixture.emit("workers:state", { running: 3 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(3));
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.split")[1].params.target_pane_id).toBe("w1:p3");
    expect(
      paneRequests("pane.send_input").filter((request) =>
        request.params.text?.includes("'w-owned-1'"),
      ),
    ).toHaveLength(1);
    await fixture.stop();
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
      "w1:p3",
      "w1:p4",
    ]);
  });

  it("keeps workspace-wide closure suppression when every owned worker pane disappears", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    closedPanes.add("w1:p2");
    closedPanes.add("w1:p3");
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
      workerEntry("w-owned-3"),
    ]);
    fixture.emit("workers:state", { running: 3 });
    await flushUpdates();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(paneRequests("pane.split")).toHaveLength(1);
  });

  it("rejects a split response that reuses another owned pane", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    respond = (socket, request) => {
      if (request.method === "pane.split")
        socket.emit(
          "data",
          Buffer.from(
            JSON.stringify({ id: request.id, result: { pane: paneInfo("w1:p3") } }) + "\n",
          ),
        );
      else acknowledge(socket, request);
    };
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
      workerEntry("w-owned-3"),
    ]);
    fixture.emit("workers:state", { running: 3 });
    await flushUpdates();
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(paneRequests("pane.close")).toHaveLength(0);
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("invalid monitor pane identifier"),
        "warning",
      ),
    );
  });

  it("records a pending split and closes its late response without launching after shutdown", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    let pending: { socket: TestSocket; request: MetadataRequest } | undefined;
    respond = (socket, request) => {
      if (request.method === "pane.split") pending = { socket, request };
      else acknowledge(socket, request);
    };
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    await vi.waitFor(() => expect(pending).toBeDefined());
    const state = JSON.parse(await readFile(join(dirname(monitorListPath()), "pane.json"), "utf8"));
    expect(
      Object.values(state.workers).some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "phase" in value &&
          value.phase === "pending",
      ),
    ).toBe(true);
    const stopping = fixture.stop();
    paneTabs.set("w1:p3", paneTabs.get("w1:p2") ?? "w1:t-workers-2");
    if (!pending) throw new Error("Missing delayed split request");
    pending.socket.emit(
      "data",
      Buffer.from(
        JSON.stringify({ id: pending.request.id, result: { pane: paneInfo("w1:p3") } }) + "\n",
      ),
    );
    await stopping;
    expect(paneRequests("pane.send_input")).toHaveLength(1);
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
      "w1:p3",
      "w1:p2",
    ]);
    expect(paneRequests("tab.close")).toHaveLength(0);
  });

  it("does not split or close an owned pane moved into another tab", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    paneTabs.set("w1:p2", "w1:t-operator");
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    await fixture.stop();
    expect(paneRequests("pane.split")).toHaveLength(0);
    expect(paneRequests("pane.send_input")).toHaveLength(1);
    expect(paneRequests("pane.close")).toHaveLength(0);
  });

  it("updates removed workers and deletes only its transient list on shutdown", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    const path = monitorListPath();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
      { type: "custom", customType: "worker-removed", data: { id: "w-owned-1" } },
    ]);
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    await vi.waitFor(async () =>
      expect((await readWorkerReferences(fixture.ctx.cwd, path)).map((ref) => ref.id)).toEqual([
        "w-owned-2",
      ]),
    );
    await fixture.stop();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(paneRequests("pane.close")).toHaveLength(2);
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
  });
  it("opens an unfocused pane for a restored running worker, not finished or foreign workers", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-finished-1", "completed"),
    ]);
    await fixture.start();
    await flushUpdates();
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("tab.create")[0].params).toEqual({
      workspace_id: "w1",
      label: "Workers",
      cwd: fixture.ctx.cwd,
      focus: false,
    });
    expect(paneRequests("pane.split")).toHaveLength(0);
    expect(paneRequests("tab.focus")).toHaveLength(0);
    expect(paneRequests("pane.send_input")[0].params).toEqual({
      pane_id: "w1:p2",
      text: expect.stringContaining("--transcript"),
      keys: ["enter"],
    });
    expect(paneRequests("pane.focus")).toHaveLength(0);
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
    expect(fixture.pi.exec).not.toHaveBeenCalled();
  });

  it("opens new workers once even when formatted worker metadata stays unchanged", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-new-1")]);
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(1));
    expect(paneRequests("tab.create")).toHaveLength(1);
  });

  it("closes a successfully completed monitor immediately and does not reopen it", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", "completed")]);
    fixture.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.waitFor(() =>
      expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
        "w1:p2",
      ]),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await fixture.stop();
    expect(paneRequests("pane.close")).toHaveLength(1);
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(fixture.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["failed", "timeout", "cancelled"] as const)(
    "keeps %s worker panes for inspection",
    async (status) => {
      const fixture = await setup();
      fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
      await fixture.start();
      fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", status)]);
      fixture.emit("workers:state", { running: 0 });
      await flushUpdates();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(paneRequests("pane.close")).toHaveLength(0);
      expect(paneRequests("pane.send_input")).toHaveLength(1);
    },
  );

  it("opens later workers after all prior panes closed automatically", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", "completed")]);
    fixture.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.close")).toHaveLength(1));
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1", "completed"),
      workerEntry("w-owned-2"),
    ]);
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(2));
    expect(paneRequests("tab.create")).toHaveLength(2);
    expect(paneRequests("pane.split")).toHaveLength(0);
    expect(paneRequests("pane.focus")).toHaveLength(0);
    expect(paneRequests("tab.close")).toHaveLength(0);
  });

  it("allows future workers after individual manual closure and remaining automatic closure", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    closedPanes.add("w1:p2");
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(async () => {
      const state = JSON.parse(
        await readFile(join(dirname(monitorListPath()), "pane.json"), "utf8"),
      );
      expect(
        Object.values(state.workers).some(
          (child: any) => child.worker.id === "w-owned-1" && child.phase === "closed",
        ),
      ).toBe(true);
    });
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2", "completed"),
    ]);
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    await vi.waitFor(() =>
      expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
        "w1:p3",
      ]),
    );
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2", "completed"),
      workerEntry("w-owned-3"),
    ]);
    fixture.emit("workers:state", { running: 2 });
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.send_input")).toHaveLength(3));
    expect(paneRequests("tab.create")).toHaveLength(2);
  });

  it("closes a validated legacy shared pane when its last worker completes", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await writeFile(
      join(dirname(monitorListPath()), "pane.json"),
      JSON.stringify({
        phase: "active",
        pane: { paneId: "w1:p2", workspaceId: "w1", terminalId: "terminal-w1:p2" },
      }),
    );
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", "completed")]);
    fixture.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.waitFor(() =>
      expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
        "w1:p2",
      ]),
    );
    expect(paneRequests("pane.split")).toHaveLength(0);
    expect(paneRequests("pane.send_input")).toHaveLength(1);
  });

  it("does not open panes for workers first observed after successful completion", async () => {
    const fixture = await setup();
    const monitors = createWorkerMonitors({
      socketPath: "/tmp/herdr-test.sock",
      parentPaneId: "w1:p1",
      cwd: fixture.ctx.cwd,
      warn: (error) => {
        throw error;
      },
    });
    try {
      await monitors.refresh([]);
      await monitors.refresh([workerEntry("w-fast-1", "completed")]);
      expect(paneRequests("tab.create")).toHaveLength(0);
      expect(paneRequests("pane.send_input")).toHaveLength(0);
    } finally {
      await monitors.stop();
    }
  });

  it("keeps completion closed across stale contributors and separates project identities", async () => {
    const first = await setup("tui", "w1:p1");
    const stale = await setup("tui", "w1:p9");
    const other = await setup("tui", "w1:p8");
    first.ctx.cwd = stale.ctx.cwd = "/projects/first";
    other.ctx.cwd = "/projects/second";
    for (const fixture of [first, stale, other])
      fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-shared-1")]);
    await first.start();
    await stale.start();
    await other.start();
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    first.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-shared-1", "completed")]);
    first.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.waitFor(() =>
      expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
        "w1:p2",
      ]),
    );
    let firstStopped = false;
    const stoppingFirst = first.stop().then(() => {
      firstStopped = true;
    });
    await vi.waitFor(() => expect(firstStopped).toBe(true));
    await stoppingFirst;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.send_input")).toHaveLength(2);
    expect(paneRequests("pane.close")).toHaveLength(1);
    let othersStopped = false;
    const stoppingOthers = Promise.all([stale.stop(), other.stop()]).then(() => {
      othersStopped = true;
    });
    await vi.waitFor(() => expect(othersStopped).toBe(true));
    await stoppingOthers;
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
      "w1:p2",
      "w1:p3",
    ]);
  });

  it("retries failed automatic closes without losing pane ownership", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    respond = (socket, request) => {
      if (request.method === "pane.close")
        socket.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              id: request.id,
              error: { code: "unavailable", message: "close unavailable" },
            }) + "\n",
          ),
        );
      else acknowledge(socket, request);
    };
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", "completed")]);
    fixture.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("close unavailable"),
        "warning",
      ),
    );
    respond = acknowledge;
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(paneRequests("pane.close")).toHaveLength(2));
    await fixture.stop();
    expect(paneRequests("pane.close")).toHaveLength(2);
  });

  it("does not automatically close a completed pane with a recycled terminal identity", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    respond = (socket, request) => {
      if (request.method === "pane.get" && request.params.pane_id === "w1:p2")
        socket.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              id: request.id,
              result: { pane: { ...paneInfo("w1:p2"), terminal_id: "operator-terminal" } },
            }) + "\n",
          ),
        );
      else acknowledge(socket, request);
    };
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1", "completed")]);
    fixture.emit("workers:state", { running: 0 });
    await flushUpdates();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paneRequests("pane.close")).toHaveLength(0);
    expect(paneRequests("pane.send_input")).toHaveLength(1);
  });

  it("closes only returned monitor pane identifiers on shutdown", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      workerEntry("w-owned-1"),
      workerEntry("w-owned-2"),
    ]);
    await fixture.start();
    await flushUpdates();
    await fixture.stop();
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual([
      "w1:p2",
      "w1:p3",
    ]);
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open monitors after shutdown or outside terminal mode", async () => {
    const fixture = await setup("json");
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    expect(paneRequests("tab.create")).toHaveLength(0);
    await fixture.stop();
    await fireCostEvent(fixture, "turn_end");
    expect(paneRequests("tab.create")).toHaveLength(0);
  });

  it("rejects a returned parent pane identifier instead of running commands or closing it", async () => {
    respond = (socket, request) => {
      if (request.method === "tab.create")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, result: { root_pane: paneInfo("w1:p1") } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    await fixture.stop();
    expect(paneRequests("pane.send_input")).toHaveLength(0);
    expect(paneRequests("pane.close")).toHaveLength(0);
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("invalid monitor pane identifier"),
      "warning",
    );
  });

  it("ignores cleanup for a monitor that the user already closed", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    respond = (socket, request) => {
      if (request.method === "pane.close")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, error: { code: "not_found", message: "pane missing" } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    await fixture.stop();
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates a dedicated tab without changing the parent layout", async () => {
    respond = (socket, request) => {
      if (request.method === "pane.layout") {
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 60 } }] } } })}\n`,
          ),
        );
      } else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    expect(paneRequests("tab.create")[0].params.label).toBe("Workers");
    expect(paneRequests("pane.layout")).toHaveLength(0);
    expect(paneRequests("pane.split")).toHaveLength(0);
  });

  it("quotes trusted program paths and cwd without including worker text in the command", async () => {
    const fixture = await setup();
    fixture.ctx.cwd = "/tmp/project '$(touch injected)'";
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      {
        ...workerEntry("w-owned-1"),
        data: {
          ...workerEntry("w-owned-1").data,
          task: "$(touch task-injected)",
          outputText: "malicious output",
        },
      },
    ]);
    await fixture.start();
    await flushUpdates();
    const command = paneRequests("pane.send_input")[0].params.text;
    expect(command).toContain("worker-viewer.ts");
    expect(command).toContain("'\\''");
    expect(command).not.toContain("task-injected");
    expect(command).not.toContain("malicious output");
  });

  it("warns once and does not repeatedly create tabs when pane launch fails", async () => {
    respond = (socket, request) => {
      if (request.method === "pane.send_input")
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, error: { message: "launch failed" } })}\n`,
          ),
        );
      else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    fixture.emit("workers:state", { running: 1 });
    await flushUpdates();
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("launch failed"),
      "warning",
    );
    expect(paneRequests("tab.create")).toHaveLength(1);
    expect(paneRequests("pane.close")).toHaveLength(1);
  });

  it("clears a tab created during shutdown without launching a viewer", async () => {
    let delayed: { socket: TestSocket; request: MetadataRequest } | undefined;
    respond = (socket, request) => {
      if (request.method === "tab.create") delayed = { socket, request };
      else acknowledge(socket, request);
    };
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    const starting = fixture.start();
    await vi.waitFor(() => expect(delayed).toBeDefined());
    const stopping = fixture.stop();
    if (!delayed) throw new Error("Missing tab creation request");
    acknowledge(delayed.socket, delayed.request);
    await Promise.all([starting, stopping]);
    expect(paneRequests("pane.send_input")).toHaveLength(0);
    expect(paneRequests("pane.close")[0].params.pane_id).toBe("w1:p2");
  });
});

describe("Herdr status adapter", () => {
  it("keeps one discoverable entrypoint", async () => {
    const files = await readdir(resolve(import.meta.dirname, "../../extensions/herdr"));
    expect(files.filter((file) => file.endsWith(".ts"))).toEqual(["herdr.ts"]);
  });

  it("registers listeners before session start without opening sockets or timers", async () => {
    const fixture = await setup();
    expect([...fixture.listeners.keys()].sort()).toEqual([
      "goal:state-change",
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
        pi_todos: null,
        pi_goal: null,
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
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
    ]);
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
      fixture.ctx.sessionManager.getBranch.mockReturnValue([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
      ]);
      await fireCostEvent(fixture, event);
      await flushUpdates();
      expect(latestRequest().params.tokens.pi_cost).toBe("$0.026");
      fixture.ctx.sessionManager.getBranch.mockReturnValue([
        { type: "message", message: { role: "assistant", usage: { cost: { total: 0.041 } } } },
      ]);
      await fireCostEvent(fixture, event);
      await flushUpdates();
      expect(latestRequest().params.tokens.pi_cost).toBe("$0.041");
    },
  );

  it("counts nested usage only through its top-level tool result", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: { cost: { total: 0.01 } },
          details: { nested: { usage: { cost: { total: 10 } } } },
        },
      },
    ]);
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
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.00026 } } } },
    ]);
    fixture.emit("workers:state", { running: 1, workerCostUsd: 0.00026 });
    await fixture.start();
    expect(latestRequest().params.tokens.pi_worker_cost).toBe("$0.0003");
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.001");
  });

  it("updates combined cost even when the formatted worker cost does not change", async () => {
    const fixture = await setup();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.000051 } } } },
    ]);
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
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.026 } } } },
    ]);
    fixture.emit("workers:state", { running: 0, workerCostUsd: 0.005 });
    await fixture.start();
    await fixture.stop();
    expect(latestRequest().params.tokens.pi_cost).toBeNull();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([]);
    await fixture.start();
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.000");
  });

  it("reads fresh session costs during periodic metadata refresh", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.ctx.sessionManager.getBranch.mockReturnValue([
      { type: "usage", usage: { cost: { total: 0.004 } } },
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestRequest().params.tokens.pi_cost).toBe("$0.004");
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

  it("coalesces all five extension events into one metadata snapshot", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Fix auth", status: "active" });
    fixture.emit("workers:state", { running: 2, workerCostUsd: 0.125, workerTokens: 1200 });
    fixture.emit("todos:changed", { items: [{ completed: true }, { completed: false }] });
    fixture.emit("goal:state-change", { status: "active", iteration: 3, maxIterations: 25 });
    fixture.emit("messenger:state", { name: "auth-parent", unread: 4 });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    expect(latestRequest().params.tokens).toEqual({
      pi_session_name: null,
      pi_mission: "Fix auth",
      pi_mission_status: "active",
      pi_workers: "2",
      pi_worker_cost: "$0.1250",
      pi_worker_tokens: "1200",
      pi_cost: "$0.125",
      pi_todos: "1/2",
      pi_goal: "active 3/25",
      pi_messenger: "auth-parent",
      pi_unread: "4",
    });
  });

  it("clears removed state and does not repeat unchanged event updates", async () => {
    const fixture = await setup();
    await fixture.start();
    fixture.emit("missions:state", { active: true, title: "Auth", status: "paused" });
    fixture.emit("goal:state-change", { status: "paused", iteration: 3 });
    fixture.emit("messenger:state", { name: "auth", unread: 0 });
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_goal).toBe("paused 3");
    fixture.emit("missions:state", { active: true, title: "Auth", status: "paused" });
    await flushUpdates();
    expect(requests).toHaveLength(2);
    fixture.emit("missions:state", { active: false, title: null, status: null });
    fixture.emit("goal:state-change", { status: null });
    fixture.emit("messenger:state", { name: null, unread: 0 });
    await flushUpdates();
    expect(latestRequest().params.tokens).toMatchObject({
      pi_mission: null,
      pi_mission_status: null,
      pi_goal: null,
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
    fixture.emit("goal:state-change", { status: "active", iteration: Number.POSITIVE_INFINITY });
    fixture.emit("messenger:state", null);
    await flushUpdates();
    expect(latestRequest().params.tokens.pi_mission).toBe(`Auth ${"x".repeat(75)}`);
    expect(latestRequest().params.tokens).toMatchObject({
      pi_workers: "1",
      pi_worker_cost: null,
      pi_worker_tokens: null,
      pi_todos: null,
      pi_goal: "active",
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
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(5);
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
    expect(fixture.listeners.size).toBe(5);
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
    expect(latestRequest().params.tokens.pi_workers).toBe("3");
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

  it("keeps worker monitor labels and metadata behavior unchanged while renaming", async () => {
    const fixture = await setup();
    fixture.pi.getSessionName.mockReturnValue("Named session");
    fixture.ctx.sessionManager.getBranch.mockReturnValue([workerEntry("w-owned-1")]);
    await fixture.start();
    await flushUpdates();
    await vi.waitFor(() => expect(paneRequests("pane.rename")).toHaveLength(2));
    expect(
      paneRequests("pane.rename")
        .map((request) => `${request.params.pane_id}=${request.params.label}`)
        .sort(),
    ).toEqual(["w1:p1=Named session", "w1:p2=Worker w-owned-1"]);
    expect(paneRequests("tab.create")[0].params.label).toBe("Workers");
    expect(paneRequests("pane.report_metadata").length).toBeGreaterThan(0);
    await fixture.stop();
    expect(paneRequests("pane.close").map((request) => request.params.pane_id)).toEqual(["w1:p2"]);
  });
});
