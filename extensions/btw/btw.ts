/**
 * BTW — "By the Way" Side Channel
 *
 * A parallel side conversation in a top-centered overlay window.
 * The user can ask side questions while the main agent is busy, then
 * hand results back when ready. The side thread is hidden from the
 * main agent's context by default.
 *
 * Architecture follows the platform's component model: the overlay is a
 * `Container` whose rows are framed by hand with `frameLine` helpers, and
 * the composer is the platform's `Input` widget. The TUI positions the
 * overlay and clips anything that overflows; we just render the right rows
 * in the right order.
 */

import {
  type AssistantMessage,
  completeSimple,
  stream,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  Key,
  type Theme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "pi";

// --- Constants ---

const MAX_QUESTION_LENGTH = 2000;
const THREAD_CUSTOM_TYPE = "btw-thread";
// Focus shortcut. Alt+key is the only modifier combo that `matchesKey`
// matches in legacy terminals (the fallback is `data === "\x1b" + key`).
// Every other modifier (ctrl+key, plain function keys with non-standard
// terminal sequences) is unreliable across terminal emulators.
const FOCUS_SHORTCUT_PRIMARY = Key.alt("/");
const FOCUS_SHORTCUT_FALLBACK = Key.ctrlAlt("w");

// Escape sequences that deliver alt+/ across terminals. Alacritty with
// the Kitty keyboard protocol enabled sends the CSI-u form; legacy xterm
// sends ESC + key. We intercept ALL of these in the overlay's handleInput
// so the toggle works regardless of which one the terminal emits.
const ALT_SLASH_SEQUENCES = [
  "\x1b/", // legacy: ESC + /
  "\x1b[47;2u", // Kitty CSI-u: alt + slash (codepoint 47, modifier 2)
  "\x1b[47;3u", // Kitty CSI-u: ctrl+alt + slash (some terminals report both)
  "\x1b[27;2;47;47~", // modify-other-keys: alt + slash
];

function isFocusShortcut(data: string): boolean {
  return (
    ALT_SLASH_SEQUENCES.includes(data) ||
    data === FOCUS_SHORTCUT_PRIMARY ||
    data === FOCUS_SHORTCUT_FALLBACK
  );
}

const SIDE_GUIDANCE =
  "You are a side-channel agent: a parallel coding assistant that lives in a small overlay window while the user's main agent works on a separate task. Treat any main-session messages as background only. Focus on the user's side question. Be concise.";

const SUMMARIZE_GUIDANCE =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

// --- Types ---

type BtwMode = "contextual" | "tangent";
type BtwStatus = "idle" | "streaming" | "aborted" | "failed" | "summarizing" | "queued";

interface ModelOverride {
  provider: string;
  id: string;
  api: string;
}

type AssistantBlock = TextContent | { type: "thinking"; thinking: string } | ToolCall;

type BtwMessage =
  | { role: "user"; content: string; timestamp: number }
  | {
      role: "assistant";
      content: AssistantBlock[];
      stopReason: string;
      usage: { totalTokens: number };
      model: string;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
      isError: boolean;
      timestamp: number;
    };

interface BtwThreadState {
  mode: BtwMode;
  messages: BtwMessage[];
  modelOverride: ModelOverride | null;
  thinkingOverride: "none" | "low" | "medium" | "high" | null;
}

// Shape sent to the streaming API. Kept intentionally loose: `stream`'s
// context is untyped, and historical messages only need role/content (the
// live model carries provider/api; usage is an output field).
type StreamMessage =
  | { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }
  | { role: "assistant"; content: AssistantBlock[]; timestamp: number }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
      isError: boolean;
      timestamp: number;
    };

function threadToStreamMessages(thread: BtwThreadState): StreamMessage[] {
  const out: StreamMessage[] = [];
  for (const m of thread.messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: m.content }],
        timestamp: m.timestamp,
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content, timestamp: m.timestamp });
    } else {
      out.push({
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: m.content,
        isError: m.isError,
        timestamp: m.timestamp,
      });
    }
  }
  return out;
}

interface TranscriptEntry {
  kind:
    | "user"
    | "assistant-text"
    | "assistant-thinking"
    | "tool-call"
    | "tool-result"
    | "status"
    | "error";
  text: string;
  meta?: Record<string, unknown>;
  streaming?: boolean;
  failed?: boolean;
}

interface OverlayHandle {
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
}

interface OverlaySession {
  done: () => void;
  handle: OverlayHandle;
  tui: { requestRender: () => void } | null;
}

interface PendingTurn {
  ctx: ExtensionContext;
  question: string;
}

interface BtwLiveState {
  thread: BtwThreadState;
  overlay: OverlaySession | null;
  transcript: TranscriptEntry[];
  status: BtwStatus;
  statusText: string;
  composer: string;
  scroll: number;
  isStreaming: boolean;
  abortedMidTurn: boolean;
  lastError: string | null;
  abortController: AbortController | null;
  pendingTurn: PendingTurn | null;
}

// --- Pure utilities ---

function emptyThread(mode: BtwMode = "contextual"): BtwThreadState {
  return { mode, messages: [], modelOverride: null, thinkingOverride: null };
}

function isModelOverride(value: unknown): value is ModelOverride {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.provider === "string" && typeof v.id === "string" && typeof v.api === "string";
}

function isThreadState(value: unknown): value is BtwThreadState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.mode !== "contextual" && v.mode !== "tangent") return false;
  if (!Array.isArray(v.messages)) return false;
  const mo = v.modelOverride;
  if (mo !== null && mo !== undefined && !isModelOverride(mo)) return false;
  const t = v.thinkingOverride;
  if (
    t !== null &&
    t !== undefined &&
    t !== "none" &&
    t !== "low" &&
    t !== "medium" &&
    t !== "high"
  )
    return false;
  return true;
}

