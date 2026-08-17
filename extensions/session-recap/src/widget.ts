import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { AUTO_DISMISS_MS, RECAP_CHANGED_EVENT, WIDGET_KEY } from "./constants.ts";
import { getState } from "./state.ts";

export function showRecap(pi: ExtensionAPI, ctx: ExtensionContext, recap: string) {
  if (!ctx.hasUI) return;
  const state = getState(pi);

  // Clear any existing auto-dismiss timer
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }

  ctx.ui.setWidget(
    WIDGET_KEY,
    (
      _tui: unknown,
      theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
    ) => {
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;
      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const header = theme.fg("accent", theme.bold("✦ recap"));
          const textLines = wrapTextWithAnsi(theme.fg("dim", recap), width);
          cachedLines = [header, ...textLines];
          cachedWidth = width;
          return cachedLines;
        },
        invalidate(): void {
          cachedWidth = undefined;
          cachedLines = undefined;
        },
      };
    },
    { placement: "aboveEditor" },
  );
  pi.events.emit(RECAP_CHANGED_EVENT, { visible: true });

  // Auto-dismiss after timeout
  state.autoDismissTimer = setTimeout(() => {
    state.autoDismissTimer = undefined;
    clearRecap(pi, ctx);
  }, AUTO_DISMISS_MS);
}

export function clearRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  const state = getState(pi);
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  pi.events.emit(RECAP_CHANGED_EVENT, { visible: false });
}
