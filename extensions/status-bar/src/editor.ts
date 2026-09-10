import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import {
  EDITOR_META_SEPARATOR,
  FLEX_OFF_COLOR,
  FLEX_ON_COLOR,
  ICON_FLEX,
  ICON_SMALL_MODEL,
  ICON_THINKING,
  ICON_WORKER_MODEL,
  MODAL_PADDING_X,
  MODAL_PADDING_Y,
  THINKING_THEME_COLOR,
} from "./constants.ts";

export function getModelLabel(ctx: ExtensionCommandContext): string {
  const modelId = ctx.model?.id ?? "no-model";
  const provider = ctx.model?.provider;
  return provider ? `${provider}/${modelId}` : modelId;
}

/**
 * Build the title segments shown in the editor's top border. The main group
 * comes first — model (accent), thinking level (color-coded per level, muted
 * when off), and a flex badge when the model is flex-capable. When a small
 * model is configured, a dim "/" introduces its label, rendered grey to read
 * as subordinate to the main model. Segments are pre-colored so the frame
 * function stays a pure layout concern.
 */
export function buildEditorMetaSegments(
  modelLabel: string,
  thinkingLevel: string,
  flex: { on: boolean; capable: boolean },
  smallModelLabel: string,
  theme: any,
  workerModelLabel = "",
): string[] {
  const segments: string[] = [];
  if (modelLabel) segments.push(theme.fg("accent", modelLabel));
  const level = thinkingLevel || "none";
  const color = THINKING_THEME_COLOR[level] ?? "muted";
  segments.push(theme.fg(color, `${ICON_THINKING} ${level}`));
  if (flex.capable) {
    const flexColor = flex.on ? FLEX_ON_COLOR : FLEX_OFF_COLOR;
    segments.push(theme.fg(flexColor, `${ICON_FLEX} flex ${flex.on ? "on" : "off"}`));
  }
  if (smallModelLabel) {
    // The small model label sits after a dim "/" separator, grey to read as
    // subordinate to the main model.
    segments.push(theme.fg("dim", "/"));
    segments.push(theme.fg("dim", `${ICON_SMALL_MODEL} ${smallModelLabel}`));
  }
  if (workerModelLabel) {
    // The worker model label sits next to the small model, same dim
    // treatment: it configures delegated workers, not this session.
    segments.push(theme.fg("dim", "/"));
    // The filled robot-industrial glyph is wider than the outline one; an
    // extra space keeps the icon-to-label gap visually consistent.
    segments.push(theme.fg("dim", `${ICON_WORKER_MODEL}  ${workerModelLabel}`));
  }
  return segments;
}

export interface EditorModalFrameInput {
  /** Raw lines produced by the base editor's render(), rendered at the modal's
   * inner content width. */
  baseRendered: string[];
  /** Number of trailing lines that belong to the autocomplete dropdown. */
  autocompleteCount: number;
  width: number;
  /** Pre-colored title string shown in the top border (model + thinking). */
  title: string;
  /** Pre-colored right-aligned label in the top border, opposite the title
   * (for example "Plan Mode" while the plan extension is in plan mode). */
  titleRight?: string;
  theme: any;
  /** Optional theme color name for the frame strokes; tints the whole frame
   * (for example the warning color while the plan extension is in plan mode). */
  borderColor?: string;
}

/**
 * Wrap the base editor's rendered output in the same rounded accent modal
 * frame the voice/handoff overlays use (renderModalFrame), with the model and
 * thinking level shown in the title (top border). The base editor's own
 * top/bottom borders are stripped (the modal supplies its own); autocomplete
 * lines are preserved below the box. Pure — tested directly with synthetic
 * base output.
 */
export function renderEditorModalFrame(input: EditorModalFrameInput): string[] {
  const { baseRendered, autocompleteCount, width, title, theme } = input;
  const fallback = () => baseRendered.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  if (width < 4 || baseRendered.length < 2) return fallback();

  const acCount =
    autocompleteCount > 0 && autocompleteCount < baseRendered.length ? autocompleteCount : 0;
  const frame = acCount > 0 ? baseRendered.slice(0, -acCount) : baseRendered;
  if (frame.length < 2) return fallback();

  // Strip the base editor's own top and bottom border rows; the modal frame
  // supplies its own. Autocomplete lines are preserved below the box.
  const contentLines = frame.slice(1, -1);
  const autocompleteLines = acCount > 0 ? baseRendered.slice(-acCount) : [];

  const modalLines = renderModalFrame(theme, width, contentLines, {
    title,
    rawTitle: true,
    paddingX: MODAL_PADDING_X,
    paddingY: MODAL_PADDING_Y,
    ...(input.titleRight !== undefined ? { titleRight: input.titleRight } : {}),
    ...(input.borderColor !== undefined ? { borderColor: input.borderColor } : {}),
  });
  return [...modalLines, ...autocompleteLines.map((line) => truncateToWidth(line, width, ""))];
}