function reconstructThreadState(ctx: ExtensionContext): BtwThreadState {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === THREAD_CUSTOM_TYPE) {
      const data = entry.data as { state?: unknown } | undefined;
      if (data && isThreadState(data.state)) {
        if (data.state.modelOverride) {
          const found = ctx.modelRegistry.find(
            data.state.modelOverride.provider,
            data.state.modelOverride.id,
          );
          if (!found) return emptyThread(data.state.mode);
        }
        // Clone before returning: the live state is mutated as turns run, and
        // we don't want those mutations to alias the persisted branch entry.
        return cloneThreadState(data.state);
      }
    }
  }
  return emptyThread();
}

function cloneThreadState(state: BtwThreadState): BtwThreadState {
  return {
    mode: state.mode,
    messages: state.messages.map((m) => {
      if (m.role === "user") return { ...m };
      if (m.role === "assistant") {
        return { ...m, content: m.content.map((b) => ({ ...b })) };
      }
      return { ...m, content: m.content.map((b) => ({ ...b })) };
    }),
    modelOverride: state.modelOverride ? { ...state.modelOverride } : null,
    thinkingOverride: state.thinkingOverride,
  };
}

function modelLabel(model: { provider?: string; id: string } | undefined): string {
  if (!model) return "(no model)";
  return `${model.provider ?? "main"}/${model.id}`;
}

function statusToText(status: BtwStatus, lastError: string | null): string {
  switch (status) {
    case "idle":
      return "Idle — ready for the next side question.";
    case "streaming":
      return "Streaming the side answer…";
    case "aborted":
      return "Last side turn was aborted. The thread is preserved.";
    case "failed":
      return `Last side turn failed: ${lastError ?? "unknown error"}. The thread is preserved.`;
    case "summarizing":
      return "Distilling the side thread into a summary…";
    case "queued":
      return "Side exchange queued to land after the current turn.";
  }
}

function formatMainBackground(
  branch: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
): string {
  const lines: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const text = extractText(entry.message.content);
    if (!text) continue;
    lines.push(`[${entry.message.role}] ${truncateForBackground(text)}`);
  }
  return lines.join("\n");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" && typeof (b as { text?: string }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function truncateForBackground(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 240)}…`;
}

function buildSystemPrompt(ctx: ExtensionContext, mode: BtwMode, mainBackground: string): string {
  const base = ctx.getSystemPrompt();
  const parts: string[] = [];
  if (base.trim()) parts.push(base.trim());
  parts.push(SIDE_GUIDANCE);
  if (mode === "contextual") {
    parts.push(
      `<main_session_background>\nThe main session the user is running in parallel is summarised below. Treat it as read-only context — the main agent is handling it. Do not duplicate that work.\n\n${mainBackground}\n</main_session_background>`,
    );
  }
  return parts.join("\n\n");
}

function previewToolArgs(args: unknown): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return truncateToWidth(raw, 200, "…");
}

function extractToolResultText(content: TextContent[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function previewToolResultText(text: string): string {
  if (text.length <= 500) return text;
  return `${text.slice(0, 500)}\n[truncated]`;
}

function rebuildTranscriptFromThread(thread: BtwThreadState): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of thread.messages) {
    if (m.role === "user") {
      out.push({ kind: "user", text: m.content });
    } else if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("");
      const thinking = m.content
        .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
        .map((b) => b.thinking)
        .join("");
      const toolCalls = m.content.filter((b): b is ToolCall => b.type === "toolCall");
      if (thinking) out.push({ kind: "assistant-thinking", text: thinking });
      if (text) out.push({ kind: "assistant-text", text });
      for (const call of toolCalls) {
        const args = parseToolArgs(call.arguments);
        out.push({
          kind: "tool-call",
          text: `${call.name}(${previewToolArgs(args)})`,
          meta: { name: call.name, args: previewToolArgs(args) },
        });
      }
    } else if (m.role === "toolResult") {
      const text = extractToolResultText(m.content);
      out.push({ kind: "tool-result", text: previewToolResultText(text), failed: m.isError });
    }
  }
  return out;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function thinkingLevelToReasoning(
  level: "none" | "low" | "medium" | "high" | null | undefined,
): string | undefined {
  if (!level || level === "none") return undefined;
  return level;
}

function resolveThinkingLevel(
  pi: ExtensionAPI,
  override: "none" | "low" | "medium" | "high" | null,
): "none" | "low" | "medium" | "high" {
  if (override) return override;
  const main = pi.getThinkingLevel();
  // Map the platform's ThinkingLevel to our internal subset. "off" is our
  // "none" sentinel (no reasoning effort sent to the provider).
  if (main === "off") return "none";
  if (main === "low" || main === "medium" || main === "high") return main;
  // "minimal" and "xhigh" fall through to "medium".
  return "medium";
}

function overlayDimensions(): { width: number; height: number } {
  const columns = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  return {
    width: Math.max(80, Math.floor(columns * 0.78)),
    height: Math.max(24, Math.floor(rows * 0.78)),
  };
}

// --- Transcript rendering (plain string lines, fed to TUI) ---

type ThemeLite = {
  bold: (s: string) => string;
  fg: (c: string, s: string) => string;
  italic?: (s: string) => string;
  dim?: (s: string) => string;
};

function buildTranscriptLines(
  entries: TranscriptEntry[],
  width: number,
  theme: ThemeLite,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        out.push(theme.fg("accent", `▸ you: ${entry.text}`));
        break;
      }
      case "assistant-text": {
        const cursor = entry.streaming ? "▌" : "";
        out.push(theme.fg("success", `▸ btw: ${entry.text}${cursor}`));
        break;
      }
      case "assistant-thinking": {
        out.push(
          theme.italic?.(
            theme.dim?.(`  ↳ thinking: ${entry.text}`) ?? `  ↳ thinking: ${entry.text}`,
          ) ?? `  ↳ thinking: ${entry.text}`,
        );
        break;
      }
      case "tool-call": {
        const name = String(entry.meta?.name ?? "tool");
        const args = String(entry.meta?.args ?? "");
        out.push(
          theme.dim?.(`  ↳ ${name}(${truncateToWidth(args, Math.max(8, width - 12), "…")})`) ??
            `  ↳ ${name}(${args})`,
        );
        break;
      }
      case "tool-result": {
        const prefix = entry.failed
          ? theme.fg("error", "  ↳ result (error): ")
          : (theme.dim?.("  ↳ result: ") ?? "  ↳ result: ");
        out.push(`${prefix}${entry.text}`);
        break;
      }
      case "status": {
        out.push(theme.dim?.(`  · ${entry.text}`) ?? `  · ${entry.text}`);
        break;
      }
      case "error": {
        out.push(theme.fg("error", `  ✗ ${entry.text}`));
        break;
      }
    }
  }
  return out;
}

