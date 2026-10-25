// --- Constants ---

export const BASH_ALLOW_REQUEST_EVENT = "bash-allow:request";

// --- Types ---

/** Synchronous snapshot request shared by the parent gate and worker launcher. */
export interface BashAllowRequest {
  reply(value: string | undefined): void;
}

export interface AllowRule {
  pattern: string;
  tokens: string[];
  allowMore: boolean;
}

interface ScannedCommand {
  segments: string[];
  words: string[][];
  refusal?: string;
}

// --- Helpers ---

// Shell blanks are not JavaScript whitespace: a non-breaking space or carriage
// return can be part of an executable name, and must not become a token boundary.
function trimShellBlanks(value: string): string {
  return value.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

function scanCommand(command: string): ScannedCommand {
  const segments: string[] = [];
  const words: string[][] = [];
  let quote = "";
  let start = 0;
  let token = "";
  let inToken = false;
  let tokens: string[] = [];
  const refuse = (refusal: string): ScannedCommand => ({ segments: [], words: [], refusal });
  const finishToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const finishSegment = (end: number) => {
    finishToken();
    if (tokens.length > 0) {
      segments.push(trimShellBlanks(command.slice(start, end)));
      words.push(tokens);
    }
    tokens = [];
  };

  if (command.includes("\0")) return refuse("This command uses a NUL character.");
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    const next = command[i + 1];
    if (quote === "'") {
      if (char === "'") quote = "";
      else token += char;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) return refuse("This command ends with an incomplete escape (\\).");
      // Inside double quotes, backslash only escapes these shell characters.
      if (
        !quote ||
        next === "$" ||
        next === "`" ||
        next === '"' ||
        next === "\\" ||
        next === "\n"
      ) {
        if (next !== "\n") {
          token += next;
          inToken = true;
        }
        i++;
      } else token += char;
      continue;
    }
    if (char === "$" || char === "`") {
      return refuse(
        `This command uses shell expansion or command substitution (${char}). Use literal arguments.`,
      );
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    // Comments can hide quotes from the shell but not from this scanner.
    // Refuse them instead of letting the two parsers disagree about a newline.
    if (char === "#" && !inToken) {
      return refuse("This command uses a shell comment (#). Run commands without comments.");
    }
    if (char === "*" || char === "?" || char === "[") {
      return refuse(
        `This command uses an unquoted glob (${char}). Quote or escape literal arguments.`,
      );
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      return refuse(`This command uses a shell group (${char}). Run one command per call.`);
    }
    if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      return refuse(
        `This command uses shell redirection (${char === "&" ? "&>" : char}). Use a command without redirection.`,
      );
    }
    if (char === "&" && next !== "&") {
      return refuse("This command uses background execution (&). Run one command per call.");
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      finishSegment(i);
      if ((char === "&" || char === "|") && next === char) i++;
      start = i + 1;
      continue;
    }
    if (char === " " || char === "\t") finishToken();
    else {
      token += char;
      inToken = true;
    }
  }
  if (quote) return refuse(`This command has an unclosed quote (${quote}).`);
  finishSegment(command.length);
  return { segments, words };
}

// --- Public helpers ---

export function parseAllowList(value: string): { rules: AllowRule[]; error?: string } {
  const entries: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') quote = char;
    else if (char === ",") {
      entries.push(value.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(value.slice(start));
  const rules: AllowRule[] = [];
  const fail = (error: string) => ({ rules: [], error });
  if (quote) return fail("The allow list has an unclosed quote.");
  for (const entry of entries) {
    let pattern = trimShellBlanks(entry);
    if (pattern.startsWith("Bash(")) {
      if (!pattern.endsWith(")")) return fail(`Invalid Bash(...) wrapper: ${pattern}`);
      pattern = trimShellBlanks(pattern.slice(5, -1));
    }
    if (!pattern) return fail("The allow list contains an empty rule.");
    const star = pattern.indexOf("*");
    if (star >= 0 && star !== pattern.length - 1) {
      return fail(`Only a trailing * is supported: ${pattern}`);
    }
    const allowMore = star >= 0;
    const prefix = allowMore ? pattern.slice(0, -1).replace(/:$/, "") : pattern;
    const scanned = scanCommand(prefix);
    const tokens = scanned.words[0];
    if (scanned.refusal || scanned.segments.length !== 1 || !tokens?.length || !tokens[0]) {
      return fail(
        `Invalid allow rule ${pattern}: ${scanned.refusal ?? "expected one nonempty command prefix"}`,
      );
    }
    rules.push({ pattern, tokens, allowMore });
  }
  return { rules };
}

export function splitCommand(command: string): { segments: string[]; refusal?: string } {
  const { segments, refusal } = scanCommand(command);
  return refusal ? { segments, refusal } : { segments };
}

export function checkCommand(
  command: string,
  rules: AllowRule[],
): { allowed: true } | { allowed: false; reason: string } {
  const scanned = scanCommand(command);
  if (scanned.refusal) return { allowed: false, reason: scanned.refusal };
  if (scanned.segments.length === 0) return { allowed: false, reason: "Command is empty." };
  for (let i = 0; i < scanned.segments.length; i++) {
    const tokens = scanned.words[i] ?? [];
    const matches = rules.some(
      (rule) =>
        (rule.allowMore
          ? tokens.length >= rule.tokens.length
          : tokens.length === rule.tokens.length) &&
        rule.tokens.every((token, index) => token === tokens[index]),
    );
    if (!matches)
      return {
        allowed: false,
        reason: `bash-allow blocks this command: ${scanned.segments[i]}. Allowed: ${rules.map((rule) => rule.pattern).join(", ")}.`,
      };
  }
  return { allowed: true };
}
