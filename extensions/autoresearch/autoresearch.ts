/**
 * Autoresearch Extension
 *
 * Karpathy-style autonomous experiment loop, generalized to any measurable
 * target: try an idea, measure it against a baseline, keep improvements
 * (git commit), discard regressions (git revert), repeat. State lives in
 * `.pi/autoresearch/` (config, prompt, append-only log) so a fresh session
 * resumes from files alone; `.pi/autoresearch/` is excluded from git locally
 * so revert cycles can never destroy the experiment record.
 *
 * Continuation: while the loop is active the extension re-prompts the agent
 * after each turn, with runaway guards (iteration cap, stall detection).
 * Metrics alone don't justify keeps — confidence (best vs noise floor) is
 * reported after every run and the agent is told to re-measure when low.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import {
  AUTORESEARCH_STATE_EVENT,
  AUTORESEARCH_STATUS_KEY,
  buildSummary,
  formatSummary,
  statusText,
} from "./src/format.ts";
import {
  CHECKS_TIMEOUT_MS,
  changedFiles,
  commitExperiment,
  discardExperiment,
  isGitRepo,
  listUntracked,
  MEASURE_TIMEOUT_MS,
  parseMetric,
  runCommand,
} from "./src/measure.ts";
import { AUTORESEARCH_PARAMETERS } from "./src/schemas.ts";
import {
  appendLog,
  archiveLog,
  autoDir,
  excludeAutoFromGit,
  loadConfig,
  loadUntrackedSnapshot,
  nextRunNumber,
  readLog,
  saveConfig,
  savePrompt,
  saveUntrackedSnapshot,
} from "./src/store.ts";
import type { AutoConfig, RunEntry, RunStatus } from "./src/types.ts";

// --- Constants ---

const PENDING_FILE = "pending.json";

// --- Extension ---

export default async function autoresearchExtension(pi: ExtensionAPI) {
  /** In-memory pending measurement between `run` and `log`. */
  let pending:
    | { run: number; metric?: number; durationMs: number; description: string; hypothesis?: string }
    | undefined;
  // Autoresearch tool calls this session; engagement signal for the stall guard.
  let toolActivity = 0;
  let lastSeenActivity = 0;
  let continuationQueued = false;
  let idleWakes = 0;

  // --- Helpers ---

  async function requireActiveConfig(cwd: string): Promise<AutoConfig> {
    const config = await loadConfig(cwd);
    if (!config) {
      throw new Error(
        "No autoresearch session. Use action=init with objective, metric, direction, and measure command.",
      );
    }
    if (config.stopped) {
      throw new Error("This autoresearch session is stopped. Re-init to start a new one.");
    }
    return config;
  }

  /** Rehydrate a pending measurement left on disk by a reload or fresh instance. */
  async function loadPending(cwd: string): Promise<void> {
    if (pending) return;
    try {
      const raw = await readFile(join(autoDir(cwd), PENDING_FILE), "utf8");
      pending = JSON.parse(raw) as typeof pending;
    } catch {
      // No pending run.
    }
  }

  async function entriesAndPending(cwd: string): Promise<RunEntry[]> {
    const entries = await readLog(cwd);
    await loadPending(cwd);
    if (pending) {
      entries.push({
        run: pending.run,
        at: Date.now(),
        status: "discard", // provisional; replaced at log time
        description: `[pending] ${pending.description}`,
        ...(pending.hypothesis !== undefined ? { hypothesis: pending.hypothesis } : {}),
        ...(pending.metric !== undefined ? { metric: pending.metric } : {}),
        durationMs: pending.durationMs,
      });
    }
    return entries;
  }

  async function savePending(cwd: string): Promise<void> {
    if (pending) {
      await writeFile(join(autoDir(cwd), PENDING_FILE), JSON.stringify(pending), "utf8");
    }
  }

  async function clearPending(cwd: string): Promise<void> {
    pending = undefined;
    await unlink(join(autoDir(cwd), PENDING_FILE)).catch(() => {});
  }

  function publish(
    ctx: ExtensionContext,
    config: AutoConfig | undefined,
    entries: RunEntry[],
  ): void {
    const summary = config ? buildSummary(config, entries) : undefined;
    pi.events.emit(AUTORESEARCH_STATE_EVENT, {
      active: summary?.active ?? false,
      iterations: summary?.iterations ?? 0,
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus(AUTORESEARCH_STATUS_KEY, summary ? statusText(summary) : undefined);
    }
  }

  // --- Tool ---

  pi.registerTool({
    name: "autoresearch",
    label: "Autoresearch",
    description:
      "Autonomous experiment loop: init a measurable optimization (metric + measure command), then repeat — edit code, run (action=run), log keep-or-discard (action=log). Keeps are git commits, discards revert everything. Use for optimizing measurable targets: test speed, build time, bundle size, benchmark scores.",
    promptGuidelines: [
      "Use autoresearch when the user asks to optimize a measurable metric autonomously. Init needs a deterministic measure command emitting 'METRIC name=value'. After each result, propose the next hypothesis from what was learned before editing again.",
      "Never keep a result whose confidence is below 1x noise without re-measuring first; the tool reports confidence after every log.",
    ],
    parameters: AUTORESEARCH_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      toolActivity += 1;
      const cwd = ctx.cwd;
      const action = params.action;

      if (action === "init") {
        const objective = typeof params.objective === "string" ? params.objective.trim() : "";
        const metric = typeof params.metric === "string" ? params.metric.trim() : "";
        const direction =
          params.direction === "higher"
            ? "higher"
            : params.direction === "lower"
              ? "lower"
              : undefined;
        const measure = typeof params.measure === "string" ? params.measure.trim() : "";
        if (!objective) throw new Error("init requires objective.");
        if (!metric) throw new Error("init requires metric.");
        if (!direction) throw new Error("init requires direction (lower or higher).");
        if (!measure)
          throw new Error("init requires measure (shell command that prints the metric).");
        const existing = await loadConfig(cwd);
        if (existing && !existing.stopped) {
          throw new Error(
            "An active autoresearch session exists. Stop it (action=stop) before re-initializing.",
          );
        }
        if (!(await isGitRepo(cwd))) {
          throw new Error(
            "autoresearch requires a git repository (keeps are commits, discards are reverts).",
          );
        }
        // Clean-tree precondition, checked before any campaign state is written:
        // keeps stage worktree changes and discards restore tracked files from
        // HEAD, so pre-existing edits must be committed or stashed first.
        const dirty = await changedFiles(cwd);
        const blocking = [...dirty.tracked, ...dirty.untracked].filter(
          (path) => path !== ".pi/autoresearch" && !path.startsWith(".pi/autoresearch/"),
        );
        if (blocking.length > 0) {
          const shown = blocking.slice(0, 10).join("\n");
          const more = blocking.length > 10 ? `\n…and ${blocking.length - 10} more` : "";
          throw new Error(
            `autoresearch requires a clean worktree. Commit or stash these changes first:\n${shown}${more}`,
          );
        }
        if (existing?.stopped) {
          // A stop only deactivates the campaign; archive its log so the new
          // campaign starts with a clean baseline and run numbering.
          await archiveLog(cwd);
        }
        const config: AutoConfig = {
          objective,
          metric,
          ...(typeof params.unit === "string" && params.unit.trim()
            ? { unit: params.unit.trim() }
            : {}),
          direction,
          measure,
          ...(typeof params.checks === "string" && params.checks.trim()
            ? { checks: params.checks.trim() }
            : {}),
          ...(typeof params.maxIterations === "number" && params.maxIterations > 0
            ? { maxIterations: params.maxIterations }
            : {}),
          createdAt: Date.now(),
        };
        await saveConfig(cwd, config);
        await excludeAutoFromGit(cwd);
        await savePrompt(cwd, config, typeof params.notes === "string" ? params.notes : undefined);
        await clearPending(cwd);

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

      // Status works without an active campaign, and reports a stopped one
      // rather than being blocked by the active-session precondition.
      if (action === "status") {
        const config2 = await loadConfig(cwd);
        if (!config2) {
          return {
            content: [{ type: "text", text: "No autoresearch session in this project." }],
            details: { active: false },
          };
        }
        const entries = await entriesAndPending(cwd);
        publish(ctx, config2, entries);
        return {
          content: [{ type: "text", text: formatSummary(buildSummary(config2, entries), entries) }],
          details: { summary: buildSummary(config2, entries) },
        };
      }

      const config = await requireActiveConfig(cwd);

      if (action === "run") {
        const description = typeof params.description === "string" ? params.description.trim() : "";
        if (!description)
          throw new Error("run requires description (what this experiment changes).");
        await loadPending(cwd);
        if (pending)
          throw new Error("A run is already pending. Log it (action=log) before running again.");

        // Correctness gate first.
        if (config.checks) {
          const checks = await runCommand(config.checks, cwd, CHECKS_TIMEOUT_MS);
          if (!checks.ok) {
            await discardExperiment(cwd, await loadUntrackedSnapshot(cwd));
            await saveUntrackedSnapshot(cwd, await listUntracked(cwd));
            const entries = await readLog(cwd);
            const entry: RunEntry = {
              run: nextRunNumber(entries),
              at: Date.now(),
              status: "checks_failed",
              description,
              ...(typeof params.hypothesis === "string" ? { hypothesis: params.hypothesis } : {}),
              checksFailed: true,
            };
            await appendLog(cwd, entry);
            await clearPending(cwd);
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
        const runNumber = nextRunNumber(await readLog(cwd));
        pending = {
          run: runNumber,
          ...(metricValue !== undefined ? { metric: metricValue } : {}),
          durationMs: measured.durationMs,
          description,
          ...(typeof params.hypothesis === "string" ? { hypothesis: params.hypothesis } : {}),
        };
        await savePending(cwd);
        if (metricValue === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Measure command failed or produced no parseable metric.\nOutput (tail):\n${measured.output.slice(-1500)}\nFix the code or measure command, then run again.`,
              },
            ],
            details: { pending },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Run ${runNumber}: ${config.metric}=${metricValue} (${measured.durationMs}ms). Now log it: action=log with status=keep or discard.`,
            },
          ],
          details: { pending },
        };
      }

      if (action === "log") {
        await loadPending(cwd);
        if (!pending) throw new Error("Nothing to log. Run an experiment first (action=run).");
        const status =
          params.status === "keep" ? "keep" : params.status === "discard" ? "discard" : undefined;
        if (!status) throw new Error("log requires status (keep or discard).");
        const description =
          typeof params.description === "string" && params.description.trim()
            ? params.description.trim()
            : pending.description;

        let commit: string | undefined;
        if (status === "keep") {
          commit = await commitExperiment(
            cwd,
            `autoresearch: ${description} (${config.metric}=${pending.metric ?? "?"})`,
            await loadUntrackedSnapshot(cwd),
          );
        } else {
          await discardExperiment(cwd, await loadUntrackedSnapshot(cwd));
        }
        // Re-baseline the untracked set so the next experiment's keep/discard
        // scope starts from the state this log left behind.
        await saveUntrackedSnapshot(cwd, await listUntracked(cwd));

        const entries = await readLog(cwd);
        const entry: RunEntry = {
          run: pending.run,
          at: Date.now(),
          status: status as RunStatus,
          description,
          ...(pending.hypothesis !== undefined ? { hypothesis: pending.hypothesis } : {}),
          ...(pending.metric !== undefined ? { metric: pending.metric } : {}),
          durationMs: pending.durationMs,
          ...(commit !== undefined ? { commit } : {}),
        };
        await appendLog(cwd, entry);
        entries.push(entry);
        await clearPending(cwd);

        const summary = buildSummary(config, entries);
        let stopNote = "";
        if (config.maxIterations !== undefined && summary.iterations >= config.maxIterations) {
          config.stopped = true;
          await saveConfig(cwd, config);
          stopNote = ` Iteration cap (${config.maxIterations}) reached — the loop is now stopped.`;
          publish(ctx, config, entries);
        } else {
          publish(ctx, config, entries);
        }
        const confidenceNote =
          summary.confidence !== undefined && summary.confidence < 1
            ? " Confidence is within noise — re-run before trusting this result."
            : "";
        return {
          content: [
            {
              type: "text",
              text: `${status === "keep" ? `Kept (commit ${commit})` : "Discarded (reverted)"}. ${formatSummary(summary, entries)}.${confidenceNote}${stopNote}`,
            },
          ],
          details: { entry, summary, stopped: config.stopped === true },
        };
      }

      if (action === "stop") {
        await loadPending(cwd);
        if (pending) {
          // A pending run means uncommitted experiment changes; revert them.
          // Failures surface instead of being swallowed so state stays honest.
          await discardExperiment(cwd, await loadUntrackedSnapshot(cwd));
          await clearPending(cwd);
        }
        config.stopped = true;
        await saveConfig(cwd, config);
        const entries = await readLog(cwd);
        publish(ctx, config, entries);
        return {
          content: [
            {
              type: "text",
              text: "Autoresearch stopped. Config and log kept in .pi/autoresearch/.",
            },
          ],
          details: { active: false },
        };
      }

      throw new Error(`Unknown autoresearch action: ${String(action)}`);
    },
  });

  // --- Continuation loop ---

  pi.on("agent_end", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    if (!config || config.stopped) return;
    if (continuationQueued || ctx.hasPendingMessages()) return;

    const entries = await readLog(ctx.cwd);
    const iterations = entries.filter((e) => e.status === "keep" || e.status === "discard").length;
    if (config.maxIterations !== undefined && iterations >= config.maxIterations) {
      config.stopped = true;
      await saveConfig(ctx.cwd, config);
      publish(ctx, config, entries);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Autoresearch iteration cap (${config.maxIterations}) reached. Loop stopped.`,
          "info",
        );
      }
      return;
    }

    // Stall guard: two consecutive continuations with zero autoresearch tool
    // activity mean the loop is not actually running — stop and hand control
    // back. Log growth alone is the wrong signal: the agent legitimately
    // interleaves other work (mission tasks, user questions) between
    // experiments, and settle boundaries do not align with work boundaries.
    if (toolActivity !== lastSeenActivity) {
      lastSeenActivity = toolActivity;
      idleWakes = 0;
    } else {
      idleWakes += 1;
    }
    if (idleWakes >= 2) {
      config.stopped = true;
      await saveConfig(ctx.cwd, config);
      publish(ctx, config, entries);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Autoresearch stopped: no new experiments were logged after repeated prompts.",
          "warning",
        );
      }
      return;
    }

    continuationQueued = true;
    pi.sendUserMessage(
      "Continue the autoresearch loop. Re-read .pi/autoresearch/prompt.md and the tail of .pi/autoresearch/log.jsonl, then: pick the next hypothesis, edit the code, run the autoresearch tool (action=run), and log the result (action=log, keep or discard). If the cap is reached or you genuinely cannot improve further, call action=stop.",
      { deliverAs: "followUp" },
    );
  });

  pi.on("input", async (event) => {
    const source = (event as { source?: string }).source;
    if (source !== "interactive") {
      // Our own followUp was delivered — reset guards for the next cycle.
      continuationQueued = false;
    }
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Reload starts fresh guards but rebuilds state from disk so an experiment
    // that was pending before the reload can still be logged.
    continuationQueued = false;
    idleWakes = 0;
    toolActivity = 0;
    lastSeenActivity = 0;
    pending = undefined;
    const config = await loadConfig(ctx.cwd);
    const entries = await entriesAndPending(ctx.cwd);

    publish(ctx, config, entries);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Drop per-session state and tell listeners the loop is no longer running;
    // pending.json on disk keeps a mid-experiment reload resumable.
    pending = undefined;
    continuationQueued = false;
    idleWakes = 0;
    toolActivity = 0;
    lastSeenActivity = 0;
    pi.events.emit(AUTORESEARCH_STATE_EVENT, { active: false, iterations: 0 });
    if (ctx.hasUI) ctx.ui.setStatus(AUTORESEARCH_STATUS_KEY, undefined);
  });
}