// --- Overlay component (Container + Input, framed manually) ---

/**
 * Single bordered line: `│<inner>│` with visible width exactly `width`.
 * `truncateToWidth(..., pad=true)` clips AND pads by visible width, so
 * ANSI escapes don't throw off the alignment.
 */
function frameLine(theme: ThemeLite, width: number, content: string): string {
  const innerWidth = Math.max(1, width - 2);
  const inner = truncateToWidth(content, innerWidth, "…", true);
  return theme.fg("border", "│") + inner + theme.fg("border", "│");
}

function ruleLine(theme: ThemeLite, width: number): string {
  const innerWidth = Math.max(1, width - 2);
  return theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
}

function borderLine(theme: ThemeLite, width: number, edge: "top" | "bottom"): string {
  const innerWidth = Math.max(1, width - 2);
  const left = edge === "top" ? "┌" : "└";
  const right = edge === "top" ? "┐" : "┘";
  return theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
}

/**
 * The bordered overlay. The transcript is laid out as pre-built string
 * lines (wrapped and clipped by hand in render), with the composer as the
 * one real interactive child. The TUI positions the overlay; we just draw
 * the right rows in the right order.
 */
class BtwOverlayComponent extends Container implements Focusable {
  private readonly composer: Input;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly getEntries: () => TranscriptEntry[];
  private readonly getStatus: () => string;
  private readonly getMode: () => BtwMode;
  private readonly getModel: () => string;
  private readonly getThinking: () => string;
  private readonly onSubmit: (value: string) => void;
  private readonly onDismiss: () => void;
  private readonly onUnfocus: () => void;
  private _focused = false;
  private followTranscript = true;
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private transcriptLines: string[] = [];
  private currentMode: BtwMode = "contextual";
  private currentModel = "";
  private currentThinking = "";
  private currentExchanges = 0;
  private currentActive = false;
  private currentStatus = "Ready.";

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.composer.focused = value;
    this.tui.requestRender();
  }

  constructor(
    tui: TUI,
    theme: Theme,
    getEntries: () => TranscriptEntry[],
    getStatus: () => string,
    getMode: () => BtwMode,
    getModel: () => string,
    getThinking: () => string,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.getEntries = getEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.getModel = getModel;
    this.getThinking = getThinking;
    this.onSubmit = onSubmit;
    this.onDismiss = onDismiss;
    this.onUnfocus = onUnfocus;

    this.composer = new Input();
    this.composer.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmit(value);
    };
    this.composer.onEscape = () => this.onDismiss();
    this.addChild(this.composer);

    // Enable SGR mouse reporting so wheel events reach handleInput.
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
    this.refresh();
  }

  override dispose(): void {
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  setDraft(value: string): void {
    this.composer.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.composer.getValue();
  }

  private fitLine(line: string, width: number): string {
    if (visibleWidth(line) > width) return truncateToWidth(line, width, "");
    return line;
  }

  private inputFrame(width: number): string {
    const innerWidth = Math.max(1, width - 2);
    // Render the input UNFOCUSED so the CURSOR_MARKER doesn't skew
    // width calculation for this one row.
    const wasFocused = this.composer.focused;
    this.composer.focused = false;
    try {
      const rendered = this.composer.render(innerWidth)[0] ?? "";
      return frameLine(this.theme, width, rendered);
    } finally {
      this.composer.focused = wasFocused;
    }
  }

  private wrapTranscript(innerWidth: number): string[] {
    const out: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        out.push("");
        continue;
      }
      out.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return out;
  }

  private getDialogHeight(): number {
    return overlayDimensions().height;
  }

  override render(width: number): string[] {
    const w = Math.max(24, width);
    const innerWidth = Math.max(22, w - 2);
    const dialogHeight = this.getDialogHeight();
    // chrome = top border + title + config + summary + upper rule + lower rule + status + composer + hints + bottom border
    const chrome = 10;
    const transcriptHeight = Math.max(6, dialogHeight - chrome);
    this.transcriptViewportHeight = transcriptHeight;

    // Refresh snapshot
    this.currentMode = this.getMode();
    this.currentModel = this.getModel();
    this.currentThinking = this.getThinking();
    const entries = this.getEntries();
    this.currentExchanges = entries.filter(
      (e) => e.kind === "assistant-text" && !e.streaming,
    ).length;
    this.currentActive = entries.some(
      (e) => (e.kind === "assistant-text" || e.kind === "assistant-thinking") && e.streaming,
    );
    this.currentStatus = this.getStatus();
    this.transcriptLines = buildTranscriptLines(
      entries,
      innerWidth,
      this.theme as unknown as ThemeLite,
    );

    const wrapped = this.wrapTranscript(innerWidth);
    const maxScroll = Math.max(0, wrapped.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) this.followTranscript = true;
    }

    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const focusIndicator = this._focused
      ? this.theme.fg("success", this.theme.bold("● FOCUSED"))
      : this.theme.fg("dim", "○");
    const modeLabel = this.currentMode === "tangent" ? "tangent" : "contextual";
    const config = `${this.theme.fg("accent", modeLabel)} · ${this.currentModel} · thinking ${this.currentThinking}`;
    const exchangeLabel = this.currentExchanges === 1 ? "exchange" : "exchanges";
    const summary = `${this.currentExchanges} ${exchangeLabel} · ${this.currentActive ? "streaming" : "idle"}${
      hiddenAbove || hiddenBelow ? ` · ↑${hiddenAbove} ↓${hiddenBelow}` : ""
    }`;

    const out: string[] = [];
    out.push(borderLine(this.theme as unknown as ThemeLite, w, "top"));
    out.push(
      frameLine(
        this.theme as unknown as ThemeLite,
        w,
        `${focusIndicator}  ${this.theme.fg("accent", this.theme.bold("BTW"))}`,
      ),
    );
    out.push(frameLine(this.theme as unknown as ThemeLite, w, config));
    out.push(frameLine(this.theme as unknown as ThemeLite, w, summary));
    out.push(ruleLine(this.theme as unknown as ThemeLite, w));
    for (const line of wrapped.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    )) {
      out.push(frameLine(this.theme as unknown as ThemeLite, w, line));
    }
    const pad = Math.max(
      0,
      transcriptHeight -
        (Math.min(wrapped.length, this.transcriptScrollOffset + transcriptHeight) -
          this.transcriptScrollOffset),
    );
    for (let i = 0; i < pad; i++) {
      out.push(frameLine(this.theme as unknown as ThemeLite, w, ""));
    }
    out.push(ruleLine(this.theme as unknown as ThemeLite, w));
    out.push(
      frameLine(
        this.theme as unknown as ThemeLite,
        w,
        this.theme.fg("warning", this.currentStatus),
      ),
    );
    out.push(this.inputFrame(w));
    out.push(
      frameLine(
        this.theme as unknown as ThemeLite,
        w,
        this.theme.fg("dim", "enter · esc: dismiss · mouse/↑↓/pgup/pgdn: scroll · alt+/: focus"),
      ),
    );
    out.push(borderLine(this.theme as unknown as ThemeLite, w, "bottom"));
    return out.map((line) => this.fitLine(line, width));
  }

  private getMouseScrollDelta(data: string): number | null {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse escape sequence
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) return null;
    const button = Number(match[1]);
    if ((button & 64) !== 64) return null;
    return (button & 1) === 0 ? -3 : 3;
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) this.followTranscript = false;
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (isFocusShortcut(data)) {
      this.onUnfocus();
      return;
    }
    const mouseDelta = this.getMouseScrollDelta(data);
    if (mouseDelta !== null) {
      this.scrollTranscript(mouseDelta);
      return;
    }
    if (data === "\x1b[A" || data === "\x1b[5~" || data === "\x1b[[5~") {
      const step =
        data === "\x1b[5~" || data === "\x1b[[5~"
          ? Math.max(1, this.transcriptViewportHeight - 1)
          : 1;
      this.scrollTranscript(-step);
      return;
    }
    if (data === "\x1b[B" || data === "\x1b[6~" || data === "\x1b[[6~") {
      const step =
        data === "\x1b[6~" || data === "\x1b[[6~"
          ? Math.max(1, this.transcriptViewportHeight - 1)
          : 1;
      this.scrollTranscript(step);
      return;
    }
    this.composer.handleInput(data);
  }

  refresh(): void {
    this.tui.requestRender();
  }
}

