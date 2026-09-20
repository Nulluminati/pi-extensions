/**
 * Plan mode enforcement: which tools are allowed and which bash commands are
 * safe to run while planning. Pure functions, unit-tested in isolation.
 */

import { PLAN_ALLOWED_TOOLS, PLAN_SUBMIT_TOOL, PLAN_WORKER_ALLOWED_TOOLS } from "./constants.ts";

/**
 * The active tool set while in plan mode: the intersection of the session's
 * tools with the plan allowlist (default-deny — unknown tools are excluded),
 * plus plan_submit so the model can propose a plan. Built-in bash stays
 * active but is gated by the read-only command allowlist.
 */
export function buildPlanModeTools(activeToolNames: string[]): string[] {
  const kept = activeToolNames.filter((name) => PLAN_ALLOWED_TOOLS.has(name));
  return [...new Set([...kept, PLAN_SUBMIT_TOOL])];
}

/** Default-deny active tool set for headless workers spawned during planning. */
export function buildWorkerReadonlyTools(activeToolNames: string[]): string[] {
  return activeToolNames.filter((name) => PLAN_WORKER_ALLOWED_TOOLS.has(name));
}

// Commands that write or change state; any occurrence blocks the command.
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bchattr\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[;&|]\s*)install\b/i, // coreutils install only as a command, not in paths
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bmkswap\b/i,
  /(^|[^<])>(?!>|&)/, // single > redirect; 2>&1 fd redirects and >> are safe/separate
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bdnf\s+(install|remove|update|upgrade|autoremove)/i,
  /\bpacman\s+-[SRU]/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bsnap\s+(install|remove|refresh)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|clean|restore|switch|fetch|gc|prune|init|clone|stash\s+(?!list)|cherry-pick|revert|tag|branch\s+-[dD]|update-index|update-ref)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /\btar\s+\S*[xXcC]\S*/, // tar with extract/create flags writes files
  /\b(unzip|unrar|unar)\b/i,
  /\bsed\b[^|;]*-i\b/i, // sed -i edits in place
  /\bsed\b[^|;]*[\s'\d,;$](w|e)\s/, // sed w/e script commands write files or run commands
  /\bsed\b[^|;]*\/[g\d]*[we](?:\s|['"]|$)/i, // sed s///w and s///e flags
  /\bperl\s+[^|;]*-i\b/i,
  /\b(bash|sh|zsh|fish)\s+-c\b/i,
  /\benv\s+\S/, // env with arguments runs a command
  /\bfind\b[^|;]*\s(-exec|-execdir|-ok|-okdir|-delete|-fprint|-fprint0|-fprintf|-fls)\b/,
  /\bfd\b[^|;]*\s(--exec(-batch)?|-x)\b/,
  /\brg\b[^|;]*\s--pre(\s|$)/,
  /\bsort\b[^|;]*\s(-o|--output)\b/,
  /\btree\b[^|;]*\s-o\b/,
  /\bdate\b[^|;]*\s(-s|--set)\b/,
  /\bgit\b[^|;]*\s--output\b/,
  /\bjournalctl\b[^|;]*\s--(vacuum|rotate|flush)\b/,
  /\bcurl\b/i, // can write files (-o) or pipe to a shell
  /\bwget\b/i,
  /\|\s*(ba|z|fi)?sh\b/, // pipe to a shell
];

// --- Shell word tokenizer ---

/**
 * Split one pipeline stage into argv, respecting single quotes, double
 * quotes, and backslash escapes. Returns undefined when the stage cannot be
 * parsed cleanly (unterminated quote, trailing backslash) so callers fail
 * closed instead of guessing at word boundaries.
 */
function tokenizeStage(segment: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  while (i < segment.length) {
    const char = segment[i];
    if (char === undefined) return undefined;
    if (char === "'") {
      hasToken = true;
      const end = segment.indexOf("'", i + 1);
      if (end === -1) return undefined;
      current += segment.slice(i + 1, end);
      i = end + 1;
    } else if (char === '"') {
      hasToken = true;
      i += 1;
      let closed = false;
      while (i < segment.length) {
        const c = segment[i];
        if (c === "\\" && (segment[i + 1] === '"' || segment[i + 1] === "\\")) {
          current += segment[i + 1];
          i += 2;
        } else if (c === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          current += c;
          i += 1;
        }
      }
      if (!closed) return undefined;
    } else if (char === "\\") {
      const escaped = segment[i + 1];
      if (escaped === undefined) return undefined;
      hasToken = true;
      current += escaped;
      i += 2;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      i += 1;
    } else {
      hasToken = true;
      current += char;
      i += 1;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// --- Per-command argument specs ---

/**
 * How a command's arguments are validated. `validate` overrides the generic
 * flag walk for commands needing subcommand or script-body logic (git, npm
 * and friends, sed, env, version printers).
 */
interface StageSpec {
  /** Valueless flags allowed. "any" permits every flag token; a set permits
   *  exactly its members. `--flag=value` tokens are checked by flag name. */
  flags: "any" | ReadonlySet<string>;
  /** Flags that consume exactly one following token. */
  valueFlags?: ReadonlySet<string>;
  /** Flags that consume the next token only when it is not itself a flag
   *  (optional git values such as `--list [pattern]`). */
  optionalValueFlags?: ReadonlySet<string>;
  /** Flags rejected even under flags="any". Entries ending in `*` match by
   *  prefix (e.g. `--vacuum*`). */
  denyFlags?: ReadonlySet<string>;
  /** Whether non-flag tokens (file names, patterns, refs) are allowed. */
  positionals: "none" | "any";
  /** Custom validator receiving the full argv; replaces the flag walk. */
  validate?: (argv: string[]) => boolean;
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq > 1 ? token.slice(0, eq) : token;
}

function isDenied(denyFlags: ReadonlySet<string> | undefined, token: string): boolean {
  if (!denyFlags) return false;
  const bare = flagName(token);
  for (const denied of denyFlags) {
    if (denied.endsWith("*")) {
      if (bare.startsWith(denied.slice(0, -1))) return true;
    } else if (denied === bare) {
      return true;
    }
  }
  return false;
}

/** Generic flag walk: validates flags against the spec and collects
 *  positionals. `tokens` excludes the command name. `--` ends flag
 *  processing; everything after is positional. Returns undefined when any
 *  flag is denied or unknown for the spec. */
function walkFlags(
  tokens: string[],
  spec: Pick<StageSpec, "flags" | "valueFlags" | "optionalValueFlags" | "denyFlags">,
): string[] | undefined {
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) return undefined;
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (isDenied(spec.denyFlags, token)) return undefined;
      const bare = flagName(token);
      if (spec.valueFlags?.has(bare)) {
        if (token.includes("=")) continue;
        if (i + 1 >= tokens.length) return undefined;
        i += 1;
        continue;
      }
      if (spec.optionalValueFlags?.has(bare)) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("-") && !token.includes("=")) i += 1;
        continue;
      }
      if (spec.flags === "any") continue;
      if (spec.flags.has(bare)) continue;
      return undefined;
    }
    positionals.push(token);
  }
  return positionals;
}

