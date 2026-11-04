/** Deterministic command checks. Hard denies precede every approval path. */

import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AllowRule, checkCommand, commandWords, splitCommand } from "./bash-allow.ts";

// --- Constants ---

// --- Hard denies ---

/** These rules catch clear catastrophic forms; they do not pretend to parse shell programs. */
const HARD_DENIES = [
  /(?:^|[\s;&|])(?:sudo|su|doas|pkexec)(?=\s|$)/i,
  // macOS privilege escalation: osascript with administrator privileges
  // triggers the GUI root prompt, bypassing sudo-detection entirely.
  /\bosascript\b(?=[^\n]*administrator\s+privileges)/i,
  /\b(?:mkfs(?:\.[\w-]+)?|wipefs|blkdiscard|sfdisk|sgdisk)\b/i,
  /\bdd\b[^\n;&|]*\bof\s*=\s*["']?\/dev\//i,
  /\bdiskutil\s+(?:erase\w*|partition\w*)\b/i,
  /\bgit\s+clean\s+[^\n;&|]*-(?:[a-z]*f[a-z]*|-(?:force))\b/i,
  /\bgit\s+reset\s+[^\n;&|]*--hard\b/i,
  /\b(?:curl|wget|scp|rsync)\b[^\n;&|]*(?:@|\s)(?:\.env(?:\b|\.)|~\/\.ssh\/|\/\.ssh\/|[^\s]*\/(?:id_rsa|id_ed25519|auth\.json)\b)/i,
];

/** Splits a command into the stages that shell separators start. */
const COMMAND_STAGES = /[;\n&|]/;
/** An rm stage: the run of option words, then the first operand. */
const RM_INVOCATION = /(?:^|\s)rm\s+((?:-{1,2}[a-z][\w-]*\s+)+)(?:--\s+)?(\S+)/i;
const RECURSIVE_FLAG = /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive|--force)(?=\s)/i;
const ROOT_TARGETS = new Set([
  "/",
  "~",
  "$HOME",
  "$" + "{HOME}",
  "$PWD",
  "$" + "{PWD}",
  ".",
  "./",
  "..",
  "../",
  "*",
  "./*",
  "/*",
  "~/*",
  "$HOME/*",
  "$" + "{HOME}/*",
  ".*",
  "./.*",
  ".git",
  "./.git",
]);

// Every spelling of a home directory: ~, $HOME, ${HOME}, /home/<user>, /Users/<user>, /root.
const HOME_CREDENTIAL_STORE =
  /^(?:~|\$HOME|\$\{HOME\}|\/home\/[^/]+|\/Users\/[^/]+|\/root)\/(?:\.ssh|\.gnupg|\.pi)(?:\/|$)/;

// --- Types ---

export type CommandClass = "hard-deny" | "known-safe" | "needs-jev";

function isRootDeletion(command: string, cwd: string, agentDir: string): boolean {
  return command.split(COMMAND_STAGES).some((stage) => isRootDeletionStage(stage, cwd, agentDir));
}

function isRootDeletionStage(stage: string, cwd: string, agentDir: string): boolean {
  const match = RM_INVOCATION.exec(stage);
  if (!match || !RECURSIVE_FLAG.test(match[1] ?? "")) return false;
  const target = match[2]?.replace(/^["']|["'](?=\/*$)/g, "");
  if (!target) return false;
  const bareTarget = target.replace(/\/+$/, "") || "/";
  const bareAgentDir = agentDir.replace(/\/+$/, "");
  return (
    ROOT_TARGETS.has(bareTarget) ||
    bareTarget === cwd ||
    bareTarget === bareAgentDir ||
    bareTarget.startsWith(`${bareAgentDir}/`) ||
    /^(?:\/home|\/root|\/etc|\/usr|\/var|\/tmp|\/opt|\/dev|\/sys|\/proc)$/.test(bareTarget) ||
    /^(?:\/Users|\/Applications|\/Library|\/System|\/Volumes|\/private)$/.test(bareTarget) ||
    HOME_CREDENTIAL_STORE.test(target) ||
    /(?:^|\/)\.git(?:\/|$)/.test(target)
  );
}

// --- Known safe ---

/** A deliberately tiny fast path. No shell syntax, substitutions, or unknown flags. */
const KNOWN_SAFE = [
  /^pwd$/,
  /^ls(?: -(?:l|a|h|1|la|al|lah|alh))?$/, // current directory only
  /^git status(?: --(?:short|porcelain))?$/, // exact forms already used for repository inspection
];

/** Card actions the herdboard CLI may run without review; other subcommands stay judgeable. */
const HERDBOARD_SUBCOMMANDS = ["show", "list", "log", "add", "move", "attach", "edit"];

/** uv tools install each tool's interpreter under <home>/.local/share/uv/tools/<tool>/bin. */
const HERDBOARD_UV_BIN = ".local/share/uv/tools/herdboard/bin";

/** Word prefixes that start a herdboard invocation. */
function herdboardLaunches(home: string): string[][] {
  return [
    ["herdboard"],
    ["python3", "-m", "herdboard"],
    [`~/${HERDBOARD_UV_BIN}/python`, "-m", "herdboard"],
    [`~/${HERDBOARD_UV_BIN}/python3`, "-m", "herdboard"],
    [`${home}/${HERDBOARD_UV_BIN}/python`, "-m", "herdboard"],
    [`${home}/${HERDBOARD_UV_BIN}/python3`, "-m", "herdboard"],
  ];
}

/**
 * Approved `[--json] <subcommand> ...` prefixes whose remaining
 * arguments may be any scanner-clean literal text (checkCommand's allowMore).
 */
function herdboardRules(home: string): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const launch of herdboardLaunches(home)) {
    const words = launch.join(" ");
    for (const subcommand of HERDBOARD_SUBCOMMANDS) {
      rules.push({
        pattern: `${words} ${subcommand} *`,
        tokens: [...launch, subcommand],
        allowMore: true,
      });
      rules.push({
        pattern: `${words} --json ${subcommand} *`,
        tokens: [...launch, "--json", subcommand],
        allowMore: true,
      });
    }
  }
  return rules;
}