// --- Overlay lifecycle ---

type SubmitHandler = (text: string) => Promise<void> | void;

function openOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: BtwLiveState,
  onSubmit: SubmitHandler,
): Promise<void> {
  state.statusText = statusToText(state.status, state.lastError);

  const promise = ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const t = tui as TUI;
      const th = theme as unknown as Theme;
      const overlay = new BtwOverlayComponent(
        t,
        th,
        () => state.transcript,
        () => state.statusText,
        () => state.thread.mode,
        () => {
          const override = state.thread.modelOverride;
          if (override) return `${override.provider}/${override.id}`;
          return modelLabel(ctx.model);
        },
        () => resolveThinkingLevel(pi, state.thread.thinkingOverride),
        async (text) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          if (trimmed.length > MAX_QUESTION_LENGTH) {
            ctx.ui.notify(
              `Side question is too long (${trimmed.length}/${MAX_QUESTION_LENGTH}). Shorten and try again.`,
              "warning",
            );
            return;
          }
          // Clear the composer BEFORE running the turn so the prompt is gone
          // the moment Enter is pressed, not when the response lands.
          overlay.setDraft("");
          await onSubmit(trimmed);
        },
        () => done(),
        () => {
          state.overlay?.handle.unfocus();
        },
      );
      const fallbackHandle: OverlayHandle = {
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => true,
        hide: () => done(),
        setHidden: () => undefined,
        isHidden: () => false,
      };
      const session: OverlaySession = {
        done,
        handle: fallbackHandle,
        tui: t,
      };
      state.overlay = session;
      return overlay as unknown as {
        render: (w: number) => string[];
        invalidate: () => void;
        handleInput?: (d: string) => void;
        dispose?: () => void;
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "78%",
        minWidth: 72,
        maxHeight: "78%",
        anchor: "top-center",
        margin: { top: 1, left: 2, right: 2 },
        nonCapturing: true,
      },
      onHandle: (handle) => {
        if (state.overlay) state.overlay.handle = handle;
        handle.focus();
      },
    },
  );
  void promise.finally(() => {
    if (state.overlay) state.overlay = null;
  });
  return promise as Promise<void>;
}

// --- Side agent loop ---

function assistantContentFromText(
  text: string,
  thinking: string,
  toolCalls: ToolCall[],
): AssistantBlock[] {
  const out: AssistantBlock[] = [];
  if (thinking) out.push({ type: "thinking", thinking });
  if (text) out.push({ type: "text", text });
  for (const call of toolCalls) out.push(call);
  return out;
}

