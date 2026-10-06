/** Bounded historical windows of read-only worker transcript artifacts. */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isNodeError } from "../../../lib/errors.ts";
import { assertWorkerId } from "../../workers/src/ids.ts";
import { stderrLogPath, streamPath } from "../../workers/src/store.ts";
import { replayTranscriptEvents, type TranscriptBlock } from "./transcript-events.ts";

const PAGE_BYTES = 512 * 1024;
const EVENT_BYTES = 8 * 1024 * 1024;

export interface TranscriptPage {
  blocks: TranscriptBlock[];
  revision: string;
  start: number;
  end: number;
  size: number;
  hasPrevious: boolean;
  hasNext: boolean;
  warnings: string[];
}

export interface TranscriptPageOptions {
  channel?: "stdout" | "stderr";
  before?: number;
  after?: number;
}

function emptyPage(): TranscriptPage {
  return {
    blocks: [],
    revision: "missing",
    start: 0,
    end: 0,
    size: 0,
    hasPrevious: false,
    hasNext: false,
    warnings: [],
  };
}

async function readWindow(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

export async function readTranscriptPage(
  cwd: string,
  id: string,
  options: TranscriptPageOptions = {},
): Promise<TranscriptPage> {
  assertWorkerId(id);
  if (options.before !== undefined && options.after !== undefined)
    throw new Error("Choose one transcript page boundary");
  for (const offset of [options.before, options.after]) {
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      throw new Error("Invalid transcript page boundary");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      options.channel === "stderr" ? stderrLogPath(cwd, id) : streamPath(cwd, id),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return emptyPage();
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Worker transcript is not a regular file");
    const size = stat.size;
    const forward = options.after !== undefined;
    let start = forward
      ? options.after && options.after <= size
        ? options.after
        : 0
      : Math.max(0, Math.min(size, options.before ?? size) - PAGE_BYTES);
    let end = forward ? Math.min(size, start + PAGE_BYTES) : Math.min(size, options.before ?? size);
    let buffer = await readWindow(handle, start, end);
    const warnings: string[] = [];
    // A large event still belongs to one page. Expand only up to the explicit safety bound.
    while (buffer.length < EVENT_BYTES) {
      const first = buffer.indexOf(10);
      const needsMore = forward
        ? first === -1 && end < size
        : start > 0 && (first === -1 || first === buffer.length - 1);
      if (!needsMore) break;
      if (forward)
        end = Math.min(
          size,
          start + Math.min(EVENT_BYTES, Math.max(PAGE_BYTES, buffer.length * 2)),
        );
      else
        start = Math.max(0, end - Math.min(EVENT_BYTES, Math.max(PAGE_BYTES, buffer.length * 2)));
      buffer = await readWindow(handle, start, end);
    }
    if (start > 0) {
      const previous = await readWindow(handle, start - 1, start);
      if (previous[0] !== 10) {
        const boundary = buffer.indexOf(10);
        if (boundary >= 0 && boundary < buffer.length - 1) {
          start += boundary + 1;
          buffer = buffer.subarray(boundary + 1);
        } else {
          warnings.push("Transcript event exceeds the 8 MiB display safety limit.");
          buffer = Buffer.alloc(0);
        }
      }
    }
    if (forward && end < size && buffer.length > 0) {
      const boundary = buffer.lastIndexOf(10);
      if (boundary >= 0) {
        buffer = buffer.subarray(0, boundary + 1);
        end = start + buffer.length;
      } else {
        warnings.push("Transcript event exceeds the 8 MiB display safety limit.");
        buffer = Buffer.alloc(0);
      }
    }
    const decoder = new TextDecoder("utf-8");
    const text = decoder.decode(buffer, { stream: true });
    if (decoder.decode()) warnings.push("A UTF-8 character is still being written.");
    const events: unknown[] = [];
    const lines = options.channel === "stderr" ? [] : text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        warnings.push(
          index === lines.length - 1 && end === size
            ? "A live transcript event is still being written."
            : "Invalid transcript event skipped.",
        );
      }
    }
    return {
      blocks:
        options.channel === "stderr" && text
          ? [{ kind: "error", text }]
          : replayTranscriptEvents(events),
      revision: `${options.channel ?? "stdout"}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${start}:${end}`,
      start,
      end,
      size,
      hasPrevious: start > 0,
      hasNext: end < size,
      warnings: [...new Set(warnings)],
    };
  } finally {
    await handle.close();
  }
}
