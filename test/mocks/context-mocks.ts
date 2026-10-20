import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ModelRegistry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { asSdkMock, type DeepMocked } from "./mock-types.ts";

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
    theme: asSdkMock<Theme>({
      appearance: "dark" as const,
      colors: {} as Theme["colors"],
      style: vi.fn((text: string) => text),
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
    }),
    getAllThemes: vi.fn(() => []),
    getTheme: vi.fn(),
    setTheme: vi.fn(),
    getToolsExpanded: vi.fn(),
    setToolsExpanded: vi.fn(),
  };
}

/** A complete chat model. Pass overrides for the fields a test cares about. */
export function createMockModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "test-provider",
    api: "openai-completions",
    baseUrl: "https://test.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

export function createMockContext(): DeepMocked<ExtensionContext> {
  const model = createMockModel();
  return {
    ui: createMockUI(),
    hasUI: true,
    mode: "tui" as const,
    cwd: "/home/test",
    sessionManager: {
      getCwd: vi.fn(() => "/home/test"),
      getSessionDir: vi.fn(() => "/home/test/.pi/sessions"),
      getSessionId: vi.fn(() => "test-session"),
      getSessionFile: vi.fn(() => undefined),
      getSessionName: vi.fn(() => undefined),
      getLeafId: vi.fn(() => undefined),
      getLeafEntry: vi.fn(() => undefined),
      getEntry: vi.fn(() => undefined),
      getLabel: vi.fn(() => undefined),
      getBranch: vi.fn(() => []),
      buildContextEntries: vi.fn(() => []),
      buildSessionProjection: vi.fn(),
      getHeader: vi.fn(() => null),
      getEntries: vi.fn(() => []),
      getTree: vi.fn(() => []),
    },
    modelRegistry: asSdkMock<ModelRegistry>({
      refresh: vi.fn(),
      getError: vi.fn(() => undefined),
      hasConfiguredAuth: vi.fn(() => true),
      getProviderAuthStatus: vi.fn(),
      getProvider: vi.fn(() => undefined),
      stream: vi.fn(),
      complete: vi.fn(),
      generateImages: vi.fn(),
      getProviderDisplayName: vi.fn((provider: string) => provider),
      getProviderAuth: vi.fn(),
      isUsingOAuth: vi.fn(() => false),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      registerVirtualModel: vi.fn(),
      unregisterVirtualModel: vi.fn(),
      getRegisteredProviderConfig: vi.fn(() => undefined),
      getRegisteredNativeProvider: vi.fn(() => undefined),
      getRegisteredProviderIds: vi.fn(() => []),
      streamSimple: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => []),
      findOfType: vi.fn(() => undefined),
      getModelsOfType: vi.fn(() => []),
      getAvailableOfType: vi.fn(() => Promise.resolve([])),
      getModelOfType: vi.fn(() => undefined),
      classify: vi.fn(() =>
        Promise.resolve({ answers: {}, stopReason: "error", timestamp: Date.now() }),
      ),
      getApiKeyAndHeaders: vi.fn(() =>
        Promise.resolve({ ok: true, apiKey: "test-key", headers: {} }),
      ),
      getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)),
      find: vi.fn((providerName: string, modelId: string) =>
        providerName === model.provider && modelId === model.id ? model : undefined,
      ),
    }),
    model,
    scopedModels: [],
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => false),
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