function processStreamEvent(
  state: BtwLiveState,
  event: import("@earendil-works/pi-ai").AssistantMessageEvent,
  onText: (s: string) => void,
  onThinking: (s: string) => void,
  onToolCall: (call: ToolCall) => void,
): void {
  switch (event.type) {
    case "text_start":
      onText("");
      return;
    case "text_delta": {
      const last = lastAssistantTextEntry(state);
      const next = (last?.text ?? "") + event.delta;
      onText(next);
      if (last) {
        const idx = state.transcript.lastIndexOf(last);
        state.transcript[idx] = { ...last, text: next };
      }
      state.statusText = "Streaming the side answer…";
      requestRender(state);
      return;
    }
    case "text_end":
      onText(event.content);
      return;
    case "thinking_start":
      onThinking("");
      // Close any in-progress thinking block so a second block in the same
      // turn (rare) lands in its own entry instead of appending to the first.
      state.transcript = state.transcript.map((e) =>
        e.kind === "assistant-thinking" && e.streaming ? { ...e, streaming: false } : e,
      );
      requestRender(state);
      return;
    case "thinking_delta": {
      const idx = openThinkingEntry(state);
      const existing = state.transcript[idx];
      if (!existing) return;
      const next = existing.text + event.delta;
      onThinking(next);
      state.transcript[idx] = { ...existing, text: next, streaming: true };
      state.statusText = "Streaming the side answer…";
      requestRender(state);
      return;
    }
    case "thinking_end":
      onThinking(event.content);
      return;
    case "toolcall_start":
    case "toolcall_delta":
      return;
    case "toolcall_end": {
      onToolCall(event.toolCall);
      const args = parseToolArgs(event.toolCall.arguments);
      const preview = previewToolArgs(args);
      state.transcript.push({
        kind: "tool-call",
        text: `${event.toolCall.name}(${preview})`,
        meta: { name: event.toolCall.name, args: preview },
      });
      requestRender(state);
      return;
    }
    case "done":
    case "error":
      return;
  }
}

function lastAssistantTextEntry(state: BtwLiveState): TranscriptEntry | undefined {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-text") return e;
  }
  return undefined;
}

/**
 * Find the current turn's open (streaming) thinking entry, or create one.
 * A fresh entry is inserted immediately before the current turn's
 * streaming text placeholder so thinking renders above the answer. This
 * scoping is what keeps each turn's thinking in its own block — without
 * it, `thinking_delta` would latch onto the previous turn's entry.
 */
function openThinkingEntry(state: BtwLiveState): number {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-thinking" && e.streaming) return i;
  }
  let insertAt = state.transcript.length;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-text" && e.streaming) {
      insertAt = i;
      break;
    }
  }
  state.transcript.splice(insertAt, 0, {
    kind: "assistant-thinking",
    text: "",
    streaming: true,
  });
  return insertAt;
}

/** Finalize the current turn's streaming text/thinking entries to their
 *  final buffer values and clear the streaming flag. Mirrored for both
 *  kinds so thinking is scoped per turn just like text. */
function finalizeTurnEntries(
  transcript: TranscriptEntry[],
  textBuffer: string,
  thinkingBuffer: string,
): TranscriptEntry[] {
  return transcript.map((e) => {
    if (e.kind === "assistant-text" && e.streaming) {
      return { ...e, text: textBuffer, streaming: false };
    }
    if (e.kind === "assistant-thinking" && e.streaming) {
      return { ...e, text: thinkingBuffer, streaming: false };
    }
    return e;
  });
}

function requestRender(state: BtwLiveState): void {
  state.overlay?.tui?.requestRender();
}

async function resolveSideModel(
  ctx: ExtensionContext,
  state: BtwLiveState,
): Promise<{
  model: { id: string; provider?: string; api?: string } | null;
  warning: string | null;
}> {
  const override = state.thread.modelOverride;
  if (override) {
    const found = ctx.modelRegistry.find(override.provider, override.id) as
      | { id: string; provider?: string; api?: string }
      | undefined;
    if (!found) {
      // Override no longer registered — drop it and inherit the main thread.
      state.thread.modelOverride = null;
      return { model: ctx.model ?? null, warning: null };
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
    if (!auth?.ok || !auth.apiKey) {
      // Override resolves but has no credentials — keep the preference but
      // fall back to the main model this turn so the side question still
      // gets an answer.
      return {
        model: ctx.model ?? null,
        warning: `Side model ${modelLabel(found)} is unavailable (no credentials); using main model (${modelLabel(ctx.model)}).`,
      };
    }
    return { model: found, warning: null };
  }
  return { model: ctx.model ?? null, warning: null };
}

/**
 * Single entry point for launching a side turn. If a turn is already
 * streaming, the incoming question is queued (status `queued`) and run
 * once the current turn finishes — instead of racing two turns against
 * the same transcript and abort controller.
 */
function requestSideTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: BtwLiveState,
  question: string,
): void {
  if (state.isStreaming) {
    state.pendingTurn = { ctx, question };
    state.status = "queued";
    state.statusText = statusToText("queued", null);
    requestRender(state);
    return;
  }
  void runSideTurn(pi, ctx, state, question).then(() => {
    const next = state.pendingTurn;
    if (!next) return;
    state.pendingTurn = null;
    requestSideTurn(pi, next.ctx, state, next.question);
  });
}

