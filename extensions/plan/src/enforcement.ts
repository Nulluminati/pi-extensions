/**
 * Plan mode enforcement: which tools are allowed and which bash commands are
 * safe to run while planning. Pure functions, unit-tested in isolation.
 */

import { MUTATING_TOOLS, PLAN_SUBMIT_TOOL } from "./constants.ts";

/**
 * The active tool set while in plan mode: everything that was active, minus
 * mutating tools, plus plan_submit so the model can propose a plan.
 */
export function buildPlanModeTools(activeToolNames: string[]): string[] {
  const kept = activeToolNames.filter((name) => !MUTATING_TOOLS.has(name));
  return [...new Set([...kept, PLAN_SUBMIT_TOOL])];
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
  /\binstall\b/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bmkswap\b/i,
  /(^|[^<])>(?!>)/, // single > redirect (2>&1 and >> are also caught below)
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
  /\bperl\s+[^|;]*-i\b/i,
  /\b(bash|sh|zsh|fish)\s+-c\b/i,
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

/** True when a bash command is read-only enough to run in plan mode. */
export function isSafeBashCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}
