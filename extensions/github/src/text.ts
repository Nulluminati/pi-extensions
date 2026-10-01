import { stripVTControlCharacters } from "node:util";

/** GitHub text is data, not terminal output. Preserve only printable text and line breaks. */
export function sanitizeGitHubText(text: string): string {
  return Array.from(stripVTControlCharacters(text).replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        character === "\n" || character === "\t" || (code >= 32 && !(code >= 127 && code <= 159))
      );
    })
    .join("")
    .replace(/\t/g, "    ");
}