// Flags every git subcommand may use; --output (writing a file) is denied.
const GIT_GENERIC: StageSpec = {
  flags: "any",
  denyFlags: new Set(["--output"]),
  positionals: "any",
};

// `git branch` lists with flags only: a bare positional either lists a
// matching branch or CREATES one when the name is new, and the two cases
// cannot be told apart statically, so positionals are denied outright.
const GIT_BRANCH: StageSpec = {
  flags: new Set([
    "-a",
    "-r",
    "-v",
    "-vv",
    "-i",
    "--all",
    "--remotes",
    "--show-current",
    "--show-ref",
    "--color",
  ]),
  optionalValueFlags: new Set([
    "--list",
    "--contains",
    "--with",
    "--points-at",
    "--sort",
    "--format",
    "--abbrev",
  ]),
  positionals: "none",
};

/** git: subcommand must be a known read-only one, then per-subcommand rules
 *  apply. Global flags before the subcommand (`git -C x status`) stay denied
 *  so the subcommand is always argv[1]. */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "rev-parse",
  "rev-list",
  "describe",
  "name-rev",
  "ls-files",
  "ls-tree",
  "ls-remote",
]);

function validateGitRemote(rest: string[]): boolean {
  if (rest.length === 0) return true;
  if (rest.every((token) => token === "-v" || token === "--verbose")) return true;
  if (rest[0] !== "get-url") return false;
  let names = 0;
  for (const token of rest.slice(1)) {
    if (token === "--") return false;
    if (token.startsWith("-")) {
      if (token !== "--push" && token !== "--all" && token !== "--both") return false;
      continue;
    }
    names += 1;
  }
  return names === 1;
}

