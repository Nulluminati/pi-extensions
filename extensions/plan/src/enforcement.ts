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

// Read-only commands allowed in plan mode; the command must start with one.
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*ss\b/,
  /^\s*netstat\b/,
  /^\s*lsof\b/,
  /^\s*journalctl\b/,
  /^\s*jq\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  /^\s*sed\s+-n\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|blame|shortlog|rev-parse|rev-list|describe|name-rev|stash\s+list|ls-files|ls-tree|ls-remote)\b/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*pnpm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
];

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
 * This is deliberately conservative rather than a shell parser: command and
 * process substitution, compound commands, backgrounding, and redirection are
 * rejected outright, and every stage of a pipeline must be an allowlisted
 * read-only command with no destructive option. That closes interpreter and
 * argument-injection channels such as `echo "$(node -e ...)"`,
 * `cat <(python -c ...)`, and `cat file | node -e ...` while keeping ordinary
 * read-only pipelines (`ps aux | grep node`, `git status 2>&1 | head -5`).
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

  // Every stage must be an allowlisted read-only command: `cat file | node`
  // fails on the second stage. Empty stages come from `||`, `|&`, or a
  // leading/trailing pipe.
  return pipeline.split("|").every((stage) => {
    const segment = stage.trim();
    if (segment.length === 0) return false;
    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment))) return false;
    return SAFE_PATTERNS.some((pattern) => pattern.test(segment));
  });
}
