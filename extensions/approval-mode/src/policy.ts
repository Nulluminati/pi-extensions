/** Deterministic command checks. Hard denies precede every approval path. */

export type CommandClass = "hard-deny" | "known-safe" | "needs-jev";

/** These rules catch clear catastrophic forms; they do not pretend to parse shell programs. */
const HARD_DENIES = [
  /(?:^|[\s;&|])(?:sudo|su|doas|pkexec)(?=\s|$)/i,
  /\b(?:mkfs(?:\.[\w-]+)?|wipefs|blkdiscard|sfdisk|sgdisk)\b/i,
  /\bdd\b[^\n;&|]*\bof\s*=\s*["']?\/dev\//i,
  /\bdiskutil\s+(?:erase\w*|partition\w*)\b/i,
  /\bgit\s+clean\s+[^\n;&|]*-(?:[a-z]*f[a-z]*|-(?:force))\b/i,
  /\bgit\s+reset\s+[^\n;&|]*--hard\b/i,
  /\b(?:curl|wget|scp|rsync)\b[^\n;&|]*(?:@|\s)(?:\.env(?:\b|\.)|~\/\.ssh\/|\/\.ssh\/|[^\s]*\/(?:id_rsa|id_ed25519|auth\.json)\b)/i,
];

const RECURSIVE_DELETE =
  /(?:^|[\s;&|])rm\s+(?:(?:-[a-z]*[rR][a-z]*|--recursive|--force)\s+)+(?:--\s+)?([^\s;&|]+)/i;
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
  ".*",
  "./.*",
  ".git",
  "./.git",
]);

function isRootDeletion(command: string, cwd: string): boolean {
  const target = RECURSIVE_DELETE.exec(command)?.[1]?.replace(/^["']|["']$/g, "");
  if (!target) return false;
  const bareTarget = target.replace(/\/+$/, "");
  return (
    ROOT_TARGETS.has(target) ||
    bareTarget === cwd ||
    /^(?:\/home|\/root|\/etc|\/usr|\/var|\/tmp|\/opt|\/dev|\/sys|\/proc)$/.test(bareTarget) ||
    /^~\/(?:\.ssh|\.gnupg|\.pi)(?:\/|$)/.test(target) ||
    /(?:^|\/)\.git(?:\/|$)/.test(target)
  );
}

/** A deliberately tiny fast path. No shell syntax, substitutions, or unknown flags. */
const KNOWN_SAFE = [
  /^pwd$/,
  /^ls(?: -(?:l|a|h|1|la|al|lah|alh))?$/, // current directory only
  /^git status(?: --(?:short|porcelain))?$/, // exact forms already used for repository inspection
];

function isProtectedForcePush(command: string): boolean {
  const stages = command.split(/[;\n&|]/);
  return stages.some(
    (stage) =>
      /\bgit\s+push\b/i.test(stage) &&
      /(?:--force(?:-with-lease)?\b|--mirror\b|(?:^|\s)-[a-z]*f\b)/i.test(stage) &&
      /\b(?:main|master|production|prod)\b/i.test(stage),
  );
}

export function classifyCommand(command: string, cwd: string): CommandClass {
  const trimmed = command.trim();
  if (
    isRootDeletion(trimmed, cwd) ||
    isProtectedForcePush(trimmed) ||
    HARD_DENIES.some((pattern) => pattern.test(trimmed))
  ) {
    return "hard-deny";
  }
  if (KNOWN_SAFE.some((pattern) => pattern.test(trimmed))) return "known-safe";
  return "needs-jev";
}