function validateGitConfig(rest: string[]): boolean {
  const valueless = new Set([
    "--global",
    "--local",
    "--system",
    "--get",
    "--get-all",
    "--get-regexp",
  ]);
  let sawGet = false;
  let keys = 0;
  for (const token of rest) {
    if (token === "--") return false;
    if (token.startsWith("-")) {
      if (!valueless.has(token)) return false;
      if (token.startsWith("--get")) sawGet = true;
      continue;
    }
    keys += 1;
  }
  // Exactly one positional key: `config <key> <value>` writes a value.
  return sawGet && keys === 1;
}

function validateGit(argv: string[]): boolean {
  const sub = argv[1];
  if (sub === undefined || sub.startsWith("-")) return false;
  const rest = argv.slice(2);
  switch (sub) {
    case "branch": {
      const positionals = walkFlags(rest, GIT_BRANCH);
      return positionals !== undefined && positionals.length === 0;
    }
    case "remote":
      return validateGitRemote(rest);
    case "config":
      return validateGitConfig(rest);
    case "stash":
      return rest.length === 1 && rest[0] === "list";
    default:
      return GIT_READONLY_SUBCOMMANDS.has(sub) && walkFlags(rest, GIT_GENERIC) !== undefined;
  }
}

// --- Package managers ---

const NPM_READONLY_SUBCOMMANDS = new Set([
  "list",
  "ls",
  "view",
  "info",
  "search",
  "outdated",
  "audit",
]);
const YARN_READONLY_SUBCOMMANDS = new Set(["list", "info", "why", "audit"]);
const PM_READONLY_FLAGS = new Set([
  "--depth",
  "--json",
  "--long",
  "--parseable",
  "--all",
  "--global",
  "-g",
  "--omit",
  "--dry-run",
  "--registry",
]);
const PM_DENIED_FLAGS = new Set(["--fix", "--force", "-f"]);

function validatePackageManager(argv: string[], subcommands: ReadonlySet<string>): boolean {
  const sub = argv[1];
  if (sub === undefined || sub.startsWith("-") || !subcommands.has(sub)) return false;
  for (const token of argv.slice(2)) {
    if (token === "--") return false;
    if (token.startsWith("-") && token.length > 1) {
      const bare = flagName(token);
      if (PM_DENIED_FLAGS.has(bare) || !PM_READONLY_FLAGS.has(bare)) return false;
    }
    // Positional package specs are read-only for these subcommands.
  }
  return true;
}

// --- sed ---

/** Consume one sed address (line number with optional ~step, `$`, or /regex/)
 *  plus an optional `,second` half. Returns the index after the address, or
 *  the original index when there is none. */
function skipSedAddress(script: string, i: number): number {
  const parseSingle = (index: number): number => {
    const c = script[index];
    if (c === undefined) return index;
    if (c === "$") return index + 1;
    if (/[0-9]/.test(c)) {
      let j = index;
      while (j < script.length && /[0-9]/.test(script[j] ?? "")) j += 1;
      if (script[j] === "~" && /[0-9]/.test(script[j + 1] ?? "")) {
        j += 1;
        while (j < script.length && /[0-9]/.test(script[j] ?? "")) j += 1;
      }
      return j;
    }
    if (c === "/") {
      let j = index + 1;
      while (j < script.length && script[j] !== "/") {
        if (script[j] === "\\") j += 1;
        j += 1;
      }
      if (script[j] !== "/") return index;
      return j + 1;
    }
    return index;
  };
  let next = parseSingle(i);
  if (next === i) return i;
  i = next;
  if (script[i] === ",") {
    next = parseSingle(i + 1);
    if (next !== i + 1) i = next;
  }
  return i;
}

/** Validate one sed script body: only address + {p P d D n N = q Q} commands
 *  and s/y substitutions with safe flags are permitted. Anything that can
 *  write a file (w W), read one into the stream unexamined (r), run a
 *  command (e), branch, or open a block is denied. */
