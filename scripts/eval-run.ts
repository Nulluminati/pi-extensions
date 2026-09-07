/**
 * Noninteractive harness-eval CLI: run the built-in task suite from a shell
 * without a Pi session. Used by repo development (e.g. comparing worker
 * models) rather than by the agent.
 *
 * Usage:
 *   npx tsx scripts/eval-run.ts --task bugfix-regression --model provider/id
 *   npx tsx scripts/eval-run.ts --all --model provider/id --repeats 3
 *
 * Results are written to .pi/evals/results.jsonl in the current directory.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatResult, formatSummary, summarize } from "../extensions/harness-evals/src/format.ts";
import { runEvalTask } from "../extensions/harness-evals/src/runner.ts";
import { appendResult, readResults } from "../extensions/harness-evals/src/store.ts";
import { BUILT_IN_TASKS, findTask } from "../extensions/harness-evals/src/tasks.ts";

// --- Args ---

interface Args {
  all: boolean;
  taskId?: string;
  model?: string;
  repeats: number;
  timeoutMs?: number;
  extensions: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, repeats: 1, extensions: true, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") args.all = true;
    else if (arg === "--task") {
      const v = argv[++i];
      if (v !== undefined) args.taskId = v;
    } else if (arg === "--model") {
      const v = argv[++i];
      if (v !== undefined) args.model = v;
    } else if (arg === "--repeats")
      args.repeats = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10));
    else if (arg === "--timeout-ms") args.timeoutMs = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--no-extensions") args.extensions = false;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/eval-run.ts [--all | --task <id>] [--model provider/id] [--repeats N] [--timeout-ms N] [--no-extensions] [--keep]",
      );
      process.exit(0);
    }
  }
  return args;
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = args.all
    ? BUILT_IN_TASKS
    : (() => {
        if (!args.taskId) {
          console.error("Pass --all or --task <id>. Built-in tasks:");
          for (const t of BUILT_IN_TASKS) console.error(`  ${t.id}: ${t.title}`);
          process.exit(1);
        }
        const task = findTask(args.taskId);
        if (!task) {
          console.error(`Unknown task ${args.taskId}`);
          process.exit(1);
        }
        return [task];
      })();

  const extensionPaths = args.extensions ? SUITE_PATHS.map((url) => fileURLToPath(url)) : [];
  const cwd = process.cwd();

  console.log(
    `Running ${tasks.length} task(s) × ${args.repeats} repeat(s) with model ${args.model ?? "(pi default)"}; extensions ${extensionPaths.length === 0 ? "disabled" : "enabled"}\n`,
  );

  const results = [];
  for (let i = 0; i < args.repeats; i++) {
    for (const task of tasks) {
      process.stdout.write(`▶ ${task.id} (${i + 1}/${args.repeats})… `);
      const result = await runEvalTask(task, {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        extensionPaths,
        keepWorkspace: args.keep,
      });
      await appendResult(cwd, result);
      results.push(result);
      console.log(result.pass ? "PASS" : "FAIL");
      console.log(
        `  ${Math.round(result.durationMs / 1000)}s · ${result.inputTokens}in/${result.outputTokens}out tok`,
      );
      if (!result.pass) {
        console.log(formatResult(result));
      }
    }
  }

  console.log(`\n${formatSummary(summarize(results))}`);
  const stored = await readResults(cwd);
  console.log(
    `\nResults appended to ${join(cwd, ".pi/evals/results.jsonl")} (${stored.length} total runs)`,
  );
}

const SUITE_PATHS = [
  new URL("../extensions/missions/missions.ts", import.meta.url),
  new URL("../extensions/messenger/messenger.ts", import.meta.url),
  new URL("../extensions/agents/agents.ts", import.meta.url),
  new URL("../extensions/autoresearch/autoresearch.ts", import.meta.url),
];

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
