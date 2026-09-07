/** Persisted eval results: `<cwd>/.pi/evals/results.jsonl`, newest last. */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalResult } from "./types.ts";

// --- Paths ---

export function evalsDir(cwd: string): string {
  return join(cwd, ".pi", "evals");
}

export function resultsPath(cwd: string): string {
  return join(evalsDir(cwd), "results.jsonl");
}

// --- Results ---

export async function appendResult(cwd: string, result: EvalResult): Promise<void> {
  await mkdir(evalsDir(cwd), { recursive: true });
  await appendFile(resultsPath(cwd), `${JSON.stringify(result)}\n`, "utf8");
}

export async function readResults(cwd: string): Promise<EvalResult[]> {
  let raw: string;
  try {
    raw = await readFile(resultsPath(cwd), "utf8");
  } catch {
    return [];
  }
  const results: EvalResult[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as EvalResult);
    } catch {
      // Skip malformed lines.
    }
  }
  return results;
}
