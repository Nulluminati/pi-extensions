/** Exclusions accept only plain words. Any shell syntax keeps the whole command sandboxed. */
export function isExcludedCommand(command, rules = []) {
  if (!/^[a-zA-Z0-9_./:@%+=,-]+(?:[ \t]+[a-zA-Z0-9_./:@%+=,-]+)*$/.test(command)) return false;
  return rules.some((rule) => rule.endsWith(" *")
    ? command === rule.slice(0, -2) || command.startsWith(`${rule.slice(0, -2)} `)
    : command === rule);
}