async function runSideTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: BtwLiveState,
  question: string,
): Promise<void> {
  const { model, warning } = await resolveSideModel(ctx, state);
  if (warning) ctx.ui.notify(warning, "warning");
  if (!model) {
    ctx.ui.notify("No model is available for the side channel.", "error");
    return;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) {
    ctx.ui.notify("No credentials available for the resolved side model.", "error");
    return;
  }

  const mainBackground =
    state.thread.mode === "contextual" ? formatMainBackground(ctx.sessionManager.getBranch()) : "";
  const systemPrompt = buildSystemPrompt(ctx, state.thread.mode, mainBackground);

  const tools = [
    createReadTool(ctx.cwd),
    createBashTool(ctx.cwd),
    createEditTool(ctx.cwd),
    createWriteTool(ctx.cwd),
  ];

  const userMessage: BtwMessage = { role: "user", content: question, timestamp: Date.now() };
  state.thread.messages.push(userMessage);
  state.transcript.push({ kind: "user", text: question });

  state.isStreaming = true;
  state.abortedMidTurn = false;
  state.lastError = null;
  state.status = "streaming";
  state.statusText = "Side agent is thinking…";
  state.transcript.push({ kind: "assistant-text", text: "", streaming: true });
  state.scroll = 0;
  requestRender(state);
  persistThread(pi, state);

  // Seed the working transcript with the full side-thread history so the
  // side agent carries context across turns (the current question was just
  // appended to the thread above).
  const workingMessages: StreamMessage[] = threadToStreamMessages(state.thread);

  const maxTurns = 8;
  let totalTokens = 0;
  let modelName = modelLabel(model);
  const effectiveThinking = resolveThinkingLevel(pi, state.thread.thinkingOverride);
  for (let turn = 0; turn < maxTurns; turn++) {
    const abort = new AbortController();
    state.abortController = abort;
    const reasoning = thinkingLevelToReasoning(effectiveThinking);
    const streamOptions: {
      apiKey: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      reasoning?: string;
    } = { apiKey: auth.apiKey };
    if (auth.headers) streamOptions.headers = auth.headers;
    streamOptions.signal = abort.signal;
    if (reasoning) streamOptions.reasoning = reasoning;

    const eventStream = stream(
      model as unknown as Parameters<typeof stream>[0],
      { systemPrompt, tools, messages: workingMessages },
      streamOptions,
    );

    let textBuffer = "";
    let thinkingBuffer = "";
    const collectedToolCalls: ToolCall[] = [];
    let sawStreamError = false;
    let streamErrorMessage = "";
    let streamErrorReason: "aborted" | "error" | null = null;

    try {
      for await (const event of eventStream) {
        if (abort.signal.aborted) break;
        if ((event as { type: string }).type === "error") {
          sawStreamError = true;
          const errEvent = event as {
            type: "error";
            reason: string;
            error?: { errorMessage?: string };
          };
          streamErrorMessage = errEvent.error?.errorMessage ?? errEvent.reason;
          streamErrorReason = errEvent.reason === "aborted" ? "aborted" : "error";
        }
        processStreamEvent(
          state,
          event as import("@earendil-works/pi-ai").AssistantMessageEvent,
          (s) => {
            textBuffer = s;
          },
          (s) => {
            thinkingBuffer = s;
          },
          (c) => {
            collectedToolCalls.push(c);
          },
        );
      }
    } catch (err) {
      sawStreamError = true;
      streamErrorMessage = err instanceof Error ? err.message : String(err);
    }

    let finalMessage: AssistantMessage | null = null;
    try {
      finalMessage = (await eventStream.result()) as AssistantMessage | null;
    } catch {
      finalMessage = null;
    }
    if (finalMessage) {
      totalTokens = finalMessage.usage?.totalTokens ?? totalTokens;
      modelName = finalMessage.model ?? modelName;
    } else if (sawStreamError) {
      // already tracked
    }

    if (sawStreamError) {
      if (streamErrorReason === "aborted") {
        state.abortedMidTurn = true;
        state.status = "aborted";
        state.statusText = statusToText("aborted", null);
        state.transcript = state.transcript.filter(
          (e) => !(e.kind === "assistant-text" && e.streaming),
        );
        break;
      }
      state.lastError = streamErrorMessage || "stream error";
      state.status = "failed";
      state.statusText = statusToText("failed", state.lastError);
      state.transcript = state.transcript.filter(
        (e) => !(e.kind === "assistant-text" && e.streaming),
      );
      state.transcript.push({ kind: "error", text: `Side agent failed: ${state.lastError}` });
      break;
    }

    if (abort.signal.aborted) {
      state.abortedMidTurn = true;
      state.status = "aborted";
      state.statusText = statusToText("aborted", null);
      state.transcript = state.transcript.filter(
        (e) => !(e.kind === "assistant-text" && e.streaming),
      );
      break;
    }

    if (collectedToolCalls.length === 0) {
      state.transcript = finalizeTurnEntries(state.transcript, textBuffer, thinkingBuffer);
      const assistantBlocks = assistantContentFromText(textBuffer, thinkingBuffer, []);
      if (assistantBlocks.length > 0) {
        state.thread.messages.push({
          role: "assistant",
          content: assistantBlocks,
          stopReason: "stop",
          usage: { totalTokens },
          model: modelName,
          timestamp: Date.now(),
        });
      }
      break;
    }

    state.transcript = finalizeTurnEntries(state.transcript, textBuffer, thinkingBuffer);
    const assistantBlocks = assistantContentFromText(
      textBuffer,
      thinkingBuffer,
      collectedToolCalls,
    );
    const assistantTimestamp = Date.now();
    state.thread.messages.push({
      role: "assistant",
      content: assistantBlocks,
      stopReason: "toolUse",
      usage: { totalTokens },
      model: modelName,
      timestamp: assistantTimestamp,
    });
    // Mirror into the working transcript so the next stream call sees the
    // assistant tool-call message BEFORE the tool results it requested.
    workingMessages.push({
      role: "assistant",
      content: assistantBlocks,
      timestamp: assistantTimestamp,
    });
    // Drop the now-completed empty assistant-text entry from the transcript
    // if there was no actual text/thinking content — the tool calls are
    // already in their own entries and a blank "exchange" inflates the count.
    if (!textBuffer && !thinkingBuffer) {
      state.transcript = state.transcript.filter(
        (e) =>
          !(
            (e.kind === "assistant-text" || e.kind === "assistant-thinking") &&
            e.text === "" &&
            !e.streaming
          ),
      );
    }

    for (const call of collectedToolCalls) {
      const tool = tools.find((t: { name: string }) => t.name === call.name) as
        | {
            execute: (
              id: string,
              args: Record<string, unknown>,
              signal?: AbortSignal,
            ) => Promise<{ content: TextContent[]; details?: unknown; isError?: boolean }>;
          }
        | undefined;
      const args = parseToolArgs(call.arguments);
      let resultContent: TextContent[] = [];
      let isError = false;
      const toolCallStart = Date.now();
      try {
        if (!tool) {
          isError = true;
          resultContent = [{ type: "text", text: `Unknown tool: ${call.name}` }];
        } else {
          const result = await tool.execute(call.id, args, abort.signal);
          resultContent = result?.content ?? [];
          isError = Boolean(result?.isError);
        }
      } catch (err) {
        isError = true;
        const msg = err instanceof Error ? err.message : String(err);
        resultContent = [{ type: "text", text: `Tool execution failed: ${msg}` }];
      }
      const toolResultText = extractToolResultText(resultContent);
      state.transcript.push({
        kind: "tool-result",
        text: previewToolResultText(toolResultText),
        failed: isError,
      });
      state.thread.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: resultContent,
        isError,
        timestamp: toolCallStart,
      });
      workingMessages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: resultContent,
        isError,
        timestamp: toolCallStart,
      });
      state.statusText = `Running ${call.name}…`;
      requestRender(state);
    }
    state.transcript.push({ kind: "assistant-text", text: "", streaming: true });
    state.statusText = "Side agent is thinking…";
    requestRender(state);
  }

  state.isStreaming = false;
  state.abortController = null;
  // If the turn cap was hit mid-tool-use, a trailing streaming placeholder
  // was left in the transcript with no response behind it — drop it so the
  // overlay doesn't show a stuck "btw: ▌" line. (Normal completion converts
  // the placeholder to non-streaming; abort/failed paths already filter it.)
  state.transcript = state.transcript.filter((e) => !(e.kind === "assistant-text" && e.streaming));
  if (state.status !== "aborted" && state.status !== "failed") {
    state.status = "idle";
  }
  state.statusText = statusToText(state.status, state.lastError);
  requestRender(state);
  persistThread(pi, state);
}