/**
 * The default Pi editor, framed in the same rounded accent modal box the
 * voice/handoff overlays use, with the model and thinking level shown in the
 * title (top border). Subclasses CustomEditor so all text handling,
 * keybindings, autocomplete, and history are inherited; only render() is
 * overridden to add the frame.
 */

// --- Prompt history persistence ---

/**
 * The app stores prompt history per editor instance, and recreates the editor
 * whenever the editor component is re-set (extension reload, /reload) — the
 * swap carries only the current text, so the history buffer would reset. The
 * store below mirrors submitted prompts in the process (globalThis-keyed, so
 * extension re-imports cannot lose it) and every new PolishedEditor replays
 * it into its own buffer on construction.
 */
const HISTORY_STORE_KEY = Symbol.for("status-bar.prompt-history");
const HISTORY_LIMIT = 100;

function promptHistoryStore(): string[] {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[HISTORY_STORE_KEY] as string[] | undefined;
  if (!store) {
    store = [];
    g[HISTORY_STORE_KEY] = store;
  }
  return store;
}

function mirrorPrompt(text: string): void {
  const store = promptHistoryStore();
  if (store[0] !== text) store.unshift(text);
  if (store.length > HISTORY_LIMIT) store.length = HISTORY_LIMIT;
}

export class PolishedEditor extends CustomEditor {
  private readonly uiTheme: any;
  private readonly getModelLabel: () => string;
  private readonly getSmallModelLabel: () => string;
  private readonly getWorkerModelLabel: () => string;
  private readonly getThinkingLevel: () => string;
  private readonly getFlexState: () => { on: boolean; capable: boolean };
  private readonly getBorderColor: () => string | undefined;
  private readonly getTitleRight: () => string | undefined;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    uiTheme: any,
    getModelLabel: () => string,
    getSmallModelLabel: () => string,
    getThinkingLevel: () => string,
    getFlexState: () => { on: boolean; capable: boolean },
    getBorderColor: () => string | undefined,
    getTitleRight: () => string | undefined,
    getWorkerModelLabel?: () => string,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
    // Restore prompts recorded by previous editor instances (oldest first, so
    // the newest entry lands at the top of the history buffer).
    for (const entry of [...promptHistoryStore()].reverse()) {
      super.addToHistory?.(entry);
    }
    this.uiTheme = uiTheme;
    this.getModelLabel = getModelLabel;
    this.getSmallModelLabel = getSmallModelLabel;
    this.getWorkerModelLabel = getWorkerModelLabel ?? (() => "");
    this.getThinkingLevel = getThinkingLevel;
    this.getFlexState = getFlexState;
    this.getBorderColor = getBorderColor;
    this.getTitleRight = getTitleRight;
    // The base editor's own borders are discarded by render(); the modal frame
    // supplies its own borderAccent border, so no borderColor override needed.
  }

  /** Mirror submitted prompts into the process-wide store for successors. */
  override addToHistory(text: string): void {
    super.addToHistory?.(text);
    const trimmed = text.trim();
    if (trimmed) mirrorPrompt(trimmed);
  }

  render(width: number): string[] {
    if (width < 4) return super.render(width);
    // Render the base editor at the modal's inner content width so its text
    // (and autocomplete) fit inside the side borders + padding.
    const contentWidth = modalContentWidth(width, MODAL_PADDING_X);
    const baseRendered = super.render(contentWidth);
    const autocompleteCount = this.computeAutocompleteCount(contentWidth);
    const borderColor = this.getBorderColor();
    const titleRight = this.getTitleRight();
    return renderEditorModalFrame({
      baseRendered,
      autocompleteCount,
      width,
      title: this.buildTitle(),
      theme: this.uiTheme,
      ...(borderColor !== undefined ? { borderColor } : {}),
      ...(titleRight !== undefined ? { titleRight } : {}),
    });
  }

  /** Join the model/thinking/small-model segments into the title string. */
  private buildTitle(): string {
    return buildEditorMetaSegments(
      this.getModelLabel(),
      this.getThinkingLevel(),
      this.getFlexState(),
      this.getSmallModelLabel(),
      this.uiTheme,
      this.getWorkerModelLabel(),
    )
      .filter(Boolean)
      .join(EDITOR_META_SEPARATOR);
  }

  /**
   * Count trailing autocomplete lines the base editor appended below its bottom
   * border, so they can be preserved below the frame's bottom border instead
   * of being treated as content.
   */
  private computeAutocompleteCount(innerWidth: number): number {
    const base = this as unknown as {
      isShowingAutocomplete?: () => boolean;
      autocompleteList?: { render: (width: number) => string[] };
    };
    if (typeof base.isShowingAutocomplete !== "function") return 0;
    if (!base.isShowingAutocomplete()) return 0;
    const list = base.autocompleteList;
    if (!list || typeof list.render !== "function") return 0;
    try {
      return list.render(innerWidth).length;
    } catch {
      return 0;
    }
  }
}
