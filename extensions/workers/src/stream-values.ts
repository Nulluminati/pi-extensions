/** Pure stream text helpers shared by worker ingestion and read-only displays. */

/** Arg/result summaries in stream displays stay one line and short. */
export const STREAM_SUMMARY_CHARS = 200;

/** One-line summary of tool args or results: prefer the common location /
 *  command keys, fall back to a truncated JSON dump. Never multi-line. */
export function summarizeStreamValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const preferred =
    typeof value === "object" && value !== null
      ? ((value as Record<string, unknown>).path ??
        (value as Record<string, unknown>).file_path ??
        (value as Record<string, unknown>).command ??
        (value as Record<string, unknown>).pattern ??
        (value as Record<string, unknown>).url ??
        (value as Record<string, unknown>).query ??
        (value as Record<string, unknown>).task)
      : value;
  if (typeof preferred === "string" && !preferred.trim()) return undefined;
  const raw = typeof preferred === "string" && preferred.trim() ? preferred : JSON.stringify(value);
  const oneLine = raw.replace(/\\?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > STREAM_SUMMARY_CHARS
    ? `${oneLine.slice(0, STREAM_SUMMARY_CHARS)}…`
    : oneLine;
}

/** Concatenated text-block text from an assistant message's content; empty
 *  when the content is not an array of text blocks. */
export function assistantTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}
