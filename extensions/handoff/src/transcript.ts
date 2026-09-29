import { formatTranscriptEntry, type TranscriptEntry } from "../../../lib/transcript-prompt.ts";

const TRANSCRIPT_MAX_CHARS = 36000;

export type HandoffEntry = TranscriptEntry;

// --- Pure utilities ---

export function buildTranscript(entries: HandoffEntry[]): string {
  const lines: string[] = [];
  let length = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;

    const line = formatTranscriptEntry(entry);
    if (!line) continue;

    const separatorLength = lines.length > 0 ? 1 : 0;
    const available = TRANSCRIPT_MAX_CHARS - length - separatorLength;
    if (available <= 0) break;

    if (line.length > available) {
      lines.unshift(available > 1 ? `${line.slice(0, available - 1)}…` : line.slice(0, available));
      break;
    }

    lines.unshift(line);
    length += line.length + separatorLength;
  }

  return lines.join("\n");
}