// --- Persistence ---

function persistThread(pi: ExtensionAPI, state: BtwLiveState): void {
  pi.appendEntry(THREAD_CUSTOM_TYPE, { state: state.thread });
}

function appendResetMarker(pi: ExtensionAPI, mode: BtwMode): void {
  pi.appendEntry(THREAD_CUSTOM_TYPE, { state: emptyThread(mode) });
}

// --- Command helpers ---

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

// --- Handoff ---

// Flatten the side thread into a plain transcript for handoff/summary.
function flattenThreadForHandoff(thread: BtwThreadState): string {
  return thread.messages
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      if (m.role === "assistant") {
        const text = m.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("");
        return `Side: ${text}`;
      }
      return `Tool(${m.toolName}) result: ${m.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("")}`;
    })
    .join("\n\n");
}

function buildHandoffContent(
  thread: BtwThreadState,
  instructions: string,
  mode: "full" | "summary",
  summary: string,
): string {
  const header =
    mode === "full"
      ? "From a side conversation (full thread)"
      : "From a side conversation (summary)";
  const intro = instructions
    ? `User instructions for the main agent: ${instructions}\n\n`
    : "User instructions for the main agent: (none — incorporate as you see fit)\n\n";
  if (mode === "full") {
    return `${header}\n\n${intro}${flattenThreadForHandoff(thread)}`;
  }
  return `${header}\n\n${intro}${summary}`;
}

