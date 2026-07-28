import type { ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "pi";
import { vi } from "vitest";
import type { DeepMocked } from "./mock-types.ts";

export function createMockUI(): DeepMocked<ExtensionUIContext> {
  // Track the editor component so getEditorComponent mirrors real Pi (returns
  // the last factory set via setEditorComponent) instead of always undefined.
  let editorComponent: unknown;
  return {
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    custom: vi.fn(),
    pasteToEditor: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(() => ""),
    editor: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    setEditorComponent: vi.fn((factory: unknown) => {
      editorComponent = factory;
    }),
    getEditorComponent: vi.fn(() => editorComponent),
    theme: {
      fg: vi.fn((_color: string, text: string) => text),
      bg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
      italic: vi.fn((text: string) => text),
      underline: vi.fn((text: string) => text),
      inverse: vi.fn((text: string) => text),
      strikethrough: vi.fn((text: string) => text),
      getFgAnsi: vi.fn((_color: string) => ""),
      getBgAnsi: vi.fn((_color: string) => ""),
      getColorMode: vi.fn(() => "truecolor" as const),
      getThinkingBorderColor: vi.fn(() => (str: string) => str),
      getBashModeBorderColor: vi.fn(() => (str: string) => str),
    },
    getAllThemes: vi.fn(() => []),
    getTheme: vi.fn(),
    setTheme: vi.fn(),
    getToolsExpanded: vi.fn(),
    setToolsExpanded: vi.fn(),
  };
}

export function createMockContext(): DeepMocked<ExtensionContext> {
  const model = {
    id: "test-model",
    name: "Test Model",
    provider: "test-provider",
    api: {},
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    contextWindow: 128_000,
    maxTokens: 4096,
  };
  return {
    ui: createMockUI(),
    hasUI: true,
    mode: "tui" as const,
    cwd: "/home/test",
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => undefined),
      getSessionFile: vi.fn(() => undefined),
    },
    modelRegistry: {
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => []),
      getApiKeyAndHeaders: vi.fn(() =>
        Promise.resolve({ ok: true, apiKey: "test-key", headers: {} }),
      ),
      getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)),
      find: vi.fn((providerName: string, modelId: string) =>
        providerName === model.provider && modelId === model.id ? model : undefined,
      ),
    },
    model,
    isIdle: vi.fn(() => true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
  };
}

export function createMockCommandContext(): DeepMocked<ExtensionCommandContext> {
  return {
    ...createMockContext(),
    getSystemPromptOptions: vi.fn(() => ({
      cwd: "/home/test",
      contextFiles: [],
      toolSnippets: {
        read: "Read file contents",
        bash: "Execute shell commands",
        edit: "Edit files using exact text replacements",
        write: "Create or overwrite files",
      },
    })),
    waitForIdle: vi.fn(),
    newSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    fork: vi.fn(),
    navigateTree: vi.fn(),
    switchSession: vi.fn(),
    reload: vi.fn(),
  };
}
