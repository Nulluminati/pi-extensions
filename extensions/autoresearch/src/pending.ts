/** Pending measurement between `run` and `log`: held in the instance state and
 *  mirrored to pending.json so a reload or fresh instance can still log (or
 *  must discard) a mid-experiment run. */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autoDir, readLog } from "./store.ts";
import type { InstanceState, RunEntry } from "./types.ts";

// --- Constants ---

const PENDING_FILE = "pending.json";

// --- Pending measurement ---

/** Rehydrate a pending measurement left on disk by a reload or fresh instance. */
export async function loadPending(state: InstanceState, cwd: string): Promise<void> {
  if (state.pending) return;
  try {
    const raw = await readFile(join(autoDir(cwd), PENDING_FILE), "utf8");
    state.pending = JSON.parse(raw) as typeof state.pending;
  } catch {
    // No pending run.
  }
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
    await writeFile(join(autoDir(cwd), PENDING_FILE), JSON.stringify(state.pending), "utf8");
  }
}

export async function clearPending(state: InstanceState, cwd: string): Promise<void> {
  state.pending = undefined;
  await unlink(join(autoDir(cwd), PENDING_FILE)).catch(() => {});
}
