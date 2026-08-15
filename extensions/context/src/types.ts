/**
 * Shared data shapes for the context extension.
 */

export interface ContextFileInfo {
  /** Path, shortened for display (cwd-relative or ~-relative). */
  path: string;
  /** Estimated tokens of the file content. */
  tokens: number;
}

export interface SkillInfo {
  name: string;
  /** Estimated tokens of the skill description (what loads into the prompt). */
  tokens: number;
}

export interface MessageSizeInfo {
  role: string;
  /** First line of text, whitespace-collapsed, for identification. */
  preview: string;
  /** Estimated tokens of the full message. */
  tokens: number;
}

export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}
