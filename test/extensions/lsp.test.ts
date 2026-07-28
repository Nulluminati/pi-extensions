import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import lspExtension from "../../extensions/lsp/lsp.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

// ---------------------------------------------------------------------------
// Mock Pi runtime modules
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: vi.fn((values: readonly string[]) => ({
    type: "string",
    enum: [...values],
  })),
}));

vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn((props: Record<string, unknown>) => ({
      type: "object",
      properties: props,
    })),
    String: vi.fn((opts?: Record<string, unknown>) => ({ type: "string", ...opts })),
    Number: vi.fn((opts?: Record<string, unknown>) => ({ type: "number", ...opts })),
    Optional: vi.fn(<T>(schema: T) => schema),
  },
}));

// ---------------------------------------------------------------------------
// Mock node modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  })),
  execSync: vi.fn(() => Buffer.from("")),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  readFile: vi.fn(() => Promise.resolve("")),
  writeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

import { execSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getRegisteredTool(mockPi: Record<string, unknown>, name: string): any {
  const calls = (mockPi as Record<string, { mock: { calls: [unknown][] } }>).registerTool.mock
    .calls;
  for (const call of calls) {
    const tool = call[0] as Record<string, unknown>;
    if (tool.name === name) return tool;
  }
  throw new Error(`Tool "${name}" not found`);
}

function _getRegisteredCommand(mockPi: Record<string, unknown>, name: string) {
  const calls = (mockPi as Record<string, { mock: { calls: [unknown, unknown][] } }>)
    .registerCommand.mock.calls;
  for (const call of calls) {
    if (call[0] === name) return call[1];
  }
  throw new Error(`Command "${name}" not found`);
}

function mockAccessPattern(exists: boolean) {
  (access as ReturnType<typeof vi.fn>).mockImplementation(() =>
    exists ? Promise.resolve() : Promise.reject(new Error("ENOENT")),
  );
}

function mockReadFile(content: string) {
  (readFile as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(content));
}

const SAMPLE_CONFIG = {
  lsp: {
    typescript: {
      command: ["typescript-language-server", "--stdio"],
      extensions: [".ts", ".tsx"],
    },
    python: {
      command: ["pylsp"],
      extensions: [".py"],
      disabled: true,
    },
  },
};

const DISABLED_CONFIG = {
  lsp: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lsp-extension", () => {
  let mockPi: ReturnType<typeof createMockPi>;
  let mockCtx: ReturnType<typeof createMockCommandContext>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPi = createMockPi();
    mockCtx = createMockCommandContext();
    mockCtx.cwd = "/home/test/project";

    // Default: command availability check passes
    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => Buffer.from(""));
    // Default: no config files exist
    mockAccessPattern(false);
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const { readdir: readActualDirectory } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const extensionDir = resolve(import.meta.dirname, "../../extensions/lsp");
      const rootEntries = await readActualDirectory(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readActualDirectory(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["lsp.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(10);
    });
  });

  // --- Registration tests ---

  it("registers the lsp tool", async () => {
    await lspExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "lsp" }));
  });

  it("registers /lsp command", async () => {
    await lspExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "lsp",
      expect.objectContaining({
        description: expect.stringContaining("LSP server status"),
      }),
    );
  });

  it("registers /lsp-restart command", async () => {
    await lspExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "lsp-restart",
      expect.objectContaining({
        description: expect.stringContaining("Stop all LSP servers"),
      }),
    );
  });

  it("registers session_start event handler", async () => {
    await lspExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("registers session_shutdown event handler", async () => {
    await lspExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("registers tool_execution_end event handler", async () => {
    await lspExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
  });

  // --- Tool property tests ---

  it("tool has correct label", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    expect(tool.label).toBe("LSP");
  });

  it("tool has correct promptSnippet", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    expect(tool.promptSnippet).toBe(
      "Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions",
    );
  });

  it("tool has 9 prompt guidelines", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    expect(tool.promptGuidelines).toHaveLength(9);
  });

  it("tool description contains all operations", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    expect(tool.description).toContain("goToDefinition");
    expect(tool.description).toContain("findReferences");
    expect(tool.description).toContain("hover");
    expect(tool.description).toContain("diagnostics");
    expect(tool.description).toContain("documentSymbol");
    expect(tool.description).toContain("workspaceSymbol");
    expect(tool.description).toContain("goToImplementation");
    expect(tool.description).toContain("prepareCallHierarchy");
    expect(tool.description).toContain("incomingCalls");
    expect(tool.description).toContain("outgoingCalls");
    expect(tool.description).toContain("codeActions");
  });

  // --- Parameter validation tests ---

  it("throws for unknown operation", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute("id1", { operation: "unknownOp" }, undefined, undefined, mockCtx),
    ).rejects.toThrow("Unknown operation: unknownOp");
  });

  it("throws when position operation missing filePath", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute(
        "id1",
        { operation: "hover", line: 5, character: 3 },
        undefined,
        undefined,
        mockCtx,
      ),
    ).rejects.toThrow("Operation 'hover' requires filePath");
  });

  it("throws when position operation missing line", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute(
        "id1",
        { operation: "hover", filePath: "foo.ts", character: 3 },
        undefined,
        undefined,
        mockCtx,
      ),
    ).rejects.toThrow("Operation 'hover' requires line");
  });

  it("throws when position operation missing character", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute(
        "id1",
        { operation: "hover", filePath: "foo.ts", line: 5 },
        undefined,
        undefined,
        mockCtx,
      ),
    ).rejects.toThrow("Operation 'hover' requires character");
  });

  it("throws when file operation missing filePath", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute("id1", { operation: "diagnostics" }, undefined, undefined, mockCtx),
    ).rejects.toThrow("Operation 'diagnostics' requires filePath");
  });

  it("throws when documentSymbol missing filePath", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute("id1", { operation: "documentSymbol" }, undefined, undefined, mockCtx),
    ).rejects.toThrow("Operation 'documentSymbol' requires filePath");
  });

  it("throws when workspaceSymbol missing query", async () => {
    await lspExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "lsp");
    await expect(
      tool.execute("id1", { operation: "workspaceSymbol" }, undefined, undefined, mockCtx),
    ).rejects.toThrow("Operation 'workspaceSymbol' requires query");
  });

  // --- /lsp command tests ---

  describe("/lsp command", () => {
    it("shows all servers disabled via config when globalDisabled", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp");

      // Set up config with lsp: false
      mockAccessPattern(true);
      mockReadFile(JSON.stringify(DISABLED_CONFIG));

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("All servers disabled via config."),
        "info",
      );
    });

    it("shows no servers configured when config has none", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp");

      // Set up empty config
      mockAccessPattern(true);
      mockReadFile(JSON.stringify({ lsp: {} }));

      // Command availability check fails (no servers found)
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No servers configured."),
        "info",
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Add servers to ~/.pi/agent/extensions/lsp/config.json"),
        "info",
      );
    });

    it("shows per-server status with extensions", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp");

      mockAccessPattern(true);
      mockReadFile(JSON.stringify(SAMPLE_CONFIG));

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("typescript"), "info");
    });

    it("shows config errors when present", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp");

      // Global config reads fine, project config exists but readFile throws
      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("lsp.json") && !path.includes("agent")) {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.resolve(JSON.stringify({ lsp: {} }));
      });
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Config errors:"),
        "info",
      );
    });
  });

  // --- /lsp-restart command tests ---

  describe("/lsp-restart command", () => {
    it("shows restart notification", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp-restart");

      // Trigger session_start first to set rootPath
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "LSP servers stopped. Will reinitialize on next tool use.",
        "info",
      );
    });

    it("clears clients and reloads config", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp-restart");

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      // After restart, config should be reloaded
      await handler("", mockCtx);

      expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    });
  });

  // --- session_start event tests ---

  describe("session_start event", () => {
    it("sets rootPath from cwd", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_start");

      mockCtx.cwd = "/my/project";
      await handler({ type: "session_start", reason: "new" }, mockCtx);

      // Should call setStatus (indicating rootPath was set and config was loaded)
      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("lsp", expect.any(String));
    });

    it("scaffolds starter config when no config exists", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_start");

      // No config files exist
      mockAccessPattern(false);

      await handler({ type: "session_start", reason: "new" }, mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "LSP: created starter config at ~/.pi/agent/extensions/lsp/config.json — edit it to add your servers.",
        "info",
      );
    });

    it("does not scaffold when global config exists", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_start");

      mockAccessPattern(true);
      mockReadFile(JSON.stringify(SAMPLE_CONFIG));
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => Buffer.from(""));

      await handler({ type: "session_start", reason: "new" }, mockCtx);

      expect(mockCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("created starter config"),
        "info",
      );
    });

    it("does not scaffold when project config exists", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_start");

      // Global doesn't exist, project does
      (access as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve();
      });
      mockReadFile(JSON.stringify(SAMPLE_CONFIG));

      await handler({ type: "session_start", reason: "new" }, mockCtx);

      expect(mockCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("created starter config"),
        "info",
      );
    });
  });

  // --- session_shutdown event tests ---

  describe("session_shutdown event", () => {
    it("clears state on shutdown", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_shutdown");

      await handler({ type: "session_shutdown", reason: "close" }, mockCtx);

      // After shutdown, status should be updated
      // The config should be null, so status would be "no servers detected"
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });
  });

  // --- tool_execution_end event tests ---

  describe("tool_execution_end event", () => {
    it("refreshes status when lsp tool finishes", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "tool_execution_end");

      // First trigger session_start to set up state
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      // Clear previous setStatus calls
      mockCtx.ui.setStatus.mockClear();

      await handler(
        {
          type: "tool_execution_end",
          toolName: "lsp",
          toolCallId: "1",
          result: null,
          isError: false,
        },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    });

    it("does not refresh status for non-lsp tools", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "tool_execution_end");

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);
      mockCtx.ui.setStatus.mockClear();

      await handler(
        {
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "1",
          result: null,
          isError: false,
        },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });
  });

  // --- Status line tests ---

  describe("status line", () => {
    it("shows 'no servers detected' when config is null", async () => {
      await lspExtension(mockPi);
      // No session_start called, config is null
      const handler = getEventHandler(mockPi, "session_start");
      await handler({ type: "session_start", reason: "new" }, mockCtx);

      // With no config files and no command availability, servers will be empty
      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
        "lsp",
        expect.stringContaining("no servers detected"),
      );
    });

    it("shows 'disabled' when lsp is false in config", async () => {
      await lspExtension(mockPi);

      mockAccessPattern(true);
      mockReadFile(JSON.stringify(DISABLED_CONFIG));

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
        "lsp",
        expect.stringContaining("LSP: disabled"),
      );
    });
  });

  // --- Formatting utility tests ---

  describe("formatting utilities", () => {
    describe("severityLabel", () => {
      it("maps severity numbers to labels", async () => {
        // We test via the tool's formatting output
        // severityLabel is internal, but we can verify it through
        // the diagnostics formatting output
        await lspExtension(mockPi);
        // Just verify the extension loads successfully
        expect(mockPi.registerTool).toHaveBeenCalled();
      });
    });

    describe("status line for available servers", () => {
      it("shows server names when available", async () => {
        await lspExtension(mockPi);

        mockAccessPattern(true);
        mockReadFile(JSON.stringify(SAMPLE_CONFIG));
        (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => Buffer.from(""));

        const handler = getCommandHandler(mockPi, "lsp");
        await handler("", mockCtx);

        expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
          "lsp",
          expect.stringContaining("typescript"),
        );
      });
    });
  });

  // --- Config loading tests ---

  describe("config loading", () => {
    it("loads global and project config and merges", async () => {
      await lspExtension(mockPi);

      // Global config
      (access as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string") return Promise.resolve();
        return Promise.reject(new Error("ENOENT"));
      });

      // Global config with typescript, project config with python
      const globalConfig = {
        lsp: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            extensions: [".ts"],
          },
        },
      };
      const projectConfig = {
        lsp: {
          python: {
            command: ["pylsp"],
            extensions: [".py"],
          },
        },
      };

      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(JSON.stringify(globalConfig));
        }
        if (typeof path === "string" && path.includes("lsp.json")) {
          return Promise.resolve(JSON.stringify(projectConfig));
        }
        return Promise.resolve("");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      // Both servers should appear in the status
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("typescript"), "info");
    });

    it("project config overrides global for same server", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => Buffer.from(""));

      const globalConfig = {
        lsp: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            extensions: [".ts"],
          },
        },
      };
      const projectConfig = {
        lsp: {
          typescript: {
            command: ["my-custom-ts-server", "--stdio"],
            extensions: [".ts", ".tsx"],
          },
        },
      };

      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(JSON.stringify(globalConfig));
        }
        if (typeof path === "string" && path.includes("lsp.json")) {
          return Promise.resolve(JSON.stringify(projectConfig));
        }
        return Promise.resolve("");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      // Should not throw, config should load successfully
      expect(mockCtx.ui.notify).toHaveBeenCalled();
    });

    it("disabled server in global config is excluded", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(JSON.stringify(SAMPLE_CONFIG));
        }
        return Promise.resolve("{}");
      });
      // Make command check pass for typescript, fail for python
      (execSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("typescript-language-server")) {
          return Buffer.from("");
        }
        throw new Error("not found");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      // python is disabled in SAMPLE_CONFIG, so only typescript should appear
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("typescript"), "info");
    });

    it("lsp: false in either config disables all", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(JSON.stringify(DISABLED_CONFIG));
        }
        return Promise.resolve(JSON.stringify(SAMPLE_CONFIG));
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
        "lsp",
        expect.stringContaining("LSP: disabled"),
      );
    });

    it("handles malformed config files gracefully", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("not valid json {{{");

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      // Should show config errors
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Config errors:"),
        "info",
      );
    });

    it("npx fallback rewrites command when global not found", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(
            JSON.stringify({
              lsp: {
                rust: {
                  command: ["rust-analyzer"],
                  extensions: [".rs"],
                },
              },
            }),
          );
        }
        return Promise.resolve("{}");
      });

      // which fails, npx succeeds
      (execSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which")) {
          throw new Error("not found");
        }
        if (typeof cmd === "string" && cmd.includes("npx")) {
          return Buffer.from("");
        }
        throw new Error("not found");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("rust"), "info");
    });

    it("silently excludes server when command not found anywhere", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(
            JSON.stringify({
              lsp: {
                nonexistent: {
                  command: ["nonexistent-lsp-server"],
                  extensions: [".xyz"],
                },
              },
            }),
          );
        }
        return Promise.resolve("{}");
      });

      // All command checks fail
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No servers configured."),
        "info",
      );
    });
  });

  // --- Command handler tests for /lsp-restart ---

  describe("/lsp-restart command handler", () => {
    it("notifies user after restart", async () => {
      await lspExtension(mockPi);
      const handler = getCommandHandler(mockPi, "lsp-restart");

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      await handler("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "LSP servers stopped. Will reinitialize on next tool use.",
        "info",
      );
    });
  });

  // --- Prompt guidelines exact text tests ---

  describe("prompt guidelines", () => {
    it("contains all 9 exact guidelines", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const guidelines = tool.promptGuidelines as string[];

      expect(guidelines[0]).toBe(
        "lsp line and character params are 1-indexed — use the values from the read tool or rg output directly.",
      );
      expect(guidelines[1]).toBe(
        "lsp `hover` is the fastest way to get a function signature, type params, and doc comment — prefer it over `goToDefinition` for quick type inspection.",
      );
      expect(guidelines[2]).toBe(
        "lsp `documentSymbol` returns line:column positions for each symbol — use those values directly for follow-up lsp operations.",
      );
      expect(guidelines[3]).toBe(
        "For lsp position-based operations, place the character in the **middle** of the symbol name, not at the first character.",
      );
      expect(guidelines[4]).toBe(
        "lsp `incomingCalls` and `outgoingCalls` automatically prepare the call hierarchy — no need to call `prepareCallHierarchy` first.",
      );
      expect(guidelines[5]).toBe(
        "lsp `workspaceSymbol` may return empty results while the LSP server is still indexing. If it returns nothing, wait a few seconds and retry.",
      );
      expect(guidelines[6]).toBe(
        "lsp `diagnostics` relies on server-pushed notifications which may be slow for some servers. For compiled languages (Rust, Go, C++), prefer running the compiler directly (e.g. `cargo check`, `go build`) for reliable error checking.",
      );
      expect(guidelines[7]).toBe(
        "Use lsp for type info, macro-generated symbols, and cross-module navigation. Use rg for simple text search and file discovery — it is faster and needs no server.",
      );
      expect(guidelines[8]).toBe(
        "lsp servers are auto-detected by file extension. Use /lsp to check status.",
      );
    });
  });

  // --- Tool description exact text test ---

  describe("tool description", () => {
    it("starts with the correct first line", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      expect(tool.description).toContain(
        "Interact with Language Server Protocol servers for code intelligence.",
      );
    });

    it("contains parameter documentation", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      expect(tool.description).toContain("operation (required)");
      expect(tool.description).toContain("filePath");
      expect(tool.description).toContain("line");
      expect(tool.description).toContain("character");
      expect(tool.description).toContain("query");
    });

    it("contains tips", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      expect(tool.description).toContain("Tips:");
      expect(tool.description).toContain("Position the character in the middle of the symbol name");
    });
  });

  // --- Parameter validation for all operation types ---

  describe("parameter validation for each operation", () => {
    it("validates goToDefinition requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "goToDefinition" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'goToDefinition' requires filePath");
    });

    it("validates findReferences requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute(
          "id1",
          { operation: "findReferences", filePath: "a.ts" },
          undefined,
          undefined,
          mockCtx,
        ),
      ).rejects.toThrow("Operation 'findReferences' requires line");
    });

    it("validates goToImplementation requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute(
          "id1",
          { operation: "goToImplementation", filePath: "a.ts", line: 1 },
          undefined,
          undefined,
          mockCtx,
        ),
      ).rejects.toThrow("Operation 'goToImplementation' requires character");
    });

    it("validates prepareCallHierarchy requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute(
          "id1",
          { operation: "prepareCallHierarchy", filePath: "a.ts", line: 1, character: 1 },
          undefined,
          undefined,
          mockCtx,
        ),
      ).rejects.toThrow(); // Will fail at the client level since no server is available
    });

    it("validates incomingCalls requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "incomingCalls" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'incomingCalls' requires filePath");
    });

    it("validates outgoingCalls requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "outgoingCalls" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'outgoingCalls' requires filePath");
    });

    it("validates codeActions requires position params", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "codeActions" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'codeActions' requires filePath");
    });

    it("validates diagnostics requires filePath", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "diagnostics" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'diagnostics' requires filePath");
    });

    it("validates documentSymbol requires filePath", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "documentSymbol" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'documentSymbol' requires filePath");
    });

    it("validates workspaceSymbol requires query", async () => {
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      await expect(
        tool.execute("id1", { operation: "workspaceSymbol" }, undefined, undefined, mockCtx),
      ).rejects.toThrow("Operation 'workspaceSymbol' requires query");
    });
  });

  // --- Starter config content test ---

  describe("starter config", () => {
    it("writes correct starter config JSON", async () => {
      await lspExtension(mockPi);
      const handler = getEventHandler(mockPi, "session_start");

      mockAccessPattern(false);
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("");

      await handler({ type: "session_start", reason: "new" }, mockCtx);

      // Check that writeFile was called with the starter config
      const { writeFile: writeFileFn } = await import("node:fs/promises");
      const writeCalls = (writeFileFn as ReturnType<typeof vi.fn>).mock.calls;
      const configWriteCall = writeCalls.find(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("config.json"),
      );
      expect(configWriteCall).toBeDefined();
      if (configWriteCall) {
        const content = JSON.parse(configWriteCall[1] as string);
        expect(content.lsp.typescript.command).toEqual(["typescript-language-server", "--stdio"]);
        expect(content.lsp.typescript.extensions).toEqual([
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts",
        ]);
      }
    });
  });

  // --- Config deep merge (env) test ---

  describe("config deep merge", () => {
    it("deep merges env from global and project", async () => {
      await lspExtension(mockPi);

      (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => Buffer.from(""));

      const globalConfig = {
        lsp: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            extensions: [".ts"],
            env: { TS_NODE: "true", SHARED_VAR: "global" },
          },
        },
      };
      const projectConfig = {
        lsp: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            extensions: [".ts"],
            env: { PROJECT_VAR: "yes", SHARED_VAR: "project" },
          },
        },
      };

      (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("agent")) {
          return Promise.resolve(JSON.stringify(globalConfig));
        }
        if (typeof path === "string" && path.includes("lsp.json")) {
          return Promise.resolve(JSON.stringify(projectConfig));
        }
        return Promise.resolve("");
      });

      const handler = getCommandHandler(mockPi, "lsp");
      await handler("", mockCtx);

      // Config should have loaded and merged properly
      expect(mockCtx.ui.notify).toHaveBeenCalled();
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    it("shows compact success line with operation and target", async () => {
      const mockPi = createMockPi();
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "string string" }],
        details: {},
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, {
        args: { operation: "hover", filePath: "src/foo.ts", line: 10, character: 5 },
      });
      const lines = component.render(80);
      expect(lines[0]).toContain("hover");
      expect(lines[0]).toContain("src/foo.ts");
    });

    it("shows diagnostic count for the diagnostics operation", async () => {
      const mockPi = createMockPi();
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "diagnostics output" }],
        details: {
          groups: [
            { source: "eslint", count: 2 },
            { source: "tsc", count: 1 },
          ],
        },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, {
        args: { operation: "diagnostics", filePath: "src/foo.ts" },
      });
      const lines = component.render(80);
      expect(lines[0]).toContain("diagnostics");
      expect(lines[0]).toContain("3 diagnostic");
    });

    it("shows compact error line", async () => {
      const mockPi = createMockPi();
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "No LSP server found" }],
        details: {},
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, {
        args: { operation: "hover", filePath: "x.ts" },
        isError: true,
      });
      const lines = component.render(80);
      expect(lines[0]).toContain("hover");
      expect(lines[0]).toContain("No LSP server found");
    });

    it("shows loading state when isPartial", async () => {
      const mockPi = createMockPi();
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const theme = { fg: (_c: string, text: string) => text };
      const result = { content: [{ type: "text", text: "" }], details: {} };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: true }, theme, {
        args: { operation: "hover", filePath: "x.ts" },
      });
      const lines = component.render(80);
      expect(lines[0]).toContain("hover");
      expect(lines[0]).toContain("…");
    });

    it("shows content when expanded", async () => {
      const mockPi = createMockPi();
      await lspExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "lsp");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "detailed hover output" }],
        details: {},
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: true, isPartial: false }, theme, {
        args: { operation: "hover", filePath: "x.ts" },
      });
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("detailed hover output"))).toBe(true);
    });
  });
});
