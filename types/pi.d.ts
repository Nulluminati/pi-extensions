// Ambient type declarations for Pi extensions.
// These mirror the Pi SDK API surface without requiring the full SDK as a dependency.

declare module "pi" {
  // --- Core API ---

  export interface ExtensionAPI {
    on<E extends keyof ExtensionEventMap>(
      event: E,
      handler: (event: ExtensionEventMap[E], ctx: ExtensionContext) => Promise<any> | any,
    ): void;
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ): void;
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
    registerShortcut(
      shortcut: string,
      options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
    ): void;
    registerFlag(
      name: string,
      options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
    ): void;
    getFlag(name: string): boolean | string | undefined;
    registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
    sendMessage<T = unknown>(
      message: {
        customType: string;
        content: (TextContent | ImageContent)[];
        display?: boolean;
        details?: unknown;
      },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void;
    sendUserMessage(
      content: string | (TextContent | ImageContent)[],
      options?: { deliverAs?: "steer" | "followUp" },
    ): void;
    appendEntry<T = unknown>(customType: string, data?: T): void;
    setSessionName(name: string): void;
    getSessionName(): string | undefined;
    exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
    getActiveTools(): string[];
    getAllTools(): ToolInfo[];
    setActiveTools(toolNames: string[]): void;
    getCommands(): SlashCommandInfo[];
    setModel(model: Model<any>): Promise<boolean>;
    getThinkingLevel(): ThinkingLevel;
    setThinkingLevel(level: ThinkingLevel): void;
    registerProvider(name: string, config: ProviderConfig): void;
    unregisterProvider(name: string): void;
    setLabel(entryId: string, label: string | undefined): void;
    events: EventBus;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    mode: "tui" | "rpc" | "json" | "print";
    cwd: string;
    sessionManager: ReadonlySessionManager;
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    isIdle(): boolean;
    signal: AbortSignal | undefined;
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
  }

