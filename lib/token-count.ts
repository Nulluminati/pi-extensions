/** Token labels shared by model pickers and context breakdowns. */
export interface TokenCountStyle {
  /** Show counts below 1,000 as-is instead of rounding to thousands. */
  underThousand?: "raw" | "k";
  /** Show a fixed tenth or omit a zero tenth for thousands. */
  thousands?: "fixed" | "compact";
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
  if (style.thousands === "fixed") return `${scaled.toFixed(1)}k`;
  return `${Math.round(scaled * 10) / 10}k`;
}