function isHerdboardInvocation(segment: string, rules: AllowRule[]): boolean {
  const executable = commandWords(segment)?.[0];
  // Quoted or escaped ~ names a project-relative path, not the installed tool.
  if (
    executable?.startsWith("~/") &&
    !segment.startsWith(`${executable} `) &&
    !segment.startsWith(`${executable}\t`)
  )
    return false;
  return checkCommand(segment, rules).allowed;
}

/** Only one literal directory, not cd options or a previous-directory lookup. */
function isLiteralCdStage(segment: string): boolean {
  const words = commandWords(segment);
  const directory = words?.[1];
  return words?.length === 2 && words[0] === "cd" && !!directory && !directory.startsWith("-");
}

/**
 * One herdboard invocation, optionally after one `cd <literal dir> &&`. Other
 * composition stays judgeable even when every segment is herdboard.
 */
function isKnownSafeHerdboard(command: string, home: string): boolean {
  // JavaScript whitespace includes characters that the shell treats as executable-name text.
  const source = command.replace(/^[ \t]+|[ \t]+$/g, "");
  const { segments, refusal } = splitCommand(source);
  if (refusal) return false;
  const first = segments[0];
  if (!first) return false;
  const rules = herdboardRules(home);
  if (segments.length === 1) return source === first && isHerdboardInvocation(first, rules);
  const last = segments[1];
  if (segments.length !== 2 || !last) return false;
  // The scanner separates pipes and semicolons too. Only an exact && may connect cd to the tool.
  return (
    source.startsWith(first) &&
    source.endsWith(last) &&
    /^[ \t]*&&[ \t]*$/.test(source.slice(first.length, source.length - last.length)) &&
    isLiteralCdStage(first) &&
    isHerdboardInvocation(last, rules)
  );
}

// --- Execution hooks ---

/** These options invoke another program whose effects the outer command does not describe. */
const EXECUTION_HOOKS = [
  /\bgit\s+-c\s+(?:core\.(?:fsmonitor|sshcommand|hookspath|pager)|gpg\.program|alias\.[\w-]+)=/i,
  /\bgit\s+ls-remote\b[^\n;&|]*--upload-pack(?:=|\s)/i,
  /\bsort\b[^\n;&|]*--compress-program(?:=|\s)/i,
  /\brg\b[^\n;&|]*--pre(?:=|\s)/i,
  /\bfd\b[^\n;&|]*\s(?:-[xX](?:\S*|\s)|--exec(?:-batch)?(?:=|\s|$))/i,
  /\bfind\b[^\n;&|]*\s-exec(?:dir)?(?:\s|$)/i,
];

// --- Classification ---

export function hasExecutionHook(command: string): boolean {
  return EXECUTION_HOOKS.some((pattern) => pattern.test(command));
}

function isProtectedForcePush(command: string): boolean {
  const stages = command.split(/[;\n&|]/);
  return stages.some(
    (stage) =>
      /\bgit\s+push\b/i.test(stage) &&
      // A leading + on a refspec forces that update exactly like --force.
      /(?:--force(?:-with-lease)?\b|--mirror\b|(?:^|\s)-[a-z]*f\b|(?:^|\s)\+\S)/i.test(stage) &&
      /\b(?:main|master|production|prod)\b/i.test(stage),
  );
}

export function classifyCommand(
  command: string,
  cwd: string,
  agentDir = getAgentDir(),
  home = homedir(),
): CommandClass {
  const trimmed = command.trim();
  if (
    isRootDeletion(trimmed, cwd, agentDir) ||
    isProtectedForcePush(trimmed) ||
    HARD_DENIES.some((pattern) => pattern.test(trimmed))
  ) {
    return "hard-deny";
  }
  if (KNOWN_SAFE.some((pattern) => pattern.test(trimmed)) || isKnownSafeHerdboard(command, home)) {
    return "known-safe";
  }
  return "needs-jev";
}
