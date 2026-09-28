/** Pending measurement between `run` and `log`: held in the instance state and
 *  mirrored to pending.json so a reload or fresh instance can still log (or
 *  must discard) a mid-experiment run. */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { autoDir, readLog } from "./store.ts";
import type { InstanceState, PendingMeasurement, RunEntry } from "./types.ts";

// --- Constants ---

const PENDING_FILE = "pending.json";

// --- Pending measurement ---

function isPendingMeasurement(value: unknown): value is PendingMeasurement {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingMeasurement>;
  return (
    Number.isSafeInteger(pending.run) &&
    (pending.run as number) > 0 &&
    typeof pending.description === "string" &&
    typeof pending.durationMs === "number" &&
    Number.isFinite(pending.durationMs) &&
    pending.durationMs >= 0 &&
    (pending.metric === undefined ||
      (typeof pending.metric === "number" && Number.isFinite(pending.metric))) &&
    (pending.hypothesis === undefined || typeof pending.hypothesis === "string")
  );
}

/** Rehydrate a pending measurement left on disk by a reload or fresh instance. */
export async function loadPending(state: InstanceState, cwd: string): Promise<void> {
  const path = join(autoDir(cwd), PENDING_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      // Absent on disk means no pending run anywhere: drop any stale
      // in-memory copy so this instance neither refuses `run` for a run
      // another instance already resolved nor logs it twice.
      state.pending = undefined;
      return;
    }
    throw new Error(`autoresearch pending state ${path} is unreadable: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `autoresearch pending state ${path} is corrupt (invalid JSON); repair it before continuing: ${String(error)}`,
    );
  }
  if (!isPendingMeasurement(parsed)) {
    throw new Error(
      `autoresearch pending state ${path} is corrupt (invalid measurement); repair it before continuing.`,
    );
  }
  state.pending = parsed;
}

export async function entriesAndPending(state: InstanceState, cwd: string): Promise<RunEntry[]> {
  const entries = await readLog(cwd);
  await loadPending(state, cwd);
  if (state.pending) {
    entries.push({
      run: state.pending.run,
      at: Date.now(),
      status: "discard", // provisional; replaced at log time
      description: `[pending] ${state.pending.description}`,
      ...(state.pending.hypothesis !== undefined ? { hypothesis: state.pending.hypothesis } : {}),
      ...(state.pending.metric !== undefined ? { metric: state.pending.metric } : {}),
      durationMs: state.pending.durationMs,
    });
  }
  return entries;
}

export async function savePending(state: InstanceState, cwd: string): Promise<void> {
  if (state.pending) {
    await writeJsonAtomic(join(autoDir(cwd), PENDING_FILE), state.pending);
  }
}

export async function clearPending(state: InstanceState, cwd: string): Promise<void> {
  state.pending = undefined;
  const path = join(autoDir(cwd), PENDING_FILE);
  await unlink(path).catch((error) => {
    // A pending file that is already gone needs no clearing. Anything else
    // (EISDIR, EACCES) must surface instead of claiming the state is clear.
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new Error(`autoresearch pending state ${path} could not be cleared: ${String(error)}`);
    }
  });
}
