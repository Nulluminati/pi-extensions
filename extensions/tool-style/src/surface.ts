// --- Imports ---

import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Constants ---

export const SURFACE_DARKENING = 0.25;
const WAL_POLL_INTERVAL_MS = 750;

// --- Types ---

export interface SurfaceMonitorOptions {
  onChange(surface: string | undefined): void;
  onError(message: string): void;
  path?: string;
}

// --- Color helpers ---

export function darkenHex(hex: string, proportion: number): string | undefined {
  const rgb = parseHex(hex);
  if (!rgb || proportion < 0 || proportion > 1) return undefined;
  const factor = 1 - proportion;
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) =>
      Math.round(channel * factor)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function parseWalSurface(json: string, proportion: number): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !isRecord(value.special)) return undefined;
    const background = value.special.background;
    return typeof background === "string" ? darkenHex(background, proportion) : undefined;
  } catch {
    return undefined;
  }
}

export function toBackgroundAnsi(hex: string): string | undefined {
  const rgb = parseHex(hex);
  return rgb ? `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : undefined;
}

// --- Surface monitor ---

export function startWalSurfaceMonitor(options: SurfaceMonitorOptions): () => void {
  const path = options.path ?? getWalColorsPath();
  let stopped = false;

  const refresh = async () => {
    try {
      const json = await readFile(path, "utf8");
      const surface = parseWalSurface(json, SURFACE_DARKENING);
      if (!surface) {
        options.onError(`Cannot read a terminal background from ${path}`);
        return;
      }
      if (!stopped) options.onChange(surface);
    } catch (error) {
      if (isMissingFileError(error)) {
        if (!stopped) options.onChange(undefined);
        return;
      }
      if (!stopped) options.onError(error instanceof Error ? error.message : String(error));
    }
  };

  const listener = () => {
    void refresh();
  };
  watchFile(path, { interval: WAL_POLL_INTERVAL_MS }, listener);
  void refresh();

  return () => {
    stopped = true;
    unwatchFile(path, listener);
  };
}

function getWalColorsPath(): string {
  const cacheRoot =
    process.env.PYWAL_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return process.env.PYWAL_CACHE_DIR
    ? join(cacheRoot, "colors.json")
    : join(cacheRoot, "wal", "colors.json");
}

function parseHex(hex: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return undefined;
  return {
    r: Number.parseInt(match[1] ?? "", 16),
    g: Number.parseInt(match[2] ?? "", 16),
    b: Number.parseInt(match[3] ?? "", 16),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
