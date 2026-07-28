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

export function parseTokenBudget(input: string): number | undefined {
  const match = input.match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  const value = Number.parseFloat(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === "k") return Math.round(value * 1000);
  if (suffix === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}

// --- Command parsing ---

export interface ParsedGoalArgs {
  objective?: string;
  budget?: number;
  error?: string;
}

/**
 * Parses `/goal:new` arguments: an objective, optionally preceded by a
 * `--tokens <amount>` budget flag. An empty objective means the handler should
 * prompt for one.
 */
export function parseNewGoalArgs(raw: string): ParsedGoalArgs {
  const tokens = tokenize(raw.trim());
  let tokenBudget: number | undefined;

  if (tokens[0] === "--tokens") {
    const rawBudget = tokens[1];
    if (!rawBudget) return { error: "Usage: /goal:new --tokens 100k <objective>" };
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === undefined) return { error: `Invalid token budget: ${rawBudget}` };
    tokenBudget = parsedBudget;
    tokens.splice(0, 2);
  }

  const objective = tokens.join(" ").trim();
  const result: ParsedGoalArgs = { objective };
  if (tokenBudget !== undefined) {
    result.budget = tokenBudget;
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
