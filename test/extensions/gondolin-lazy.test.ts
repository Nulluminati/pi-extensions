import { describe, expect, it, vi } from "vitest";

// Records when the native gondolin module is actually imported. A fresh test
// file keeps an isolated module registry so the factory fires exactly once on
// first dynamic import.
const nativeLoaded = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/gondolin", () => {
  nativeLoaded();
  return {
    VM: {
      create: vi.fn(async () => ({
        id: "lazy-vm",
        exec: vi.fn(async () => ({ stdout: "bash", stderr: "", exitCode: 0, ok: true })),
        close: vi.fn(async () => {}),
      })),
    },
    RealFSProvider: vi.fn(),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createReadTool: vi.fn(() => ({ name: "read", execute: vi.fn() })),
  createWriteTool: vi.fn(() => ({ name: "write", execute: vi.fn() })),
  createEditTool: vi.fn(() => ({ name: "edit", execute: vi.fn() })),
  createBashTool: vi.fn(() => ({ name: "bash", execute: vi.fn() })),
  createGrepTool: vi.fn(() => ({ name: "grep", execute: vi.fn() })),
  createFindTool: vi.fn(() => ({ name: "find", execute: vi.fn() })),
  createLsTool: vi.fn(() => ({ name: "ls", execute: vi.fn() })),
  DEFAULT_MAX_BYTES: 100000,
  formatSize: vi.fn((bytes: number) => `${bytes}B`),
  truncateHead: vi.fn((text: string) => ({ content: text, truncated: false })),
  truncateLine: vi.fn((line: string) => ({ text: line, wasTruncated: false })),
}));

import gondolinExtension from "../../extensions/gondolin/gondolin.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

describe("gondolin lazy native loading", () => {
  it("does not load the native gondolin module during init", async () => {
    nativeLoaded.mockClear();
    const pi = createMockPi();
    await gondolinExtension(pi);
    expect(nativeLoaded).not.toHaveBeenCalled();
  });

  it("loads the native module only when the VM is started", async () => {
    nativeLoaded.mockClear();
    const pi = createMockPi();
    await gondolinExtension(pi);
    pi.getFlag = vi.fn((name: string) => name === "gondolin");

    const handler = getEventHandler(pi, "session_start");
    await handler({}, createMockCommandContext());

    expect(nativeLoaded).toHaveBeenCalled();
  });
});
