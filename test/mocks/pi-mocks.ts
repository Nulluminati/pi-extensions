import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { DeepMocked } from "./mock-types.ts";

export function createMockPi(): DeepMocked<ExtensionAPI> {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerToolRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(() => undefined),
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerVirtualModel: vi.fn(),
    unregisterVirtualModel: vi.fn(),
    registerMcpServer: vi.fn(),
    unregisterMcpServer: vi.fn(),
    getMcpServers: vi.fn(() => []),
    getSettings: vi.fn(),
    setLabel: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  };
}
