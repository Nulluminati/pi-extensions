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
      quote = char;
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

function parseTokenBudget(input: string): number | undefined {
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
  subcommand: "status" | "start" | "edit" | "pause" | "resume" | "clear" | "budget";
  objective?: string;
  budget?: number;
  error?: string;
}

export function parseGoalArgs(raw: string): ParsedGoalArgs {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return { subcommand: "status" };

  const [first, ...rest] = tokens;
  if (first === "pause")
    return rest.length === 0
      ? { subcommand: "pause" }
      : { subcommand: "status", error: "Usage: /goal pause" };
  if (first === "resume")
    return rest.length === 0
      ? { subcommand: "resume" }
      : { subcommand: "status", error: "Usage: /goal resume" };
  if (first === "clear")
    return rest.length === 0
      ? { subcommand: "clear" }
      : { subcommand: "status", error: "Usage: /goal clear" };
  if (first === "budget") {
    const rawBudget = rest[0];
    if (!rawBudget || rest.length > 1)
      return { subcommand: "status", error: "Usage: /goal budget <amount>" };
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === undefined)
      return { subcommand: "status", error: `Invalid token budget: ${rawBudget}` };
    return { subcommand: "budget", budget: parsedBudget };
  }
  if (first === "edit") {
    const objective = rest.join(" ").trim();
    return objective
      ? { subcommand: "edit", objective }
      : { subcommand: "status", error: "Usage: /goal edit <objective>" };
  }

  return parseObjectiveStart(tokens);
}

function parseObjectiveStart(tokens: string[]): ParsedGoalArgs {
  let tokenBudget: number | undefined;
  const objectiveTokens = [...tokens];

  if (objectiveTokens[0] === "--tokens") {
    const rawBudget = objectiveTokens[1];
    if (!rawBudget)
      return { subcommand: "status", error: "Usage: /goal --tokens 100k <objective>" };
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === undefined)
      return { subcommand: "status", error: `Invalid token budget: ${rawBudget}` };
    tokenBudget = parsedBudget;
    objectiveTokens.splice(0, 2);
  }

  const objective = objectiveTokens.join(" ").trim();
  if (!objective) return { subcommand: "status", error: "Usage: /goal <objective>" };
  const result: ParsedGoalArgs = { subcommand: "start", objective };
  if (tokenBudget !== undefined) {
    result.budget = tokenBudget;
  }
  return result;
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return "Usage: /goal <objective>";
  if (trimmed.length > GOAL_MAX_LENGTH) {
    return `Goal objective is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
  }
  return undefined;
}