async function runSummarize(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: BtwLiveState,
  _instructions: string,
): Promise<string | null> {
  const mainModel = ctx.model;
  if (!mainModel) {
    ctx.ui.notify("No model is available to summarize the side thread.", "error");
    return null;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(mainModel);
  if (!auth?.ok || !auth.apiKey) {
    ctx.ui.notify("No credentials available to summarize the side thread.", "error");
    return null;
  }
  const transcript = flattenThreadForHandoff(state.thread);
  if (!transcript.trim()) return null;
  const prompt = `${SUMMARIZE_GUIDANCE}\n\nSide conversation transcript:\n${transcript.slice(0, 12000)}`;
  try {
    const response = await completeSimple(
      mainModel,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        apiKey: auth.apiKey,
        ...(auth.headers ? { headers: auth.headers } : {}),
        reasoning: "minimal",
      },
    );
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- Extension factory ---

export default async function btwExtension(pi: ExtensionAPI) {
  const state: BtwLiveState = {
    thread: emptyThread(),
    overlay: null,
    transcript: [],
    status: "idle",
    statusText: statusToText("idle", null),
    composer: "",
    scroll: 0,
    isStreaming: false,
    abortedMidTurn: false,
    lastError: null,
    abortController: null,
    pendingTurn: null,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.thread = reconstructThreadState(ctx);
    state.transcript = rebuildTranscriptFromThread(state.thread);
    state.composer = "";
    state.scroll = 0;
    state.status = "idle";
    state.statusText = statusToText("idle", null);
    state.isStreaming = false;
    state.lastError = null;
    state.pendingTurn = null;
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (state.isStreaming && state.abortController) {
      state.abortController.abort();
    }
    state.pendingTurn = null;
    if (state.overlay) {
      state.overlay.done();
      state.overlay = null;
    }
  });

  pi.on("context", async (event, _ctx) => {
    const filtered = (event.messages as Array<{ customType?: string }>).filter(
      (m) => m.customType !== THREAD_CUSTOM_TYPE,
    );
    if (filtered.length === event.messages.length) return undefined;
    return { messages: filtered };
  });

  function toggleOverlayFocus(): void {
    const handle = state.overlay?.handle;
    if (!handle) return;
    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    state.overlay?.tui?.requestRender();
  }

  pi.registerShortcut(FOCUS_SHORTCUT_PRIMARY, {
    description: "Toggle focus between the side window and the main editor",
    handler: () => toggleOverlayFocus(),
  });
  pi.registerShortcut(FOCUS_SHORTCUT_FALLBACK, {
    description: "Toggle focus between the side window and the main editor (fallback)",
    handler: () => toggleOverlayFocus(),
  });

  function ensureOverlayOpen(extraCtx: ExtensionContext): void {
    if (state.overlay) return;
    void openOverlay(pi, extraCtx, state, async (text) => {
      requestSideTurn(pi, extraCtx, state, text);
    });
  }

  pi.registerCommand("btw", {
    description: "Open the side window and (optionally) ask a question: /btw [question]",
    handler: async (args, ctx) => {
      const question = args.trim();
      // No question — just open the overlay. The user can type into the
      // composer and press Enter to start a side turn.
      if (!question) {
        ensureOverlayOpen(ctx);
        return;
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        ctx.ui.notify(
          `Side question is too long (${question.length}/${MAX_QUESTION_LENGTH}).`,
          "warning",
        );
        return;
      }
      ensureOverlayOpen(ctx);
      requestSideTurn(pi, ctx, state, question);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Reset the side thread and open the window: /btw:new [question]",
    handler: async (args, ctx) => {
      const question = args.trim();
      // Reset the thread regardless of whether a question was passed.
      state.thread = emptyThread("contextual");
      state.transcript = [];
      state.composer = "";
      state.scroll = 0;
      state.lastError = null;
      state.status = "idle";
      state.statusText = statusToText("idle", null);
      appendResetMarker(pi, "contextual");
      ensureOverlayOpen(ctx);
      ctx.ui.notify("Started a new side thread.", "info");
      if (question) {
        requestSideTurn(pi, ctx, state, question);
      }
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Open a contextless tangent: /btw:tangent [question]",
    handler: async (args, ctx) => {
      const question = args.trim();
      state.thread = emptyThread("tangent");
      state.transcript = [];
      state.composer = "";
      state.scroll = 0;
      state.lastError = null;
      state.status = "idle";
      state.statusText = statusToText("idle", null);
      appendResetMarker(pi, "tangent");
      ensureOverlayOpen(ctx);
      ctx.ui.notify("Tangent thread started (no main context).", "info");
      if (question) {
        requestSideTurn(pi, ctx, state, question);
      }
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Wipe the side thread and close the side window",
    handler: async (_args, ctx) => {
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("No side thread to clear.", "info");
        return;
      }
      state.thread = emptyThread("contextual");
      state.transcript = [];
      state.composer = "";
      state.scroll = 0;
      state.lastError = null;
      state.status = "idle";
      state.statusText = statusToText("idle", null);
      appendResetMarker(pi, "contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify("Side thread cleared.", "info");
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Hand the full side thread back to the main agent: /btw:inject [instructions]",
    handler: async (args, ctx) => {
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("Nothing to hand off — the side thread is empty.", "warning");
        return;
      }
      const instructions = args.trim();
      const content = buildHandoffContent(state.thread, instructions, "full", "");
      const idle = ctx.isIdle();
      if (idle) pi.sendUserMessage(content);
      else pi.sendUserMessage(content, { deliverAs: "followUp" });
      state.thread = emptyThread("contextual");
      state.transcript = [];
      state.composer = "";
      state.scroll = 0;
      state.lastError = null;
      state.status = "idle";
      state.statusText = statusToText("idle", null);
      appendResetMarker(pi, "contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify(
        idle ? "Side thread injected into the main agent." : "Side thread injected as a follow-up.",
        "info",
      );
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Distill the side thread and hand a summary back: /btw:summarize [instructions]",
    handler: async (args, ctx) => {
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("Nothing to hand off — the side thread is empty.", "warning");
        return;
      }
      const instructions = args.trim();
      state.status = "summarizing";
      state.statusText = statusToText("summarizing", null);
      requestRender(state);
      const summary = await runSummarize(pi, ctx, state, instructions);
      if (!summary) {
        state.status = "idle";
        state.statusText = statusToText("idle", state.lastError);
        ctx.ui.notify(
          "Summarisation failed — the side thread is preserved for a retry.",
          "warning",
        );
        return;
      }
      const content = buildHandoffContent(state.thread, instructions, "summary", summary);
      const idle = ctx.isIdle();
      if (idle) pi.sendUserMessage(content);
      else pi.sendUserMessage(content, { deliverAs: "followUp" });
      state.thread = emptyThread("contextual");
      state.transcript = [];
      state.composer = "";
      state.scroll = 0;
      state.lastError = null;
      state.status = "idle";
      state.statusText = statusToText("idle", null);
      appendResetMarker(pi, "contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify(
        idle
          ? "Side thread summarised and injected."
          : "Side thread summarised and injected as a follow-up.",
        "info",
      );
    },
  });

  pi.registerCommand("btw:model", {
    description: "Show or set the side model: /btw:model [provider model api | clear]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const ov = state.thread.modelOverride;
        if (ov) ctx.ui.notify(`Side model is ${ov.provider}/${ov.id} (override).`, "info");
        else
          ctx.ui.notify(`Side model is inheriting main thread (${modelLabel(ctx.model)}).`, "info");
        return;
      }
      if (trimmed === "clear") {
        state.thread.modelOverride = null;
        persistThread(pi, state);
        ctx.ui.notify("Side model override cleared — back to inheriting the main thread.", "info");
        return;
      }
      const tokens = tokenize(trimmed);
      if (tokens.length < 3) {
        ctx.ui.notify("Usage: /btw:model <provider> <model> <api> | clear", "warning");
        return;
      }
      const [provider, id, api] = tokens;
      if (!provider || !id || !api) {
        ctx.ui.notify("Usage: /btw:model <provider> <model> <api> | clear", "warning");
        return;
      }
      const found = ctx.modelRegistry.find(provider, id) as
        | { id: string; api?: string }
        | undefined;
      if (!found) {
        ctx.ui.notify(`Unknown model: ${provider}/${id}. Add it with /provider first.`, "error");
        return;
      }
      state.thread.modelOverride = { provider, id, api };
      persistThread(pi, state);
      ctx.ui.notify(`Side model set to ${provider}/${id} (${api}).`, "info");
    },
  });

  pi.registerCommand("btw:thinking", {
    description: "Show or set the side thinking level: /btw:thinking [low|medium|high|none|clear]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const ov = state.thread.thinkingOverride;
        if (ov) ctx.ui.notify(`Side thinking level is ${ov} (override).`, "info");
        else
          ctx.ui.notify(
            `Side thinking level is to inherit the main thread (${pi.getThinkingLevel() ?? "medium"}).`,
            "info",
          );
        return;
      }
      if (trimmed === "clear") {
        state.thread.thinkingOverride = null;
        persistThread(pi, state);
        ctx.ui.notify("Side thinking level cleared — back to inheriting the main thread.", "info");
        return;
      }
      if (trimmed !== "low" && trimmed !== "medium" && trimmed !== "high" && trimmed !== "none") {
        ctx.ui.notify("Usage: /btw:thinking <low|medium|high|none|clear>", "warning");
        return;
      }
      state.thread.thinkingOverride = trimmed as "none" | "low" | "medium" | "high";
      persistThread(pi, state);
      ctx.ui.notify(`Side thinking level set to ${trimmed}.`, "info");
    },
  });
}