function isSafeSedScript(script: string): boolean {
  let i = 0;
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i] ?? "")) i += 1;
    if (i >= script.length) return true;
    i = skipSedAddress(script, i);
    if (script[i] === "!") i += 1;
    if (i >= script.length) return false;
    const cmd = script[i];
    if (cmd === undefined) return false;
    if ("pPdDnN=qQ".includes(cmd)) {
      i += 1;
      continue;
    }
    if (cmd === "s" || cmd === "y") {
      const delim = script[i + 1];
      if (delim === undefined || /[a-zA-Z0-9\s\\]/.test(delim)) return false;
      let delimiters = 0;
      i += 2;
      while (i < script.length && delimiters < 3) {
        const c = script[i];
        if (c === undefined) return false;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === delim) delimiters += 1;
        i += 1;
      }
      if (delimiters < 3) return false;
      if (cmd === "s") {
        while (i < script.length && !/[\s;\n]/.test(script[i] ?? "")) {
          if (!/[0-9gpimM]/.test(script[i] ?? "")) return false;
          i += 1;
        }
      }
      continue;
    }
    return false;
  }
  return true;
}

const SED_VALUELESS_FLAGS = new Set(["-n", "--quiet", "--silent"]);

function validateSed(argv: string[]): boolean {
  const scripts: string[] = [];
  const positionals: string[] = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) return false;
    if (token === "--") return false;
    if (token.startsWith("-") && token.length > 1) {
      if (token === "-e" || token === "--expression") {
        i += 1;
        const script = rest[i];
        if (script === undefined) return false;
        scripts.push(script);
        continue;
      }
      if (SED_VALUELESS_FLAGS.has(token)) continue;
      return false;
    }
    positionals.push(token);
  }
  // Without -e, the first positional is the script body; the rest are files.
  if (scripts.length === 0) {
    const script = positionals[0];
    return script !== undefined && isSafeSedScript(script);
  }
  return scripts.every(isSafeSedScript);
}

// --- env and version printers ---

const ENV_VALUELESS_FLAGS = new Set(["-i", "-0"]);

function validateEnv(argv: string[]): boolean {
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) return false;
    if (token === "--") return false;
    if (token.startsWith("-") && token.length > 1) {
      if (token === "-u" || token === "--unset") {
        if (i + 1 >= rest.length) return false;
        i += 1;
        continue;
      }
      if (!ENV_VALUELESS_FLAGS.has(token)) return false;
      continue;
    }
    // Any positional would name a command to execute.
    return false;
  }
  return true;
}

function validateVersionCommand(argv: string[], expectedArg: string): boolean {
  return argv.length === 2 && argv[1] === expectedArg;
}

// --- Spec table ---

const PERMISSIVE: StageSpec = { flags: "any", positionals: "any" };

function permissiveWithDenials(denyFlags: string[]): StageSpec {
  return { ...PERMISSIVE, denyFlags: new Set(denyFlags) };
}

/** Read-only commands allowed in plan mode, keyed by exact command name
 *  (no paths). Commands needing subcommand or script-body logic carry a
 *  custom validator; the rest use the generic flag walk. */
