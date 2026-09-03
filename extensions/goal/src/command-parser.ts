import { GOAL_MAX_LENGTH } from "./constants.ts";

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote) current += char;
      else quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parses an `--iterations` value: a non-negative integer cap on automatic
 * continuations. 0 means unlimited.
 */
export function parseIterationCap(input: string): number | undefined {
  if (!/^\d+$/.test(input)) return undefined;
  return Number.parseInt(input, 10);
}

// --- Command parsing ---

export interface ParsedGoalArgs {
  objective?: string;
  iterations?: number;
  error?: string;
}

/**
 * Parses `/goal:new` arguments: an objective, optionally preceded by an
 * `--iterations <count>` cap flag. An empty objective means the handler should
 * prompt for one.
 */
export function parseNewGoalArgs(raw: string): ParsedGoalArgs {
  const tokens = tokenize(raw.trim());
  let iterationCap: number | undefined;

  if (tokens[0] === "--iterations") {
    const rawCap = tokens[1];
    if (!rawCap) return { error: "Usage: /goal:new --iterations <count> <objective>" };
    const parsedCap = parseIterationCap(rawCap);
    if (parsedCap === undefined) return { error: `Invalid iteration cap: ${rawCap}` };
    iterationCap = parsedCap;
    tokens.splice(0, 2);
  }

  const objective = tokens.join(" ").trim();
  const result: ParsedGoalArgs = { objective };
  if (iterationCap !== undefined) {
    result.iterations = iterationCap;
  }
  return result;
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return "Usage: /goal:new <objective>";
  if (trimmed.length > GOAL_MAX_LENGTH) {
    return `Goal objective is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Put long instructions in a file and reference it from /goal:new instead.`;
  }
  return undefined;
}
