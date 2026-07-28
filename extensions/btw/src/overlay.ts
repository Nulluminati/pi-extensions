import {
  Container,
  type Focusable,
  Input,
  type Theme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { frameBorderLine, frameContentLine, frameRuleLine } from "../../../lib/tui-frame.ts";
import { formatKeyHints } from "../../../lib/ui-format.ts";
import { isFocusShortcut, MAX_QUESTION_LENGTH } from "./constants.ts";
import { globalSmallModelDisplay, resolveThinkingLevel } from "./model.ts";
import { statusToText } from "./thread.ts";
import { buildTranscriptLines, type ThemeLite } from "./transcript.ts";
import type {
  BtwLiveState,
  BtwMode,
  OverlayHandle,
  OverlaySession,
  TranscriptEntry,
} from "./types.ts";

function overlayDimensions(): { width: number; height: number } {
  const columns = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  return {
    width: Math.max(80, Math.floor(columns * 0.78)),
    height: Math.max(24, Math.floor(rows * 0.78)),
  };
}

// --- Overlay component (Container + Input, framed manually) ---

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
      return frameContentLine(this.theme, width, rendered);
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
    out.push(frameBorderLine(this.theme as unknown as ThemeLite, w, "top"));
    out.push(
      frameContentLine(
        this.theme as unknown as ThemeLite,
        w,
        `${focusIndicator}  ${this.theme.fg("accent", this.theme.bold("BTW"))}`,
      ),
    );
    out.push(frameContentLine(this.theme as unknown as ThemeLite, w, config));
    out.push(frameContentLine(this.theme as unknown as ThemeLite, w, summary));
    out.push(frameRuleLine(this.theme as unknown as ThemeLite, w));
    for (const line of wrapped.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    )) {
      out.push(frameContentLine(this.theme as unknown as ThemeLite, w, line));
    }
    const pad = Math.max(
      0,
      transcriptHeight -
        (Math.min(wrapped.length, this.transcriptScrollOffset + transcriptHeight) -
          this.transcriptScrollOffset),
    );
    for (let i = 0; i < pad; i++) {
      out.push(frameContentLine(this.theme as unknown as ThemeLite, w, ""));
    }
    out.push(frameRuleLine(this.theme as unknown as ThemeLite, w));
    out.push(
      frameContentLine(
        this.theme as unknown as ThemeLite,
        w,
        this.theme.fg("warning", this.currentStatus),
      ),
    );
    out.push(this.inputFrame(w));
    out.push(
      frameContentLine(
        this.theme as unknown as ThemeLite,
        w,
        this.theme.fg(
          "dim",
          formatKeyHints([
            ["enter", "ask"],
            ["esc", "cancel"],
            ["mouse/↑↓/pgup/pgdn", "scroll"],
            ["alt+/", "focus"],
          ]),
        ),
      ),
    );
    out.push(frameBorderLine(this.theme as unknown as ThemeLite, w, "bottom"));
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

export function openOverlay(
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
        () => globalSmallModelDisplay().model,
        () =>
          resolveThinkingLevel(state.thread.thinkingOverride, globalSmallModelDisplay().thinking),
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
