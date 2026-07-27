import { execSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LoadedConfig,
  LspConfigFile,
  LspServerUserConfig,
  ResolvedServerConfig,
} from "./types.ts";

// --- Config Loading ---

const COMMAND_CHECK_TIMEOUT = 5_000;

const NPX_CHECK_TIMEOUT = 15_000;

export const GLOBAL_CONFIG_DIR_SUFFIX = ".pi/agent/extensions/lsp";

export const GLOBAL_CONFIG_FILENAME = "config.json";

export const PROJECT_CONFIG_PATH = ".pi/lsp.json";

function checkCommandAvailable(command: string): "global" | "npx" | "not_found" {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";

  try {
    execSync(`${whichCmd} ${command}`, {
      timeout: COMMAND_CHECK_TIMEOUT,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return "global";
  } catch {
    // Not found globally
  }

  try {
    execSync(`npx --yes ${command} --version`, {
      timeout: NPX_CHECK_TIMEOUT,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return "npx";
  } catch {
    // Not found via npx
  }

  return "not_found";
}

function resolveServerConfig(
  name: string,
  userConfig: LspServerUserConfig,
): ResolvedServerConfig | null {
  const command = userConfig.command;
  if (!command || command.length === 0) return null;

  const extensions = userConfig.extensions;
  if (!extensions || extensions.length === 0) return null;

  const executable = command[0];
  if (!executable) return null;
  const cmdArgs = command.slice(1);

  const availability = checkCommandAvailable(executable);

  if (availability === "not_found") return null;

  let resolvedCommand: string;
  let resolvedArgs: string[];

  if (availability === "npx") {
    resolvedCommand = "npx";
    resolvedArgs = ["--yes", executable, ...cmdArgs];
  } else {
    resolvedCommand = executable;
    resolvedArgs = cmdArgs;
  }

  return {
    name,
    command: resolvedCommand,
    args: resolvedArgs,
    extensions,
    env: userConfig.env ?? {},
    initializationOptions: userConfig.initialization ?? {},
  };
}

function mergeConfigs(
  global: false | Record<string, LspServerUserConfig> | undefined,
  project: false | Record<string, LspServerUserConfig> | undefined,
): Record<string, LspServerUserConfig> {
  if (global === false || project === false) return {};

  const merged: Record<string, LspServerUserConfig> = {};

  if (global && typeof global === "object") {
    for (const [key, value] of Object.entries(global)) {
      if (value.disabled) continue;
      merged[key] = value;
    }
  }

  if (project && typeof project === "object") {
    for (const [key, value] of Object.entries(project)) {
      if (value.disabled) {
        delete merged[key];
        continue;
      }
      // Deep merge env
      const existing = merged[key];
      if (existing) {
        merged[key] = {
          ...existing,
          ...value,
          env: { ...existing.env, ...value.env },
        };
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(rootPath: string): Promise<LoadedConfig> {
  const globalDir = join(homedir(), GLOBAL_CONFIG_DIR_SUFFIX);
  const globalPath = join(globalDir, GLOBAL_CONFIG_FILENAME);
  const projectPath = join(rootPath, PROJECT_CONFIG_PATH);

  let globalConfig: LspConfigFile | null = null;
  let projectConfig: LspConfigFile | null = null;
  const errors: string[] = [];

  const globalExists = await fileExists(globalPath);
  if (globalExists) {
    try {
      const content = await readFile(globalPath, "utf-8");
      globalConfig = JSON.parse(content) as LspConfigFile;
    } catch (e) {
      errors.push(`Failed to read global config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const projectExists = await fileExists(projectPath);
  if (projectExists) {
    try {
      const content = await readFile(projectPath, "utf-8");
      projectConfig = JSON.parse(content) as LspConfigFile;
    } catch (e) {
      errors.push(`Failed to read project config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Check for disabled
  if (globalConfig?.lsp === false || projectConfig?.lsp === false) {
    return { servers: [], globalDisabled: true, errors };
  }

  // Merge configs
  const merged = mergeConfigs(globalConfig?.lsp, projectConfig?.lsp);

  // Resolve servers
  const servers: ResolvedServerConfig[] = [];
  for (const [name, userConfig] of Object.entries(merged)) {
    const resolved = resolveServerConfig(name, userConfig);
    if (resolved) {
      servers.push(resolved);
    }
  }

  return { servers, globalDisabled: false, errors };
}

const STARTER_CONFIG = {
  lsp: {
    typescript: {
      command: ["typescript-language-server", "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    },
  },
};

export async function scaffoldStarterConfig(): Promise<string> {
  const globalDir = join(homedir(), GLOBAL_CONFIG_DIR_SUFFIX);
  const globalPath = join(globalDir, GLOBAL_CONFIG_FILENAME);

  await mkdir(globalDir, { recursive: true });
  await writeFile(globalPath, JSON.stringify(STARTER_CONFIG, null, 2), "utf-8");

  return globalPath;
}
