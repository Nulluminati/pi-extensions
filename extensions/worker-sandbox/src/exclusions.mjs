/** Exclusions accept literal arguments, not expansions or shell operators outside quotes. */
export function isExcludedCommand(command, rules = []) {
  if (/[\r\n\0]/.test(command)) return false;
  const executable = command.match(/^[a-zA-Z0-9_./-]+(?=[ \t]|$)/)?.[0];
  if (!executable) return false;
  const argumentsText = command.slice(executable.length);
  let quote;
  for (const character of argumentsText) {
    if (quote === "'") {
      // Everything except the closing quote is literal in a single-quoted word.
      if (character === "'") quote = undefined;
    } else if (quote === '"') {
      if (/[\$`\\!]/.test(character)) return false;
      if (character === '"') quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (!/[a-zA-Z0-9_./:@%+=, \t-]/.test(character)) {
      return false;
    }
  }
  if (quote) return false;
  return rules.some((rule) => rule.endsWith(" *")
    ? executable === rule.slice(0, -2)
    : executable === rule && argumentsText.trim() === "");
}
