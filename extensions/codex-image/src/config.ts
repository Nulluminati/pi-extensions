/**
 * Codex response model resolution.
 *
 * Reads the top-level `model = "..."` entry from the Codex CLI config file
 * (`CODEX_HOME/config.toml`, default `~/.codex/config.toml`). Only root-level
 * entries count: in TOML, keys after a table header belong to that table, so
 * `model` inside `[model_providers.*]`, `[profiles.*]`, or any other table is
 * ignored. No TOML dependency is pulled in — the one key this extension needs
 * is a plain `key = "value"` line before the first header.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";

// --- Constants ---

const DEFAULT_CODEX_MODEL = "gpt-5.5";

// --- Paths ---

function codexHomeDir(): string {
  const configured = process.env.CODEX_HOME;
  return configured ? configured : join(homedir(), ".codex");
}

// --- Parsing ---

/**
 * First root-level `model = "..."` value, or undefined when config.toml has
 * none before its first table header. Full-line comments are skipped and
 * trailing comments are allowed.
 */
export function parseTopLevelModel(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return undefined;
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^model\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (match) {
      const value = match[1];
      return value !== undefined && value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// --- Model resolution ---

/**
 * The response model Codex should use: the top-level `model` from config.toml,
 * or the default when the file or the key is absent.
 */
export async function getCodexResponseModel(): Promise<string> {
  const configPath = join(codexHomeDir(), "config.toml");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return DEFAULT_CODEX_MODEL;
    throw error;
  }
  return parseTopLevelModel(content) ?? DEFAULT_CODEX_MODEL;
}
