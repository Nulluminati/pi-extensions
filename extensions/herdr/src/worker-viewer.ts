/** Standalone terminal viewer. No worker lifecycle code runs from this entrypoint. */

import { stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isArrowDown, isArrowLeft, isArrowRight, isArrowUp } from "../../../lib/arrow-keys.ts";
import { isNodeError } from "../../../lib/errors.ts";
import { assertWorkerId } from "../../workers/src/ids.ts";
import type { TranscriptBlock } from "./transcript-events.ts";
import {
  cleanTranscriptText,
  createTranscriptViewport,
  renderTranscriptBlocks,
} from "./transcript-view.ts";
import { renderWorkersFrame, workersPageSize } from "./worker-cards.ts";
import {
  readTranscriptPage,
  type TranscriptPage,
  type TranscriptPageOptions,
} from "./worker-transcript.ts";
import {
  readWorkerRecord,
  readWorkerReferences,
  readWorkerSnapshot,
  readWorkerView,
  readWorkspaceWorkersView,
} from "./worker-view.ts";

interface ViewerOutput {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(text: string): unknown;
}

interface ViewerInput {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  off(event: "data", listener: (data: Buffer | string) => void): unknown;
}

export async function runWorkersViewer(
  cwd: string,
  list: string,
  signal: AbortSignal,
  output: ViewerOutput = process.stdout,
  input: ViewerInput = process.stdin,
): Promise<void> {
  let page = 0;
  await runViewer(
    async (height, width) => {
      const ids = await readWorkerReferences(cwd, list);
      const pageSize = output.isTTY
        ? workersPageSize(height)
        : Math.min(8, Math.max(1, Math.floor((height - 2) / 10)));
      page = Math.max(0, Math.min(page, Math.ceil(ids.length / pageSize) - 1));
      const start = page * pageSize;
      const shown = ids.slice(start, start + pageSize);
      if (output.isTTY) {
        const workers = await Promise.all(shown.map((ref) => readWorkerSnapshot(ref.cwd, ref.id)));
        return renderWorkersFrame(workers, ids.length, page, width, height);
      }
      const range = shown.length > 0 ? ` (${start + 1}-${start + shown.length})` : "";
      return [
        `Workers: ${ids.length}${range}`,
        "Read-only | Up/Down: pages | q: close monitor",
        ...(shown.length > 0 ? await readWorkspaceWorkersView(shown) : ["No monitored workers."]),
      ];
    },
    signal,
    output,
    {
      input,
      onKey: (data) => {
        if (isArrowDown(data) || isArrowRight(data) || data === "\u001b[6~") page++;
        else if (isArrowUp(data) || isArrowLeft(data) || data === "\u001b[5~")
          page = Math.max(0, page - 1);
      },
    },
  );
}

export async function runWorkerViewer(
  cwd: string,
  id: string,
  signal: AbortSignal,
  output: ViewerOutput = process.stdout,
): Promise<void> {
  assertWorkerId(id);
  await runViewer(() => readWorkerView(cwd, id), signal, output);
}