  export interface BuildSystemPromptOptions {
    customPrompt?: string;
    selectedTools?: string[];
    toolSnippets?: Record<string, string>;
    promptGuidelines?: string[];
    appendSystemPrompt?: string;
    cwd: string;
    contextFiles?: Array<{ path: string; content: string }>;
    skills?: unknown[];
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    getSystemPromptOptions(): BuildSystemPromptOptions;
    waitForIdle(): Promise<void>;
    newSession(options?: {
      parentSession?: string;
      setup?: (sessionManager: any) => Promise<void>;
      withSession?: (ctx: any) => Promise<void>;
    }): Promise<{ cancelled: boolean }>;
    fork(
      entryId: string,
      options?: { position?: "before" | "at"; withSession?: (ctx: any) => Promise<void> },
    ): Promise<{ cancelled: boolean }>;
    navigateTree(
      targetId: string,
      options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
      },
    ): Promise<{ cancelled: boolean }>;
    switchSession(
      sessionPath: string,
      options?: { withSession?: (ctx: any) => Promise<void> },
    ): Promise<{ cancelled: boolean }>;
    reload(): Promise<void>;
  }

  // --- UI ---

  export interface ExtensionUIContext {
    select(
      title: string,
      options: string[],
      opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
    input(
      title: string,
      placeholder?: string,
      opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    onTerminalInput(handler: TerminalInputHandler): () => void;
    setStatus(key: string, text: string | undefined): void;
    setWorkingMessage(message?: string): void;
    setWorkingVisible(visible: boolean): void;
    setWorkingIndicator(options?: WorkingIndicatorOptions): void;
    setHiddenThinkingLabel(label?: string): void;
    setWidget(
      key: string,
      content: string[] | undefined | ((tui: any, theme: any) => Component),
      options?: ExtensionWidgetOptions,
    ): void;
    setFooter(factory: any | undefined): void;
    setHeader(factory: any | undefined): void;
    setTitle(title: string): void;
    custom<T>(
      factory: (
        tui: any,
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => Component | Promise<Component>,
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          width?: number | string;
          minWidth?: number;
          maxHeight?: number | string;
          anchor?:
            | "center"
            | "top-left"
            | "top-right"
            | "bottom-left"
            | "bottom-right"
            | "top-center"
            | "bottom-center"
            | "left-center"
            | "right-center";
          offsetX?: number;
          offsetY?: number;
          row?: number | string;
          col?: number | string;
          margin?: { top?: number; right?: number; bottom?: number; left?: number } | number;
          visible?: (termWidth: number, termHeight: number) => boolean;
          nonCapturing?: boolean;
        };
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T>;
    pasteToEditor(text: string): void;
    setEditorText(text: string): void;
    getEditorText(): string;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    addAutocompleteProvider(factory: any): void;
    setEditorComponent(factory: any | undefined): void;
    getEditorComponent(): any | undefined;
    readonly theme: Theme;
    getAllThemes(): { name: string; path: string | undefined }[];
    getTheme(name: string): Theme | undefined;
    setTheme(theme: string | Theme): { success: boolean; error?: string };
    getToolsExpanded(): boolean;
    setToolsExpanded(expanded: boolean): void;
  }

  export interface ExtensionUIDialogOptions {
    signal?: AbortSignal;
    timeout?: number;
  }

  export interface WorkingIndicatorOptions {
    frames?: string[];
    intervalMs?: number;
  }

  export interface ExtensionWidgetOptions {
    placement?: "aboveEditor" | "belowEditor";
  }

  export type TerminalInputHandler = (
    data: string,
  ) => { consume?: boolean; data?: string } | undefined;

  // --- Tools ---

  export interface ToolDefinition<
    TParams extends TSchema = TSchema,
    TDetails = unknown,
    TState = any,
  > {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TParams;
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => Static<TParams>;
    executionMode?: ToolExecutionMode;
    execute(
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TDetails>>;
    renderCall?: (
      args: Static<TParams>,
      theme: Theme,
      context: ToolRenderContext<TState, Static<TParams>>,
    ) => Component;
    renderResult?: (
      result: AgentToolResult<TDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext<TState, Static<TParams>>,
    ) => Component;
  }

  export interface ToolRenderContext<TState = any, TArgs = any> {
    args: TArgs;
    toolCallId: string;
    invalidate: () => void;
    lastComponent: Component | undefined;
    state: TState;
    cwd: string;
    executionStarted: boolean;
    argsComplete: boolean;
    isPartial: boolean;
    expanded: boolean;
    showImages: boolean;
    isError: boolean;
  }

  export interface ToolRenderResultOptions {
    expanded: boolean;
    isPartial: boolean;
  }

  export interface AgentToolResult<TDetails = unknown> {
    content: (TextContent | ImageContent)[];
    details?: TDetails;
    terminate?: boolean;
  }

  /**
   * Convention: tool details may include `isError: true` to signal error state.
   * This is used by renderResult to determine styling.
   */
  export interface ToolErrorDetails {
    isError: boolean;
  }

  export type AgentToolUpdateCallback<TDetails = unknown> = (
    update: Partial<AgentToolResult<TDetails>>,
  ) => void;

  export type ToolExecutionMode = "sequential" | "parallel";

  export interface RegisteredCommand {
    name: string;
    sourceInfo?: any;
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => any[] | null | Promise<any[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }

  export interface ToolInfo {
    name: string;
    description: string;
    parameters: TSchema;
    sourceInfo: any;
  }

  export interface SlashCommandInfo {
    name: string;
    description?: string;
    sourceInfo?: any;
  }

  // --- Context helpers ---

  export interface ExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    shell?: boolean | string;
    encoding?: string;
    stdin?: string | Uint8Array;
  }

  export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }

  export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  }

  export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: any) => void;
    onError?: (error: Error) => void;
  }

  export interface ReadonlySessionManager {
    getBranch(): any[];
    getEntries(): any[];
    getLeafId(): string | undefined;
    getSessionId(): string;
    getSessionFile(): string | undefined;
  }

  export interface ModelRegistry {
    getAll(): Model<any>[];
    getAvailable(): Model<any>[];
    getApiKeyAndHeaders(model: any): Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      error?: string;
    }>;
    getApiKeyForProvider(providerName: string): Promise<string | undefined>;
    find(providerName: string, modelId: string): Model<any> | undefined;
  }

  export interface Model<T = any> {
    id: string;
    name: string;
    baseUrl?: string;
    api: any;
    reasoning: boolean;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
    provider?: string;
    thinkingLevelMap?: any;
    compat?: any;
  }

  export interface ProviderModelConfig {
    id: string;
    name: string;
    api?: string;
    baseUrl?: string;
    reasoning: boolean;
    // Optional; only meaningful when reasoning is true. Drives which thinking
    // levels appear in the UI and what value is sent for each.
    thinkingLevelMap?: ThinkingLevelMap;
    input: ("text" | "image")[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    compat?: Record<string, unknown>;
  }

  export interface ProviderConfig {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: any;
    streamSimple?: any;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models?: ProviderModelConfig[];
    oauth?: any;
  }

  export interface EventBus {
    emit(event: string, ...args: any[]): void;
    on(event: string, handler: (...args: any[]) => void): () => void;
    off(event: string, handler: (...args: any[]) => void): void;
  }

  // Levels pi exposes across reasoning models. "off" disables thinking; "xhigh"
  // and "max" are opt-in per model via thinkingLevelMap.
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

  // Maps pi thinking levels to provider-side values. Omitted = provider default,
  // string = send that value, null = level is unsupported (hidden/skipped).
  export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

  // --- Content types ---

  export interface TextContent {
    type: "text";
    text: string;
  }

  export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
  }

  // --- Event map ---

  export interface ExtensionEventMap {
    resources_discover: { type: "resources_discover"; cwd: string; reason: "startup" | "reload" };
    session_start: { type: "session_start"; reason: string; previousSessionFile?: string };
    session_before_switch: {
      type: "session_before_switch";
      reason: "new" | "resume";
      targetSessionFile?: string;
    };
    session_before_fork: {
      type: "session_before_fork";
      entryId: string;
      position: "before" | "at";
    };
    session_before_compact: {
      type: "session_before_compact";
      preparation: any;
      branchEntries: any[];
      customInstructions?: string;
      signal: AbortSignal;
    };
    session_compact: { type: "session_compact"; compactionEntry: any; fromExtension: boolean };
    session_shutdown: { type: "session_shutdown"; reason: string; targetSessionFile?: string };
    session_before_tree: { type: "session_before_tree"; preparation: any; signal: AbortSignal };
    session_tree: {
      type: "session_tree";
      newLeafId: string | null;
      oldLeafId: string | null;
      summaryEntry?: any;
      fromExtension?: boolean;
    };
    context: { type: "context"; messages: any[] };
    before_provider_request: { type: "before_provider_request"; payload: unknown };
    after_provider_response: {
      type: "after_provider_response";
      status: number;
      headers: Record<string, string>;
    };
    before_agent_start: {
      type: "before_agent_start";
      prompt: string;
      images?: ImageContent[];
      systemPrompt: string;
      systemPromptOptions: any;
    };
    agent_start: { type: "agent_start" };
    agent_end: { type: "agent_end"; messages: any[] };
    agent_settled: { type: "agent_settled" };
    turn_start: { type: "turn_start"; turnIndex: number; timestamp: number };
    turn_end: { type: "turn_end"; turnIndex: number; message: any; toolResults: any[] };
    message_start: { type: "message_start"; message: any };
    message_update: { type: "message_update"; message: any; assistantMessageEvent: any };
    message_end: { type: "message_end"; message: any };
    tool_execution_start: {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: any;
    };
    tool_execution_update: {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    };
    tool_execution_end: {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };
    model_select: {
      type: "model_select";
      model: Model<any>;
      previousModel: Model<any> | undefined;
      source: "set" | "cycle" | "restore";
    };
    thinking_level_select: {
      type: "thinking_level_select";
      level: ThinkingLevel;
      previousLevel: ThinkingLevel;
    };
    user_bash: { type: "user_bash"; command: string; excludeFromContext: boolean; cwd: string };
    input: {
      type: "input";
      text: string;
      images?: ImageContent[];
      source: "interactive" | "rpc" | "extension";
    };
    tool_call: {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };
    tool_result: {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      content: (TextContent | ImageContent)[];
      isError: boolean;
      details?: unknown;
    };
  }

  export type MessageRenderer<T = unknown> = (
    message: any,
    options: { expanded: boolean },
    theme: Theme,
  ) => any | undefined;

  // --- TUI types (minimal) ---

  export interface Theme {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
    italic(text: string): string;
    underline(text: string): string;
    inverse(text: string): string;
    strikethrough(text: string): string;
    getFgAnsi(color: string): string;
    getBgAnsi(color: string): string;
    getColorMode(): "truecolor" | "256color";
    getThinkingBorderColor(
      level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    ): (str: string) => string;
    getBashModeBorderColor(): (str: string) => string;
    [key: string]: any;
  }

  export interface Component {
    render(width: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
    dispose?(): void;
    width?: number;
  }

  export interface OverlayHandle {
    focus(): void;
    unfocus(options?: { target: Component | null }): void;
    isFocused(): boolean;
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
  }

  // --- TypeBox stub ---

  export type TSchema = any;
  export type Static<T extends TSchema> = any;
}

