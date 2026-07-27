import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context7Settings } from "./types.ts";

interface Context7ConfigFile {
  apiKey?: string;
  cache?: {
    resolveTtlHours?: number;
    docsTtlHours?: number;
  };
}

const DEFAULT_RESOLVE_TTL_HOURS = 24 * 7;

const DEFAULT_DOCS_TTL_HOURS = 24;

// --- Config ---

function getExtensionDir(): string {
  return join(homedir(), ".pi", "agent", "extensions", "context7");
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export async function loadSettings(): Promise<Context7Settings> {
  const extensionDir = getExtensionDir();
  const configPath = join(extensionDir, "config.json");
  const cacheDir = join(extensionDir, "cache");

  let config: Context7ConfigFile = {};
  let configError: string | undefined;

  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf8");
      config = JSON.parse(raw) as Context7ConfigFile;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
  }

  const apiKey = process.env.CONTEXT7_API_KEY?.trim() || config.apiKey?.trim() || undefined;
  const resolveTtlHours = normalizePositiveNumber(
    config.cache?.resolveTtlHours,
    DEFAULT_RESOLVE_TTL_HOURS,
  );
  const docsTtlHours = normalizePositiveNumber(config.cache?.docsTtlHours, DEFAULT_DOCS_TTL_HOURS);

  return {
    extensionDir,
    configPath,
    cacheDir,
    apiKey,
    resolveTtlMs: resolveTtlHours * 60 * 60 * 1000,
    docsTtlMs: docsTtlHours * 60 * 60 * 1000,
    configError,
  };
}
