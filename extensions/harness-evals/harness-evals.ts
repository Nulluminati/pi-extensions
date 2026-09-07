/**
 * Harness Evals Extension
 *
 * Measures whether Pi (and this extension suite) actually completes coding
 * tasks: a suite of reproducible tasks, each run noninteractively in a fresh
 * workspace and graded by deterministic shell checks. Results persist to
 * `.pi/evals/results.jsonl` so harness changes can be compared over time —
 * the evaluation loop that keeps harness work honest.
 *
 * Use from the session via the `evals` tool or /evals:run; use
 * scripts/eval-run.ts for noninteractive suite runs.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { EVALS_STATE_EVENT, formatResult, formatSummary, summarize } from "./src/format.ts";
import { runEvalTask } from "./src/runner.ts";
import { EVALS_PARAMETERS } from "./src/schemas.ts";
import { appendResult, readResults } from "./src/store.ts";
import { BUILT_IN_TASKS, findTask } from "./src/tasks.ts";

// --- Constants ---

const SUITE_EXTENSION_PATHS = [
  new URL("../missions/missions.ts", import.meta.url),
  new URL("../messenger/messenger.ts", import.meta.url),
  new URL("../agents/agents.ts", import.meta.url),
  new URL("../autoresearch/autoresearch.ts", import.meta.url),
];

function suiteExtensionPaths(): string[] {
  if (process.env.PI_EVAL_EXTENSIONS === "0") return [];
  return SUITE_EXTENSION_PATHS.map((url) => fileURLToPath(url));
}

function evalModel(): string | undefined {
  return process.env.PI_EVAL_MODEL?.trim() || undefined;
}

// --- Extension ---

export default async function harnessEvalsExtension(pi: ExtensionAPI) {
  // --- Tools ---

  pi.registerTool({
    name: "evals",
    label: "Harness Evals",
    description:
      "Run the built-in harness evaluation suite: reproducible coding tasks executed by noninteractive Pi sessions and graded by shell checks. Use to measure whether harness or model changes actually improve task completion. Running the suite takes several minutes per task.",
    promptGuidelines: [
      "Use evals (action=run) when the user asks to evaluate, benchmark, or compare agent/harness configurations, and action=report to summarize stored results.",
    ],
    parameters: EVALS_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === "list") {
        return {
          content: [
            {
              type: "text",
              text: BUILT_IN_TASKS.map((t) => `${t.id}: ${t.title} — probes ${t.probes}`).join(
                "\n",
              ),
            },
          ],
          details: { count: BUILT_IN_TASKS.length },
        };
      }

      if (action === "report") {
        const results = await readResults(ctx.cwd);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No eval results stored yet. Run some tasks first." }],
            details: { runs: 0 },
          };
        }
        const summary = summarize(results);
        return {
          content: [{ type: "text", text: formatSummary(summary) }],
          details: { summary },
        };
      }

      if (action === "run") {
        const repeats =
          typeof params.repeats === "number" && params.repeats > 0 ? Math.floor(params.repeats) : 1;
        const tasks =
          params.all === true
            ? BUILT_IN_TASKS
            : (() => {
                const id = typeof params.taskId === "string" ? params.taskId.trim() : "";
                const task = findTask(id);
                if (!task) {
                  throw new Error(
                    `Unknown task "${id}". Use action=list to see built-in tasks, or pass all=true.`,
                  );
                }
                return [task];
              })();
        const model =
          typeof params.model === "string" && params.model.trim()
            ? params.model.trim()
            : evalModel();
        const extensionPaths = suiteExtensionPaths();

        const results = [];
        for (let i = 0; i < repeats; i++) {
          for (const task of tasks) {
            const result = await runEvalTask(task, { model, extensionPaths });
            await appendResult(ctx.cwd, result);
            results.push(result);
            if (ctx.hasUI) {
              ctx.ui.notify(
                `eval ${task.id} (${i + 1}/${repeats}): ${result.pass ? "PASS" : "FAIL"}`,
                result.pass ? "info" : "warning",
              );
            }
          }
        }
        const summary = summarize(results);
        return {
          content: [
            {
              type: "text",
              text: `${formatSummary(summary)}\n\n${results.map(formatResult).join("\n\n")}`,
            },
          ],
          details: { summary, results },
        };
      }

      throw new Error(`Unknown evals action: ${String(action)}`);
    },
  });

  // --- Commands ---

  pi.registerCommand("evals", {
    description: "List the built-in harness evaluation tasks",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(BUILT_IN_TASKS.map((t) => `${t.id}: ${t.title}`).join("\n"), "info");
    },
  });

  pi.registerCommand("evals:run", {
    description: "Run the full harness eval suite (takes many minutes)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const taskId = args.trim();
      // Delegate to the tool through a user message so the run happens in a
      // turn context and the model can narrate progress.
      pi.sendUserMessage(
        taskId
          ? `Run the evals tool with action=run, taskId=${taskId} and report the results.`
          : "Run the evals tool with action=run, all=true and report the results.",
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("evals:report", {
    description: "Summarize stored harness eval results",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const results = await readResults(ctx.cwd);
      if (results.length === 0) {
        ctx.ui.notify("No eval results stored yet.", "info");
        return;
      }
      ctx.ui.notify(formatSummary(summarize(results)), "info");
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    const results = await readResults(ctx.cwd);
    pi.events.emit(EVALS_STATE_EVENT, { storedResults: results.length });
  });
}