const COMMAND_SPECS: ReadonlyMap<string, StageSpec> = new Map([
  ["cat", PERMISSIVE],
  ["head", PERMISSIVE],
  ["tail", PERMISSIVE],
  ["less", PERMISSIVE],
  ["more", PERMISSIVE],
  ["grep", PERMISSIVE],
  ["ls", PERMISSIVE],
  ["pwd", PERMISSIVE],
  ["echo", PERMISSIVE],
  ["printf", PERMISSIVE],
  ["wc", PERMISSIVE],
  ["uniq", PERMISSIVE],
  ["diff", PERMISSIVE],
  ["file", PERMISSIVE],
  ["stat", PERMISSIVE],
  ["du", PERMISSIVE],
  ["df", PERMISSIVE],
  ["which", PERMISSIVE],
  ["whereis", PERMISSIVE],
  ["type", PERMISSIVE],
  ["printenv", PERMISSIVE],
  ["uname", PERMISSIVE],
  ["whoami", PERMISSIVE],
  ["id", PERMISSIVE],
  ["cal", PERMISSIVE],
  ["uptime", PERMISSIVE],
  ["ps", PERMISSIVE],
  ["top", PERMISSIVE],
  ["htop", PERMISSIVE],
  ["free", PERMISSIVE],
  ["ss", PERMISSIVE],
  ["netstat", PERMISSIVE],
  ["lsof", PERMISSIVE],
  ["jq", PERMISSIVE],
  ["bat", PERMISSIVE],
  ["eza", PERMISSIVE],
  [
    "find",
    permissiveWithDenials([
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-delete",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
    ]),
  ],
  ["fd", permissiveWithDenials(["-x", "--exec", "-X", "--exec-batch"])],
  ["rg", permissiveWithDenials(["--pre"])],
  ["sort", permissiveWithDenials(["-o", "--output"])],
  ["tree", permissiveWithDenials(["-o"])],
  ["date", permissiveWithDenials(["-s", "--set"])],
  [
    "journalctl",
    permissiveWithDenials([
      "--rotate",
      "--flush",
      "--vacuum*",
      "--mark",
      "--sync",
      "--relinquish*",
    ]),
  ],
  ["git", { ...PERMISSIVE, validate: validateGit }],
  [
    "npm",
    { ...PERMISSIVE, validate: (argv) => validatePackageManager(argv, NPM_READONLY_SUBCOMMANDS) },
  ],
  [
    "yarn",
    { ...PERMISSIVE, validate: (argv) => validatePackageManager(argv, YARN_READONLY_SUBCOMMANDS) },
  ],
  [
    "pnpm",
    { ...PERMISSIVE, validate: (argv) => validatePackageManager(argv, NPM_READONLY_SUBCOMMANDS) },
  ],
  ["sed", { ...PERMISSIVE, validate: validateSed }],
  ["env", { ...PERMISSIVE, validate: validateEnv }],
  ["node", { ...PERMISSIVE, validate: (argv) => validateVersionCommand(argv, "--version") }],
  ["python", { ...PERMISSIVE, validate: (argv) => validateVersionCommand(argv, "--version") }],
]);

// Shell keywords and metacharacters that compose or execute other commands.
// Any occurrence in the command rejects it outright. `2>&1` (stderr to
// stdout) is the only accepted metacharacter form; it is stripped before the
// separator and redirection checks below.
const SHELL_SUBSTITUTION = /\$\(|`/; // command substitution: $(...) or `...`
const SHELL_PROCESS_SUBSTITUTION = /<\(|>\(/; // process substitution: <(...) or >(...)
const SHELL_CONTROL = /[;&\n\r]/; // separators and backgrounding
const SHELL_REDIRECTION = /[<>]/; // input/output redirection

/**
 * True when a bash command is read-only enough to run in plan mode.
 *
 * This is deliberately conservative rather than a full shell parser: command
 * and process substitution, compound commands, backgrounding, and redirection
 * are rejected outright, and every stage of a pipeline must be an allowlisted
 * read-only command whose arguments pass an argument-level spec — each stage
 * is tokenized and its flags and positionals validated against per-command
 * rules, with unknown commands, unknown flags, and unexpected positionals
 * denied. That closes interpreter and argument-injection channels such as
 * `echo "$(node -e ...)"`, `cat <(python -c ...)`, `cat file | node -e ...`,
 * and mutating argument forms like `git branch <name>` or `npm audit --fix`
 * while keeping ordinary read-only pipelines (`ps aux | grep node`,
 * `git status 2>&1 | head -5`).
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  if (SHELL_SUBSTITUTION.test(trimmed)) return false;
  if (SHELL_PROCESS_SUBSTITUTION.test(trimmed)) return false;

  // `2>&1` is the sole allowed redirection form, so remove it before checking
  // for shell control operators and redirection.
  const pipeline = trimmed.replaceAll("2>&1", " ");
  if (SHELL_CONTROL.test(pipeline)) return false;
  if (SHELL_REDIRECTION.test(pipeline)) return false;

  // Every stage must be an allowlisted read-only command with validated
  // arguments: `cat file | node` fails on the second stage. Empty stages come
  // from `||`, `|&`, or a leading/trailing pipe.
  return pipeline.split("|").every((stage) => {
    const segment = stage.trim();
    if (segment.length === 0) return false;
    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment))) return false;
    const argv = tokenizeStage(segment);
    if (argv === undefined || argv.length === 0) return false;
    const command = argv[0];
    if (command === undefined) return false;
    const spec = COMMAND_SPECS.get(command);
    if (!spec) return false;
    if (spec.validate) return spec.validate(argv);
    const positionals = walkFlags(argv.slice(1), spec);
    if (positionals === undefined) return false;
    return spec.positionals === "any" || positionals.length === 0;
  });
}