declare module "typebox" {
  export const Type: {
    Object(properties: Record<string, any>): any;
    String(options?: any): any;
    Number(options?: any): any;
    Boolean(options?: any): any;
    Integer(options?: any): any;
    Optional<T>(schema: T): T;
    Array<T>(items: T, options?: any): any;
    Union<T extends any[]>(schemas: [...T]): any;
    Literal<T extends string | number | boolean>(value: T): any;
    Enum<T extends Record<string, string | number>>(values: T): any;
    Record<K, V>(key: K, value: V): any;
    Tuple<T extends any[]>(items: [...T]): any;
    Any(): any;
    Null(): any;
    Unknown(): any;
  };
}

declare module "@earendil-works/pi-tui" {
  export function truncateToWidth(
    str: string,
    width: number,
    ellipsis?: string,
    pad?: boolean,
  ): string;
  export function visibleWidth(str: string): number;
  export function wrapTextWithAnsi(str: string, width: number): string[];
  export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
  export function isKeyRelease(data: string): boolean;
  export function isKeyRepeat(data: string): boolean;
  export function isKittyProtocolActive(): boolean;

  /** Animated spinner + message row, the component behind pi's "Thinking..."
   * working indicator. */
  export class Loader {
    constructor(
      ui: any,
      spinnerColorFn: (str: string) => string,
      messageColorFn: (str: string) => string,
      message?: string,
      indicator?: { frames?: string[]; intervalMs?: number },
    );
    start(): void;
    stop(): void;
    setMessage(message: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class Input {
    value: string;
    cursor: number;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    focused: boolean;
    constructor();
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export interface SelectItem {
    value: string;
    label: string;
    description?: string;
  }

  export interface SelectListTheme {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
  }

  // Scrollable, type-to-filter selection list used for pickers (provider/model
  // selectors, etc.). Handles arrow keys, enter, escape, and filter input.
  export class SelectList {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    onSelectionChange?: (item: SelectItem) => void;
    constructor(
      items: SelectItem[],
      maxVisible: number,
      theme: SelectListTheme,
      layout?: {
        minPrimaryColumnWidth?: number;
        maxPrimaryColumnWidth?: number;
      },
    );
    setFilter(filter: string): void;
    setSelectedIndex(index: number): void;
    getSelectedItem(): SelectItem | null;
    invalidate(): void;
    render(width: number): string[];
    handleInput(keyData: string): void;
  }

  export interface SettingItem {
    id: string;
    label: string;
    description?: string;
    currentValue: string;
    values?: string[];
  }

  export interface SettingsListTheme {
    label: (text: string, selected: boolean) => string;
    value: (text: string, selected: boolean) => string;
    description: (text: string) => string;
    cursor: string;
    hint: (text: string) => string;
  }

  export class SettingsList {
    constructor(
      items: SettingItem[],
      maxVisible: number,
      theme: SettingsListTheme,
      onChange: (id: string, newValue: string) => void,
      onCancel: () => void,
      options?: { enableSearch?: boolean },
    );
    updateValue(id: string, newValue: string): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(data: string): void;
  }

  // Empty vertical gap, `lines` blank rows.
  export class Spacer {
    constructor(lines?: number);
    invalidate(): void;
    render(width: number): string[];
  }

  export interface Focusable {
    focused: boolean;
  }

  // A composable box of children. render() returns the joined lines so
  // subclasses can frame them; the TUI clips anything that overflows.
  export class Container {
    addChild(child: unknown): void;
    clear(): void;
    invalidate(): void;
    render(width: number): string[];
    dispose(): void;
  }

  export class Text {
    constructor(text: string, x?: number, y?: number);
  }

  export interface Theme {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
    dim?: (text: string) => string;
    italic?: (text: string) => string;
    bg?: (color: string, text: string) => string;
    underline?: (text: string) => string;
    strike?: (text: string) => string;
  }

  export interface TUI {
    requestRender(): void;
    terminal?: { write?(data: string): void };
  }

  // Key descriptor helpers used with matchesKey so both legacy and modern
  // terminal keyboard protocols resolve consistently.
  export const Key: {
    space: string;
    alt(key: string): string;
    shift(key: string): string;
    ctrlAlt(key: string): string;
  };

  export function matchesKey(data: string, keyId: string): boolean;
}

declare module "@earendil-works/pi-coding-agent" {
  export function getAgentDir(): string;
  export const CONFIG_DIR_NAME: string;
  export function getSettingsListTheme(): any;
  export function estimateTokens(message: any): number;
  export const DEFAULT_COMPACTION_SETTINGS: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };

  export class Theme {
    bg(color: string, text: string): string;
    getBgAnsi(color: string): string;
  }

  export class ToolExecutionComponent {
    toolName?: string;
    render(width: number): string[];
  }

  export class BashExecutionComponent {
    command?: string;
    render(width: number): string[];
  }

  export class CustomMessageComponent {
    render(width: number): string[];
  }
}

declare module "@earendil-works/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): any;
  export function complete(model: any, payload: any, options: any): Promise<any>;
  export function completeSimple(
    model: any,
    payload: {
      systemPrompt?: string;
      messages: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
        timestamp: number;
      }>;
    },
    options: {
      apiKey: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      signal?: AbortSignal;
      cacheRetention?: string;
      maxTokens?: number;
      reasoning?: string;
    },
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
  export function getModel(provider: string, id: string): any | undefined;
  // Streaming tool-using completion. Returns an async iterable of events plus a
  // `.result()` promise that resolves with the final AssistantMessage.
  export function stream(model: any, context: any, options?: any): AssistantMessageEventStream;
  export interface AssistantMessageEventStream {
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
    result(): Promise<AssistantMessage>;
  }
  export type AssistantMessageEvent =
    | { type: "start"; partial: AssistantMessage }
    | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
    | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
    | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
  export interface TextContent {
    type: "text";
    text: string;
  }
  export interface ThinkingContent {
    type: "thinking";
    thinking: string;
  }
  export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
  }
  export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
  }
  export interface Tool {
    name: string;
    description: string;
    parameters: any;
  }
  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }
  export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
  export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: string;
    provider: string;
    model: string;
    responseModel?: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
    timestamp: number;
  }
  export interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: Array<TextContent | ImageContent>;
    details?: any;
    isError: boolean;
    timestamp: number;
  }
  export interface UserMessage {
    role: "user";
    content: Array<TextContent | ImageContent> | string;
    timestamp: number;
  }
  export type Message = UserMessage | AssistantMessage | ToolResultMessage;
}

