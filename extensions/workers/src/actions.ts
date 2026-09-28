/**
 * Workers tool action handlers: list, tail, status, cancel, collect, and
 * remove. Each action receives what it needs (cwd, live-worker map, publish
 * callback) explicitly from the composition root and returns the tool
 * response; they never touch Pi registration or per-instance state directly.
 */

import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { AgentToolResult } from "pi";
import {
  formatRawStreamEntries,
  formatStreamEntries,
  formatWorkerLine,
  formatWorkerStatus,
} from "./format.ts";
import { type RunningWorker, readSpoolLines } from "./runner.ts";
import { streamPath } from "./store.ts";
import type { WorkerRecord } from "./types.ts";
import { applyPatch, removeWorktree, worktreePath } from "./worktree.ts";

// --- Actions ---

/** Which workers the list action shows: this session's own, orphans left by
 *  ended sessions, or everything (including other live sessions' workers). */
export type WorkerListScope = "mine" | "orphans" | "all";

/** Formatted, scope-filtered worker listing. The caller classifies records
 *  (transcript cache vs janitor sweep); this only renders. */
export function listWorkers(options: {
  mine: WorkerRecord[];
  orphans: WorkerRecord[];
  foreignLive: WorkerRecord[];
  scope: WorkerListScope;
}): AgentToolResult {
  const { mine, orphans, foreignLive, scope } = options;
  const byStart = (a: WorkerRecord, b: WorkerRecord) => a.startedAt - b.startedAt;
  const sections: string[] = [];
  const count = mine.length + orphans.length + foreignLive.length;
  if (scope !== "orphans" && mine.length > 0) {
    sections.push(
      `This session (${mine.length}):` +
        "\n" +
        [...mine]
          .sort(byStart)
          .map((w) => formatWorkerLine(w))
          .join("\n"),
    );
  }
  if (scope !== "mine" && orphans.length > 0) {
    sections.push(
      `Orphans — owning session ended (${orphans.length}):` +
        "\n" +
        [...orphans]
          .sort(byStart)
          .map((w) => formatWorkerLine(w, "orphan"))
          .join("\n"),
    );
  }
  if (scope === "all" && foreignLive.length > 0) {
    sections.push(
      `Other live sessions (${foreignLive.length}):` +
        "\n" +
        [...foreignLive]
          .sort(byStart)
          .map((w) => formatWorkerLine(w, "other session"))
          .join("\n"),
    );
  }
  const hiddenForeign = scope === "orphans" ? foreignLive.length : 0;
  const text =
    sections.length > 0
      ? sections.join("\n\n") +
        (hiddenForeign > 0
          ? `\n(${hiddenForeign} worker(s) running in other live sessions, hidden)`
          : "")
      : scope === "orphans"
        ? "No orphaned worker artifacts." +
          (foreignLive.length > 0
            ? ` (${foreignLive.length} worker(s) running in other live sessions, hidden)`
            : "")
        : "No workers yet. Use the spawn_worker tool to hand a task to a cheap-model worker session.";
  return {
    content: [{ type: "text", text }],
    details: {
      count,
      mine: mine.length,
      orphans: orphans.length,
      foreignLive: foreignLive.length,
    },
  };
}

/** Last N spool stream entries for one worker (post-mortem tails included).
 *  Raw-format spools are read bounded (the child may have written a lot);
 *  legacy projected spools are small and read whole. */
export async function tailWorkerStream(
  cwd: string,
  id: string,
  requestedLines: number | undefined,
  record: WorkerRecord,
): Promise<AgentToolResult> {
  const lines =
    typeof requestedLines === "number" && requestedLines > 0 ? Math.floor(requestedLines) : 40;
  const all =
    record.streamFormat === "raw"
      ? formatRawStreamEntries(await readSpoolLines(cwd, id))
      : await (async () => {
          let raw = "";
          try {
            raw = await readFile(streamPath(cwd, id), "utf8");
          } catch {
            throw new Error(
              `No stream captured for worker ${id}. Streams exist for workers started after this feature landed.`,
            );
          }
          return formatStreamEntries(raw);
        })();
  const shown = all.slice(-lines);
  const text =
    shown.length > 0
      ? shown.join("\n") +
        (all.length > shown.length
          ? `\n… (older ${all.length - shown.length} entries omitted)`
          : "")
      : "Stream is empty.";
  return {
    content: [{ type: "text", text }],
    details: { entries: all.length, shown: shown.length },
  };
}

/** Full status/report read for one worker. */
export function workerStatusResponse(record: WorkerRecord): AgentToolResult {
  return {
    content: [{ type: "text", text: formatWorkerStatus(record) }],
    details: { worker: record },
  };
}

/**
 * Cancel a live worker owned by this session. Workers from other sessions or
 * earlier runs have no process here to signal and are refused.
 */
