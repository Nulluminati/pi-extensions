/** Token labels shared by model pickers, goal status, and context breakdowns. */
export interface TokenCountStyle {
  /** Show counts below 1,000 as-is instead of rounding to thousands. */
  underThousand?: "raw" | "k";
  /** Round thousands to a whole number, show fixed tenths, or omit a zero tenth. */
  thousands?: "rounded" | "fixed" | "compact";
  /** Show a fixed tenth or omit a zero tenth for millions. */
  millions?: "fixed" | "compact";
}

export function formatTokenCount(value: number, style: TokenCountStyle = {}): string {
  if (value < 1_000 && style.underThousand === "raw") return `${value}`;
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${style.millions === "fixed" ? scaled.toFixed(1) : Math.round(scaled * 10) / 10}m`;
  }
  const scaled = value / 1_000;
  if (style.thousands === "rounded") return `${Math.round(scaled)}k`;
  if (style.thousands === "fixed") return `${scaled.toFixed(1)}k`;
  return `${Math.round(scaled * 10) / 10}k`;
}
