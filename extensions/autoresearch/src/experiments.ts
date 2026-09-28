/** Experiment cycle (action=run, action=log): correctness checks, measurement,
 *  the pending hand-off between the two, and keep (git commit) or discard
 *  (git revert) of the current experiment. */

import type { AgentToolResult, ExtensionContext } from "pi";
import { buildSummary, formatSummary } from "./format.ts";
import {
  CHECKS_TIMEOUT_MS,
  commitExperiment,
  discardExperiment,
  listUntracked,
  MEASURE_TIMEOUT_MS,
  parseMetric,
  runCommand,
} from "./measure.ts";
import { clearPending, loadPending, savePending } from "./pending.ts";
import {
  appendLog,
  loadUntrackedSnapshot,
  nextRunNumber,
  readLog,
  saveUntrackedSnapshot,
  stopConfig,
} from "./store.ts";
import type {
  AutoConfig,
  AutoresearchParams,
  InstanceState,
  PublishFn,
  RunEntry,
} from "./types.ts";

// --- Run action ---

export async function runAction(
  state: InstanceState,
  config: AutoConfig,
  params: AutoresearchParams,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<AgentToolResult> {
  const cwd = ctx.cwd;
  const description = typeof params.description === "string" ? params.description.trim() : "";
  if (!description) throw new Error("run requires description (what this experiment changes).");
  await loadPending(state, cwd);
  if (state.pending)
    throw new Error("A run is already pending. Log it (action=log) before running again.");
  // Validate the history before checks or a measurement can change the tree.
  const entries = await readLog(cwd);

  // Correctness gate first.
  if (config.checks) {
    const checks = await runCommand(config.checks, cwd, CHECKS_TIMEOUT_MS);
    if (!checks.ok) {
      await discardExperiment(cwd, await loadUntrackedSnapshot(cwd), config.dirtyAtInit);
      await saveUntrackedSnapshot(cwd, await listUntracked(cwd));
      const entry: RunEntry = {
        run: nextRunNumber(entries),
        at: Date.now(),
        status: "checks_failed",
        description,
        ...(typeof params.hypothesis === "string" ? { hypothesis: params.hypothesis } : {}),
        checksFailed: true,
      };
      await appendLog(cwd, entry);
      await clearPending(state, cwd);
      publish(ctx, config, [...entries, entry]);
      return {
        content: [
          {
            type: "text",
            text: `CHECKS FAILED — changes were reverted automatically. Output:\n${checks.output.slice(-2000)}`,
          },
        ],
        details: { entry },
      };
    }
  }

  const measured = await runCommand(config.measure, cwd, MEASURE_TIMEOUT_MS);
  const metricValue = parseMetric(measured.metricOutput, config.metric);
  const runNumber = nextRunNumber(entries);
  state.pending = {
    run: runNumber,
    ...(metricValue !== undefined ? { metric: metricValue } : {}),
    durationMs: measured.durationMs,
    description,
    ...(typeof params.hypothesis === "string" ? { hypothesis: params.hypothesis } : {}),
  };
  await savePending(state, cwd);
  if (metricValue === undefined) {
    return {
      content: [
        {
          type: "text",
          text: `Measure command failed or produced no parseable metric.\nOutput (tail):\n${measured.output.slice(-1500)}\nLog this run first: action=log with status=discard (discard reverts the working-tree changes). Then fix the code or measure command and run again.`,
        },
      ],
      details: { pending: state.pending },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Run ${runNumber}: ${config.metric}=${metricValue} (${measured.durationMs}ms). Now log it: action=log with status=keep or discard.`,
      },
    ],
    details: { pending: state.pending },
  };
}

// --- Log action ---

export async function logAction(
  state: InstanceState,
  config: AutoConfig,
  params: AutoresearchParams,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<AgentToolResult> {
  const cwd = ctx.cwd;
  await loadPending(state, cwd);
  if (!state.pending) throw new Error("Nothing to log. Run an experiment first (action=run).");
  const status =
    params.status === "keep" ? "keep" : params.status === "discard" ? "discard" : undefined;
  if (!status) throw new Error("log requires status (keep or discard).");
  const entries = await readLog(cwd);
  const description =
    typeof params.description === "string" && params.description.trim()
      ? params.description.trim()
      : state.pending.description;

  let commit: string | undefined;
  if (status === "keep") {
    commit = await commitExperiment(
      cwd,
      `autoresearch: ${description} (${config.metric}=${state.pending.metric ?? "?"})`,
      await loadUntrackedSnapshot(cwd),
      config.dirtyAtInit,
    );
  } else {
    await discardExperiment(cwd, await loadUntrackedSnapshot(cwd), config.dirtyAtInit);
  }
  // Re-baseline the untracked set so the next experiment's keep/discard
  // scope starts from the state this log left behind.
  await saveUntrackedSnapshot(cwd, await listUntracked(cwd));

  const entry: RunEntry = {
    run: state.pending.run,
    at: Date.now(),
    status,
    description,
    ...(state.pending.hypothesis !== undefined ? { hypothesis: state.pending.hypothesis } : {}),
    ...(state.pending.metric !== undefined ? { metric: state.pending.metric } : {}),
    durationMs: state.pending.durationMs,
    ...(commit !== undefined ? { commit } : {}),
  };
  await appendLog(cwd, entry);
  entries.push(entry);
  await clearPending(state, cwd);

  const summary = buildSummary(config, entries);
  let stopNote = "";
  let stoppedNow = false;
  if (config.maxIterations !== undefined && summary.iterations >= config.maxIterations) {
    const stopped = (await stopConfig(cwd)) ?? { ...config, stopped: true };
    stoppedNow = stopped.stopped === true;
    stopNote = ` Iteration cap (${config.maxIterations}) reached — the loop is now stopped.`;
    publish(ctx, stopped, entries);
  } else {
    publish(ctx, config, entries);
  }
  const spreadNote =
    summary.spread !== undefined && summary.spread < 1
      ? " Spread is below 1x MAD — re-measure before trusting this result."
      : "";
  return {
    content: [
      {
        type: "text",
        text: `${status === "keep" ? `Kept (commit ${commit})` : "Discarded (reverted)"}. ${formatSummary(summary, entries)}.${spreadNote}${stopNote}`,
      },
    ],
    details: { entry, summary, stopped: stoppedNow },
  };
}
