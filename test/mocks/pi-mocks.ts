import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Mock, vi } from "vitest";
import { type DeepMocked, mockFn } from "./mock-types.ts";

/**
 * `pi.on` and `pi.registerTool` as tests read them back from `.mock.calls`.
 *
 * `on` has one overload per event, and Vitest types recorded calls from the
 * last overload only, so a recorded call reads as (event name, handler for any
 * event). `registerTool` is generic, so a recorded tool reads as a definition
 * of any schema and details type. Calls from extension code still check
 * against the real overloads and generics.
 */
type RecordedOn = Mock<
  // biome-ignore lint/suspicious/noExplicitAny: a recorded handler serves any event
  (event: string, handler: (event: any, ctx: any) => unknown) => () => void
> &
  ExtensionAPI["on"];
type RecordedRegisterTool = Mock<
  // biome-ignore lint/suspicious/noExplicitAny: a recorded tool has any schema and details
  (tool: ToolDefinition<any, any, any>) => void
> &
  ExtensionAPI["registerTool"];

export type MockPi = Omit<DeepMocked<ExtensionAPI>, "on" | "registerTool"> & {
  on: RecordedOn;
  registerTool: RecordedRegisterTool;
};

export function createMockPi(): MockPi {
  return {
    on: mockFn(),
    registerTool: mockFn(),
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
    registerProvider: mockFn(),
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
