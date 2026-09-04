// Bounded windowing for raw cached documents.
//
// context7_get_cached_doc_raw exists to return the full uncurated document,
// but an uncapped tool result can force context compaction (which resets the
// provider prompt cache). Windows are bounded at 2,000 lines / 40,000 chars —
// in the spirit of pi's read tool — and offsetLine paging keeps the rest of
// the document reachable in chunks.

// --- Constants ---

export const MAX_RAW_LINES = 2_000;
export const MAX_RAW_CHARS = 40_000;

// --- Types ---

export interface RawDocWindow {
  text: string;
  totalLines: number;
  totalChars: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffsetLine?: number | undefined;
}

// --- Helpers ---

/**
 * Return the window of rawText starting at requestedOffsetLine (1-based).
 * A document that fits one window from line 1 is returned unchanged; any
 * other window is wrapped with a range header and — while lines remain — a
 * footer naming the next offsetLine.
 */
export function sliceRawDoc(rawText: string, requestedOffsetLine?: number): RawDocWindow {
  const totalChars = rawText.length;
  const lines = rawText.split("\n");
  const totalLines = lines.length;
  const offsetLine = Math.max(1, Math.floor(requestedOffsetLine ?? 1));

  if (offsetLine > totalLines) {
    throw new Error(
      `offsetLine ${offsetLine} is beyond the end of the document (${totalLines} lines).`,
    );
  }

  if (offsetLine === 1 && totalLines <= MAX_RAW_LINES && totalChars <= MAX_RAW_CHARS) {
    return {
      text: rawText,
      totalLines,
      totalChars,
      startLine: 1,
      endLine: totalLines,
      truncated: false,
    };
  }

  const startIndex = offsetLine - 1;
  const collected: string[] = [];
  let usedChars = 0;
  let lastIndex = startIndex;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (collected.length === 0 && line.length > MAX_RAW_CHARS) {
      // A single line larger than the whole budget: hard-slice it so the
      // window always makes progress.
      collected.push(line.slice(0, MAX_RAW_CHARS));
      lastIndex = i;
      break;
    }
    const joinCost = collected.length > 0 ? 1 : 0;
    if (collected.length > 0 && usedChars + line.length + joinCost > MAX_RAW_CHARS) break;
    collected.push(line);
    usedChars += line.length + joinCost;
    lastIndex = i;
    if (collected.length >= MAX_RAW_LINES) break;
  }

  const endLine = lastIndex + 1;
  const truncated = endLine < totalLines;
  const header = `[Context7 cached doc — lines ${offsetLine}-${endLine} of ${totalLines} (${totalChars} chars)]`;
  const footer = truncated
    ? `\n\n[Truncated — call again with offsetLine=${endLine + 1} for the next page]`
    : "";

  return {
    text: `${header}\n\n${collected.join("\n")}${footer}`,
    totalLines,
    totalChars,
    startLine: offsetLine,
    endLine,
    truncated,
    nextOffsetLine: truncated ? endLine + 1 : undefined,
  };
}
