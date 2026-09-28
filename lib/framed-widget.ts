/** Framed editor widgets: the shared factory behind the jobs, todos, mission,
 * workers, and autoresearch panels above the editor. Body lines and the
 * top-right label are read at render time so the panel always shows the
 * current state; frames are cached per width until invalidated. */

import { renderModalFrame } from "./tui-frame.ts";

// --- Constants ---

/** Body lines shown before the rest collapse into a "↓ N more" indicator. */
const DEFAULT_MAX_BODY_LINES = 8;

// --- Types ---

export interface FramedWidgetTheme {
  fg(color: string, text: string): string;
}

export interface FramedWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

export type FramedWidgetFactory = (tui: unknown, theme: FramedWidgetTheme) => FramedWidgetComponent;

export interface FramedWidgetOptions<TTheme extends FramedWidgetTheme = FramedWidgetTheme> {
  /** Title shown in the top border. */
  title: string;
  /** Right-aligned label in the top border, computed at render time; return
   * undefined to omit it. */
  titleRight?: () => string | undefined;
  /** Unframed body lines, computed at render time. */
  getBodyLines: (theme: TTheme) => string[];
  /** Body lines shown before the rest collapse into "↓ N more". */
  maxBodyLines?: number;
}

// --- Helpers ---

function capBodyLines(theme: FramedWidgetTheme, lines: string[], maxLines: number): string[] {
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  if (hidden > 0) visible.push(theme.fg("dim", `↓ ${hidden} more`));
  return visible;
}

// --- Factory ---

export function createFramedWidget<TTheme extends FramedWidgetTheme = FramedWidgetTheme>(
  options: FramedWidgetOptions<TTheme>,
): (tui: unknown, theme: TTheme) => FramedWidgetComponent {
  const maxBodyLines = options.maxBodyLines ?? DEFAULT_MAX_BODY_LINES;
  return (_tui: unknown, theme: TTheme) => {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;
    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        const titleRight = options.titleRight?.();
        cachedLines = renderModalFrame(
          theme,
          width,
          capBodyLines(theme, options.getBodyLines(theme), maxBodyLines),
          {
            title: options.title,
            paddingY: 0,
            ...(titleRight !== undefined ? { titleRight } : {}),
          },
        );
        cachedWidth = width;
        return cachedLines;
      },
      invalidate(): void {
        cachedWidth = undefined;
        cachedLines = undefined;
      },
    };
  };
}