declare module "@earendil-works/pi-coding-agent" {
  // Base class for the interactive input editor. Extensions subclass it to
  // restyle the editor chrome while inheriting text handling, keybindings, and
  // autocomplete from the core Editor.
  export class CustomEditor {
    constructor(
      tui: any,
      theme: any,
      keybindings: any,
      options?: { paddingX?: number; autocompleteMaxVisible?: number },
    );
    borderColor?: ((str: string) => string) | undefined;
    focused: boolean;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean;
    render(width: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
    dispose?(): void;
    getText(): string;
    setText(text: string): void;
    addToHistory?(text: string): void;
    insertTextAtCursor?(text: string): void;
    getExpandedText?(): string;
    setAutocompleteProvider?(provider: any): void;
    setPaddingX?(padding: number): void;
    setAutocompleteMaxVisible?(maxVisible: number): void;
    getPaddingX?(): number;
    getAutocompleteMaxVisible?(): number;
    isShowingAutocomplete?(): boolean;
    autocompleteList?: { render(width: number): string[] };
    getLines?(): string[];
    getCursor?(): unknown;
    getMode?(): unknown;
  }

  export type ReadOperations = {
    readFile(filePath: string): Promise<string>;
    access(filePath: string): Promise<void>;
    detectImageMimeType(filePath: string): Promise<string | null>;
  };

