/** Campaign initialization (action=init): worktree safety checks, config
 *  creation, baseline measurement, and the untracked snapshot that scopes
 *  later keeps and discards. */

import type { AgentToolResult, ExtensionContext } from "pi";
import { isProjectStatePath } from "../../../lib/paths.ts";
import { buildSummary, formatSummary } from "./format.ts";
import {
  changedFiles,
  isGitRepo,
  listUntracked,
  MEASURE_TIMEOUT_MS,
  parseMetric,
  runCommand,
} from "./measure.ts";
import { clearPending, loadPending } from "./pending.ts";
import {
  appendLog,
  archiveLog,
  excludeAutoFromGit,
  loadConfig,
  nextRunNumber,
  readLog,
  saveConfig,
  savePrompt,
  saveUntrackedSnapshot,
} from "./store.ts";
import type {
  AutoConfig,
  AutoresearchParams,
  InstanceState,
  PublishFn,
  RunEntry,
} from "./types.ts";

// --- Init action ---

export async function initAction(
  state: InstanceState,
  params: AutoresearchParams,
  ctx: ExtensionContext,
  publish: PublishFn,
): Promise<AgentToolResult> {
  const cwd = ctx.cwd;
  const objective = typeof params.objective === "string" ? params.objective.trim() : "";
  const metric = typeof params.metric === "string" ? params.metric.trim() : "";
  const direction =
    params.direction === "higher" ? "higher" : params.direction === "lower" ? "lower" : undefined;
  const measure = typeof params.measure === "string" ? params.measure.trim() : "";
  if (!objective) throw new Error("init requires objective.");
  if (!metric) throw new Error("init requires metric.");
  if (!direction) throw new Error("init requires direction (lower or higher).");
  if (!measure) throw new Error("init requires measure (shell command that prints the metric).");
  // Worktree safety first: the clean-tree precondition protects user
  // data from keep/discard, so it must win over config-state errors
  // (a corrupt config still refuses init — just with the tree error
  // when both are wrong).
  if (!(await isGitRepo(cwd))) {
    throw new Error(
      "autoresearch requires a git repository (keeps are commits, discards are reverts).",
    );
  }
  const dirty = await changedFiles(cwd);
  // Tracked changes always block: keeps stage worktree changes and
  // discards restore tracked files from HEAD, so any pre-existing
  // tracked edit — even under the config dir — could be committed or
  // wiped by the loop. Only untracked extension-state files (missions,
  // messenger, …) are exempt; they are never staged or restored.
  const blocking = [
    ...dirty.tracked,
    ...dirty.untracked.filter((path) => !isProjectStatePath(path)),
  ];
  if (blocking.length > 0) {
    const shown = blocking.slice(0, 10).join("\n");
    const more = blocking.length > 10 ? `\n…and ${blocking.length - 10} more` : "";
    throw new Error(
      `autoresearch requires a clean worktree. Commit or stash these changes first:\n${shown}${more}`,
    );
  }
  // Campaign-state checks come after worktree safety: an active session
  // refuses re-init, a corrupt config fails visibly (never silently
  // overwritten), and a stopped session archives its log.
  const existing = await loadConfig(cwd);
  if (existing && !existing.stopped) {
    throw new Error(
      "An active autoresearch session exists. Stop it (action=stop) before re-initializing.",
    );
  }
  // Re-init must not erase an unreadable or corrupt pending experiment.
  await loadPending(state, cwd);
  if (existing?.stopped) {
    // A stop only deactivates the campaign; archive its log so the new
    // campaign starts with a clean baseline and run numbering.
    await archiveLog(cwd);
  }
  const config: AutoConfig = {
    objective,
    metric,
    ...(typeof params.unit === "string" && params.unit.trim() ? { unit: params.unit.trim() } : {}),
    direction,
    measure,
    ...(typeof params.checks === "string" && params.checks.trim()
      ? { checks: params.checks.trim() }
      : {}),
    ...(typeof params.maxIterations === "number" && params.maxIterations > 0
      ? { maxIterations: params.maxIterations }
      : {}),
    // Only this session's agent_end continues the loop; other sessions
    // in the project see the state (widget, fallback status) but are
    // never hijacked into driving someone else's experiment.
    ...(ctx.sessionManager.getSessionId()
      ? { ownerSessionId: ctx.sessionManager.getSessionId() }
      : {}),
    createdAt: Date.now(),
    // Defensive record of tracked files already dirty when the
    // campaign started (normally empty: the precondition above refuses
    // to start on tracked changes). Keeps never stage these files and
    // discards never restore them.
    ...(dirty.tracked.length > 0 ? { dirtyAtInit: dirty.tracked } : {}),
  };
  await saveConfig(cwd, config);
  await excludeAutoFromGit(cwd);
  await savePrompt(cwd, config, typeof params.notes === "string" ? params.notes : undefined);
  await clearPending(state, cwd);

  // Baseline measurement of the current state.
  const measured = await runCommand(measure, cwd, MEASURE_TIMEOUT_MS);
  // Parse the full retained output: a measure command may print the
  // metric and still exit non-zero (or overflow a buffer).
  const metricValue = parseMetric(measured.metricOutput, metric);
  const entries = await readLog(cwd);
  const baselineEntry: RunEntry = {
    run: nextRunNumber(entries),
    at: Date.now(),
    status: metricValue === undefined ? "invalid" : "baseline",
    description: "baseline (state at init)",
    ...(metricValue !== undefined ? { metric: metricValue } : {}),
    durationMs: measured.durationMs,
  };
  await appendLog(cwd, baselineEntry);
  entries.push(baselineEntry);
  // Baseline the untracked file set so discards can scope themselves to
  // experiment-created files instead of wiping all untracked work.
  await saveUntrackedSnapshot(cwd, await listUntracked(cwd));

  publish(ctx, config, entries);

  return {
    content: [
      {
        type: "text",
        text: `Autoresearch initialized. Baseline: ${baselineEntry.metric ?? "unparseable — check the measure command output"}. ${formatSummary(buildSummary(config, entries), entries)}`,
      },
    ],
    details: { config, baseline: baselineEntry },
  };
}
