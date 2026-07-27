import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import {
  EDITOR_FRAME_COLOR,
  EDITOR_META_SEPARATOR,
  ICON_THINKING,
  THINKING_THEME_COLOR,
} from "./constants.ts";

export function getModelLabel(ctx: ExtensionCommandContext): string {
  const modelId = ctx.model?.id ?? "no-model";
  const provider = ctx.model?.provider;
  return provider ? `${provider}/${modelId}` : modelId;
}

/**
 * Build the metadata segments shown inside the editor frame: the model label
 * (accent) and the thinking level (color-coded per level, muted when off),
 * both always visible. Segments are pre-colored so the frame function stays a
 * pure layout concern.
 */
function buildEditorMetaSegments(modelLabel: string, thinkingLevel: string, theme: any): string[] {
  const segments: string[] = [];
  if (modelLabel) segments.push(theme.fg("accent", modelLabel));
  const level = thinkingLevel || "none";
  const color = THINKING_THEME_COLOR[level] ?? "muted";
  segments.push(theme.fg(color, `${ICON_THINKING} ${level}`));
  return segments;
}

export interface PolishedFrameInput {
  /** Raw lines produced by the base editor's render(). */
  baseRendered: string[];
  /** Number of trailing lines that belong to the autocomplete dropdown. */
  autocompleteCount: number;
  width: number;
  /** Pre-colored metadata segments (model, thinking) for the meta line. */
  metaSegments: string[];
  theme: any;
}

/**
 * Wrap the base editor's rendered output in a neutral grey frame with a
 * metadata line (model + thinking level) inside, adding padding lines so the
 * box is taller. The base editor's own top/bottom borders are stripped (the
 * frame supplies its own); autocomplete lines are preserved below the bottom
 * border. Pure — tested directly with synthetic base output.
 */
export function renderPolishedFrame(input: PolishedFrameInput): string[] {
  const { baseRendered, autocompleteCount, width, metaSegments, theme } = input;
  const fallback = () => baseRendered.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  if (width <= 2 || baseRendered.length < 2) return fallback();

  const acCount =
    autocompleteCount > 0 && autocompleteCount < baseRendered.length ? autocompleteCount : 0;
  const frame = acCount > 0 ? baseRendered.slice(0, -acCount) : baseRendered;
  if (frame.length < 2) return fallback();

  // Strip the base editor's own top and bottom border rows.
  const contentLines = frame.slice(1, -1);
  const autocompleteLines = acCount > 0 ? baseRendered.slice(-acCount) : [];

  const grey = (text: string) => theme.fg(EDITOR_FRAME_COLOR, text);
  const innerWidth = Math.max(0, width);
  const fill = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, "");
    return `${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}`;
  };
  const border = grey("─".repeat(width));
  const meta = metaSegments.filter(Boolean).join(grey(EDITOR_META_SEPARATOR));

  const lines: string[] = [border];
  for (const content of contentLines) lines.push(fill(content));
  lines.push(fill(""));
  if (meta) lines.push(fill(meta));
  lines.push(border);
  for (const ac of autocompleteLines) lines.push(truncateToWidth(ac, width, ""));
  return lines;
}

/**
 * The default Pi editor, framed in a neutral grey box with the model and
 * thinking level shown on a metadata line inside. Subclasses CustomEditor so
 * all text handling, keybindings, autocomplete, and history are inherited;
 * only render() is overridden to add the frame.
 */
export class PolishedEditor extends CustomEditor {
  private readonly uiTheme: any;
  private readonly getModelLabel: () => string;
  private readonly getThinkingLevel: () => string;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    uiTheme: any,
    getModelLabel: () => string,
    getThinkingLevel: () => string,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.uiTheme = uiTheme;
    this.getModelLabel = getModelLabel;
    this.getThinkingLevel = getThinkingLevel;
    // Hold the border grey so the input box never tracks the thinking level.
    this.borderColor = (str: string) => uiTheme.fg(EDITOR_FRAME_COLOR, str);
  }

  render(width: number): string[] {
    if (width <= 2) return super.render(width);
    // No left rail: the base editor renders at the full width and the frame
    // pads its content lines out to match.
    const innerWidth = Math.max(1, width);
    const baseRendered = super.render(innerWidth);
    const autocompleteCount = this.computeAutocompleteCount(innerWidth);
    return renderPolishedFrame({
      baseRendered,
      autocompleteCount,
      width,
      metaSegments: buildEditorMetaSegments(
        this.getModelLabel(),
        this.getThinkingLevel(),
        this.uiTheme,
      ),
      theme: this.uiTheme,
    });
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
