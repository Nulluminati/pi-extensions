/** Shared formatting for keyboard hints and extension status lines. */

interface UiTheme {
  fg(color: string, text: string): string;
}

export interface StatusLineOptions {
  icon: string;
  prefix: string;
  text: string;
  iconColor?: string;
  textColor?: string;
}

export type KeyHint = readonly [key: string, action: string];

export function formatKeyHints(hints: readonly KeyHint[]): string {
  return hints.map(([key, action]) => `${key.toLowerCase()}: ${action}`).join(" · ");
}

export function formatStatusLine(theme: UiTheme, options: StatusLineOptions): string {
  const icon = theme.fg(options.iconColor ?? "accent", options.icon);
  const text = theme.fg(options.textColor ?? "muted", `${options.prefix}: ${options.text}`);
  return `${icon} ${text}`;
}