  export type WriteOperations = {
    writeFile(filePath: string, content: string): Promise<void>;
    mkdir(dirPath: string): Promise<void>;
  };

  export type EditOperations = {
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    access(filePath: string): Promise<void>;
  };

  export type LsOperations = {
    exists(filePath: string): Promise<boolean>;
    stat(filePath: string): Promise<any>;
    readdir(dirPath: string): Promise<string[]>;
  };

  export type FindOperations = {
    exists(filePath: string): Promise<boolean>;
    glob(pattern: string, cwd: string, options: { limit: number }): Promise<string[]>;
  };

  export type BashOperations = {
    exec(
      command: string,
      cwd: string,
      options: {
        onData(chunk: string): void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number }>;
  };

  export type GrepToolInput = {
    path?: string;
    pattern: string;
    literal?: boolean;
    ignoreCase?: boolean;
    context?: number;
    limit?: number;
    glob?: string;
  };

  export type GrepToolDetails = {
    matchLimitReached?: number;
    linesTruncated?: boolean;
    truncation?: { content: string; truncated: boolean };
  };

  export function createReadTool(cwd: string, options?: { operations?: ReadOperations }): any;
  export function createWriteTool(cwd: string, options?: { operations?: WriteOperations }): any;
  export function createEditTool(cwd: string, options?: { operations?: EditOperations }): any;
  export function createBashTool(cwd: string, options?: { operations?: BashOperations }): any;
  export function createGrepTool(cwd: string): any;
  export function createFindTool(cwd: string, options?: { operations?: FindOperations }): any;
  export function createLsTool(cwd: string, options?: { operations?: LsOperations }): any;

  // Full-width horizontal rule whose color tracks the terminal width. Used
  // to frame selection dialogs and overlays. Pass an explicit color function
  // when used from jiti-loaded extensions (global theme may be undefined).
  export class DynamicBorder {
    constructor(color?: (str: string) => string);
    invalidate(): void;
    render(width: number): string[];
  }

  export const DEFAULT_MAX_BYTES: number;
  export function formatSize(bytes: number): string;
  export function truncateHead(
    text: string,
    options?: { maxLines?: number },
  ): { content: string; truncated: boolean };
  export function truncateLine(line: string): { text: string; wasTruncated: boolean };
}