export async function runWorkerTranscriptViewer(
  cwd: string,
  id: string,
  signal: AbortSignal,
  output: ViewerOutput = process.stdout,
  input: ViewerInput = process.stdin,
  list?: string,
): Promise<void> {
  assertWorkerId(id);
  const closed = new AbortController();
  const viewport = createTranscriptViewport();
  let page: TranscriptPage | undefined;
  let channel: "stdout" | "stderr" = "stdout";
  let action: "first" | "last" | "previous" | "next" | undefined;
  let bodyHeight = 1;
  let documentKey = "";
  const text = (value: unknown, fallback = "") =>
    cleanTranscriptText(typeof value === "string" ? value : fallback);
  await runViewer(
    async (height, width) => {
      if (list) {
        try {
          await stat(list);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            closed.abort();
            return [];
          }
          throw error;
        }
        const refs = await readWorkerReferences(cwd, list);
        if (!refs.some((ref) => ref.cwd === cwd && ref.id === id)) {
          page = undefined;
          documentKey = "";
          return ["No active worker registration", "Read-only | q: close view"];
        }
      }
      const move = action;
      action = undefined;
      const options: TranscriptPageOptions = { channel };
      if (move === "first") options.after = 0;
      else if (move === "previous" && page) options.before = page.start;
      else if (move === "next" && page) options.after = page.end;
      else if (move !== "last" && page && !viewport.following) options.after = page.start;
      const [next, record] = await Promise.all([
        readTranscriptPage(cwd, id, options),
        readWorkerRecord(cwd, id, 8 * 1024 * 1024),
      ]);
      const blocks: TranscriptBlock[] = [...next.blocks];
      if (channel === "stdout") {
        if (
          !next.hasPrevious &&
          typeof record?.task === "string" &&
          !blocks.some((block) => block.kind === "user")
        )
          blocks.unshift({ kind: "user", text: record.task });
        if (next.blocks.length === 0 && typeof record?.outputText === "string" && record.outputText)
          blocks.push({ kind: "assistant", text: record.outputText });
        if (
          typeof record?.error === "string" &&
          record.error &&
          !blocks.some((block) => block.text === record.error)
        )
          blocks.push({ kind: "error", text: record.error });
      }
      if (!blocks.length)
        blocks.push({
          kind: "info",
          text: channel === "stderr" ? "No recorded stderr." : "No captured messages yet.",
        });
      if (!record)
        blocks.push({
          kind: "info",
          text: "Worker record unavailable: missing, invalid, or larger than the 8 MiB safety limit.",
        });
      for (const warning of next.warnings) blocks.push({ kind: "info", text: warning });
      const key = JSON.stringify([
        channel,
        next.revision,
        record?.task,
        record?.outputText,
        record?.error,
      ]);
      if (key !== documentKey) {
        viewport.setBlocks(blocks);
        documentKey = key;
      }
      page = next;
      bodyHeight = Math.max(1, height - 3);
      viewport.render(width, bodyHeight);
      if (move === "first" || move === "next") viewport.scrollToStart();
      else if (move === "previous") viewport.pauseAtEnd();
      else if (move === "last") viewport.scrollToEnd();
      if (next.hasNext && viewport.following) viewport.pauseAtEnd();
      const body = output.isTTY
        ? viewport.render(width, bodyHeight)
        : renderTranscriptBlocks(blocks, width);
      const status = text(record?.status, "unavailable");
      const model = text(record?.model);
      const position = viewport.following && !next.hasNext ? "LIVE" : "HISTORY";
      const hint = `q close view · ↑/↓ scroll · PgUp/PgDn history · Home first · End live · e ${channel === "stdout" ? "stderr" : "transcript"}`;
      const lines = [
        `Worker ${text(record?.name, id)} · ${id}`,
        `Status: ${status}${model ? ` · ${model}` : ""} · ${channel} · ${position}${next.hasPrevious ? " · older history available" : ""}`,
        ...body,
        hint,
      ];
      return output.isTTY && height <= 3
        ? [...body.slice(0, Math.max(0, height - 1)), hint]
        : lines;
    },
    AbortSignal.any([signal, closed.signal]),
    output,
    {
      input,
      onKey(data) {
        if (data === "e") {
          channel = channel === "stdout" ? "stderr" : "stdout";
          action = "last";
          page = undefined;
        } else if (["\u001b[H", "\u001b[1~", "\u001bOH"].includes(data)) action = "first";
        else if (["\u001b[F", "\u001b[4~", "\u001bOF"].includes(data)) action = "last";
        else if (isArrowUp(data) || data === "\u001b[5~") {
          if (viewport.scrollBy(data === "\u001b[5~" ? -bodyHeight : -1) < 0 && page?.hasPrevious)
            action = "previous";
        } else if (isArrowDown(data) || data === "\u001b[6~") {
          if (viewport.scrollBy(data === "\u001b[6~" ? bodyHeight : 1) > 0 && page?.hasNext)
            action = "next";
        }
      },
    },
  );
}

async function runViewer(
  readFrame: (height: number, width: number) => Promise<string[]>,
  externalSignal: AbortSignal,
  output: ViewerOutput,
  controls?: { input: ViewerInput; onKey(data: string): void },
): Promise<void> {
  if (externalSignal.aborted) return;
  const quit = new AbortController();
  const signal = AbortSignal.any([externalSignal, quit.signal]);
  const terminal = output.isTTY;
  const input = controls?.input.isTTY ? controls.input : undefined;
  const wasRaw = input?.isRaw ?? false;
  const wasPaused = input?.isPaused() ?? false;
  let wake: AbortController | undefined;
  const onInput = (chunk: Buffer | string) => {
    const data = chunk.toString();
    if (data === "q" || data === "\u0003") quit.abort();
    else controls?.onKey(data);
    wake?.abort();
  };
  if (terminal) output.write("\u001b[?1049h\u001b[?25l");
  try {
    if (input) {
      input.setRawMode(true);
      input.on("data", onInput);
      input.resume();
    }
    while (!signal.aborted) {
      wake = new AbortController();
      const height = Math.max(1, (output.rows || 24) - 1);
      const width = terminal ? Math.max(1, (output.columns || 80) - 1) : 240;
      let lines: string[];
      try {
        lines = await readFrame(height, width);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines = ["Monitor read failed", message.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 240)];
      }
      if (signal.aborted) break;
      const viewportHeight = terminal ? height : lines.length;
      const visible =
        lines.length > viewportHeight && viewportHeight > 2
          ? [...lines.slice(0, 2), ...lines.slice(-(viewportHeight - 2))]
          : lines.slice(0, viewportHeight);
      const frame = visible.map((line) => truncateToWidth(line, width)).join("\n");
      output.write(`${terminal ? "\u001b[H\u001b[2J" : ""}${frame}\n`);
      try {
        await setTimeout(1_000, undefined, { signal: AbortSignal.any([signal, wake.signal]) });
      } catch (error) {
        if (!signal.aborted && !wake.signal.aborted) throw error;
      }
    }
  } finally {
    if (input) {
      input.off("data", onInput);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    }
    if (terminal) output.write("\u001b[?25h\u001b[?1049l");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cwd, id, list, discovery] = process.argv.slice(2);
  if (!cwd || !id || ((id === "--workers" || id === "--transcript") && !list))
    throw new Error(
      "Usage: worker-viewer.ts <project path> <worker id | --workers list path | --transcript worker id [list path]>",
    );
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  try {
    if (id === "--workers" && list) await runWorkersViewer(cwd, list, controller.signal);
    else if (id === "--transcript" && list)
      await runWorkerTranscriptViewer(
        cwd,
        list,
        controller.signal,
        process.stdout,
        process.stdin,
        discovery,
      );
    else await runWorkerViewer(cwd, id, controller.signal);
  } finally {
    // The standalone transcript process owns stdin and must release its terminal handle.
    if (id === "--transcript") process.stdin.pause();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
  }
}
