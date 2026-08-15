/**
 * Pure formatting helpers for job output and job lines.
 */

import type { Job } from "./types.ts";

export const MAX_TAIL_CHARS = 6_000; // hard cap on anything sent back to the model
export const MAX_BUFFER_CHARS = 200_000; // rolling in-memory buffer per job
export const DEFAULT_TAIL_LINES = 40;
export const MAX_RETAINED_JOBS = 50; // prune oldest terminal jobs above this count

/** Hard cap: marker length is computed first so total never exceeds max. */
export function truncate(text: string, max = MAX_TAIL_CHARS): string {
  if (text.length <= max) return text;
  const marker = `\n…[truncated, showing last ${max} of ${text.length} chars]`;
  const budget = max - marker.length;
  return `${text.slice(Math.max(0, text.length - budget))}${marker}`;
}

export function tailLines(text: string, lines = DEFAULT_TAIL_LINES): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return `…[+ ${all.length - lines} earlier lines]\n${all.slice(-lines).join("\n")}`;
}

/** Derive a short filesystem-safe label from the command's first token. */
export function slugify(command: string): string {
  const first = command.replace(/\s+/g, " ").trim().split(" ")[0] ?? "job";
  const base = first.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 24);
  return base || "job";
}

export function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function elapseMs(job: Job): number {
  return (job.endedAt ?? Date.now()) - job.startedAt;
}

export function formatJobLine(job: Job): string {
  const mark =
    job.status === "running" || job.status === "cancelling"
      ? "●"
      : job.status === "completed" || job.status === "satisfied"
        ? "✓"
        : job.status === "failed" || job.status === "timeout" || job.status === "kill_failed"
          ? "✗"
          : "⊘";
  const exit = job.exitCode != null ? ` exit ${job.exitCode}` : "";
  return `#${job.id} ${mark} [${job.status}${exit}] ${job.kind} "${job.label}" (${fmtDuration(elapseMs(job))})`;
}

/** Append to a job's rolling buffer, keeping it bounded. */
export function appendBuffer(job: Job, chunk: string): void {
  job.buffer += chunk;
  if (job.buffer.length > MAX_BUFFER_CHARS) {
    job.buffer = job.buffer.slice(job.buffer.length - MAX_BUFFER_CHARS);
  }
}
