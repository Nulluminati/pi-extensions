import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import workerBlockerExtension from "../../extensions/worker-blocker/worker-blocker.ts";
import {
  BLOCKER_MARKER_TYPE,
  BLOCKER_REASON_MAX_CHARS,
  sanitizeBlockerReason,
  WORKER_STREAM_ENV_VAR,
} from "../../lib/worker-blocker.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// --- Suite ---

describe("worker-blocker-extension", () => {
  let root: string;
  let spoolPath: string;
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const getTool = () => {
    const call = mockPi.registerTool.mock.calls.find((c) => c[0].name === "report_blocker");
    if (!call) throw new Error("report_blocker not registered");
    return call[0];
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-blocker-"));
    spoolPath = join(root, "streams", "w-1.jsonl");
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    setEnv("PI_WORKER", "1");
    setEnv(WORKER_STREAM_ENV_VAR, spoolPath);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("registers report_blocker in a worker session with the spool env", async () => {
    await workerBlockerExtension(mockPi);

    const tool = getTool();
    expect(tool.parameters.required).toEqual(["reason"]);
  });

  it("registers nothing outside a worker session", async () => {
    setEnv("PI_WORKER", undefined);

    await workerBlockerExtension(mockPi);

    expect(mockPi.registerTool).not.toHaveBeenCalled();
  });

  it("registers nothing when the spool path env is missing", async () => {
    setEnv(WORKER_STREAM_ENV_VAR, undefined);

    await workerBlockerExtension(mockPi);

    expect(mockPi.registerTool).not.toHaveBeenCalled();
  });

  it("appends a sanitized single-line agents_blocker marker to the spool", async () => {
    await workerBlockerExtension(mockPi);

    const result = await getTool().execute(
      "call-1",
      { reason: "no node_modules\nand no parent checkout\tin this VM\u0007" },
      undefined,
      undefined,
      mockCtx,
    );

    const lines = (await readFile(spoolPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const marker = JSON.parse(lines[0]) as { type: string; at: number; reason: string };
    expect(marker.type).toBe(BLOCKER_MARKER_TYPE);
    expect(typeof marker.at).toBe("number");
    expect(marker.reason).toBe("no node_modules and no parent checkout in this VM");
    expect(result.details).toMatchObject({ reported: true, truncated: false });
    // The reason stays out of the tool result: the parent pulls it.
    expect(result.content[0].text).not.toContain("node_modules");
  });

  it("truncates oversized reasons to the cap and says so", async () => {
    await workerBlockerExtension(mockPi);

    const result = await getTool().execute(
      "call-1",
      { reason: "x".repeat(BLOCKER_REASON_MAX_CHARS + 50) },
      undefined,
      undefined,
      mockCtx,
    );

    const marker = JSON.parse((await readFile(spoolPath, "utf8")).trim()) as { reason: string };
    expect(marker.reason).toHaveLength(BLOCKER_REASON_MAX_CHARS);
    expect(result.details).toMatchObject({ reported: true, truncated: true });
  });

  it("refuses to report an empty reason and writes no marker", async () => {
    await workerBlockerExtension(mockPi);

    const result = await getTool().execute(
      "call-1",
      { reason: "  \n\t " },
      undefined,
      undefined,
      mockCtx,
    );

    expect(result.content[0].text).toMatch(/no blocker reported/i);
    await expect(readFile(spoolPath, "utf8")).rejects.toThrow();
  });

  it("throws a descriptive error when the spool is unwritable", async () => {
    // A directory at the spool path: mkdir succeeds, appendFile fails (EISDIR).
    const blockedPath = join(root, "blocked.jsonl");
    await mkdir(blockedPath, { recursive: true });
    setEnv(WORKER_STREAM_ENV_VAR, blockedPath);
    await workerBlockerExtension(mockPi);

    await expect(
      getTool().execute("call-1", { reason: "stuck" }, undefined, undefined, mockCtx),
    ).rejects.toThrow(/report_blocker could not reach the parent channel/);
  });
});

describe("sanitizeBlockerReason", () => {
  it("strips control characters and collapses whitespace to one line", () => {
    const { reason } = sanitizeBlockerReason("  a\r\nb\u0000c\u001fd\u007fe\u009f f\u2028g\t h ");

    expect(reason).toBe("a b c d e f g h");
  });

  it("caps the reason at the maximum length and flags truncation", () => {
    const ok = sanitizeBlockerReason("x".repeat(BLOCKER_REASON_MAX_CHARS));
    expect(ok).toEqual({ reason: "x".repeat(BLOCKER_REASON_MAX_CHARS), truncated: false });

    const long = sanitizeBlockerReason("x".repeat(BLOCKER_REASON_MAX_CHARS + 1));
    expect(long.reason).toHaveLength(BLOCKER_REASON_MAX_CHARS);
    expect(long.truncated).toBe(true);
  });

  it("returns an empty reason for non-string input", () => {
    expect(sanitizeBlockerReason(undefined)).toEqual({ reason: "", truncated: false });
    expect(sanitizeBlockerReason(42)).toEqual({ reason: "", truncated: false });
  });
});