export async function cancelWorker(options: {
  running: Map<string, RunningWorker>;
  publish: () => Promise<void>;
  id: string;
  record: WorkerRecord;
}): Promise<AgentToolResult> {
  const { running, publish, id, record } = options;
  const runningWorker = running.get(id);
  if (!runningWorker) {
    throw new Error(
      record.status === "running"
        ? `Worker ${id} belongs to another session or an earlier run and cannot be cancelled here (pid ${record.pid ?? "?"}); it holds no slot in this session. Track it with workers action=list scope=all, or spawn_worker to start a new worker.`
        : `Worker ${id} is already ${record.status}; its slot is free. Use action=remove to delete the record and artifacts, or spawn_worker to start a new worker.`,
    );
  }
  await runningWorker.cancel();
  running.delete(id);
  await publish();
  // cancel() is a no-op on a non-running record; if the worker reached
  // a terminal state on its own first, say so instead of claiming the
  // cancel stopped it.
  const status = runningWorker.record.status;
  if (status !== "cancelled") {
    return {
      content: [
        {
          type: "text",
          text: `Worker ${record.name} is already ${status}; its slot is free. Use action=remove to delete the record and artifacts, or spawn_worker to start a new worker.`,
        },
      ],
      details: { worker: runningWorker.record },
    };
  }
  return {
    content: [{ type: "text", text: `Worker ${record.name} (${id}) cancelled.` }],
    details: { worker: runningWorker.record },
  };
}

/**
 * Apply an isolated worker's captured patch to the working tree and remove
 * its worktree/branch. The patch file itself survives collect. Works for
 * the session's own workers and for orphans; `persistCollected` records
 * `collectedAt` in the right place (transcript for own workers, artifact
 * record file for orphans).
 */
export async function collectWorkerPatch(
  cwd: string,
  id: string,
  record: WorkerRecord,
  params: { apply?: boolean; cleanup?: boolean },
  persistCollected: (record: WorkerRecord) => Promise<void>,
): Promise<AgentToolResult> {
  if (!record.patchPath) {
    throw new Error(
      `Worker ${id} has no patch (only isolated workers produce patches, after finishing).`,
    );
  }
  if (record.collectedAt !== undefined) {
    throw new Error(`Worker ${id}'s patch was already collected.`);
  }
  const shouldApply = params.apply !== false;
  const shouldCleanup = params.cleanup !== false;
  const lines: string[] = [];
  if (shouldApply) {
    // A read-only worker captures an empty patch; `git apply` rejects it
    // ("No valid patches in input"). Nothing to apply is success, decided
    // before any git invocation. An unreadable patch file falls through to
    // git apply so its error (and the kept patch path) surfaces as before.
    const patchText = await readFile(record.patchPath, "utf8").catch(() => null);
    if (patchText !== null && patchText.trim() === "") {
      lines.push(`No changes in worker ${record.name}'s patch; nothing to apply.`);
    } else {
      try {
        await applyPatch(cwd, record.patchPath);
        lines.push(`Applied patch ${record.patchPath} to the working tree.`);
      } catch (err) {
        throw new Error(
          `Patch apply failed: ${(err as Error).message}. The patch file is kept at ${record.patchPath}; resolve conflicts manually if needed.`,
        );
      }
    }
  } else {
    lines.push(`Patch left unapplied at ${record.patchPath}.`);
  }
  if (shouldCleanup && record.worktree) {
    // Never remove a worktree whose changes are not durably captured:
    // if the patch file is gone, removal would destroy the only copy.
    const patchMissing = await access(record.patchPath).then(
      () => false,
      () => true,
    );
    if (patchMissing) {
      throw new Error(
        `Patch file ${record.patchPath} is missing; keeping worktree ${record.worktree} so the worker's changes are not lost.`,
      );
    }
    await removeWorktree(cwd, id);
    // git worktree removal can fail without throwing here; never claim
    // success while the directory is still on disk.
    if (existsSync(worktreePath(cwd, id))) {
      lines.push(
        `Warning: worktree removal failed; remove it manually at ${worktreePath(cwd, id)}.`,
      );
    } else {
      lines.push("Worktree and branch removed.");
    }
  }
  // The stream spool outlives the collect: post-mortem tails stay
  // available for 24h after the worker finished (session_start prunes
  // them). Collect removes the worktree/branch, not the forensics.
  record.collectedAt = Date.now();
  await persistCollected(record);
  return { content: [{ type: "text", text: lines.join(" ") }], details: { worker: record } };
}

/** Drop a terminal worker's record and artifacts (record file, stream spool,
 *  patch) — the composition root calls removeWorkerRecord directly so it can
 *  also drop the record from its transcript cache. */
