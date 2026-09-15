/**
 * Worker model configuration.
 *
 * Mirrors the small-model config pattern: an environment variable wins over a
 * JSON config file, and nothing is hardcoded. Delegate fails with a descriptive
 * error when no worker model is configured. The selected model and thinking
 * level are passed to every worker process as `--model` and `--thinking`; the
 * child resolves its own auth.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "pi";
import { agentConfigPath } from "./paths.ts";
import { parseSmallModelSpec } from "./small-model.ts";

// --- Constants ---

export const WORKER_MODEL_ENV_VAR = "PI_WORKER_MODEL";
export const WORKER_MODEL_THINKING_ENV_VAR = "PI_WORKER_MODEL_THINKING";
export const WORKER_MODEL_CONFIG_ENV_VAR = "PI_WORKER_MODEL_CONFIG";
export const DEFAULT_WORKER_THINKING_LEVEL: ThinkingLevel = "high";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// --- Types ---

export interface WorkerModelConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface WorkerModelSelection {
  /** `provider/model-id` string for the worker's --model flag. */
  model: string;
  thinkingLevel: ThinkingLevel;
  source: "environment" | "config";
}

interface ConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

// --- Config file ---

export function resolveWorkerModelConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  agentDir = getAgentDir(),
): string {
  const override = env[WORKER_MODEL_CONFIG_ENV_VAR]?.trim();
  return override || agentConfigPath("worker-model", agentDir);
}

/**
 * Load the configured worker model: PI_WORKER_MODEL environment variable
 * wins; otherwise <agentDir>/worker-model.json. Throws a descriptive error
 * (including the config path) when unconfigured or malformed.
 */
export function loadWorkerModelConfig(options: ConfigOptions = {}): {
  config: WorkerModelConfig;
  source: "environment" | "config";
} {
  const env = options.env ?? process.env;
  const environmentSpec = env[WORKER_MODEL_ENV_VAR]?.trim();
  if (environmentSpec) {
    const parsed = parseSmallModelSpec(environmentSpec);
    if (!parsed) {
      throw new Error(
        `Invalid ${WORKER_MODEL_ENV_VAR} value "${environmentSpec}". Expected provider/model-id.`,
      );
    }
    return {
      config: {
        ...parsed,
        thinkingLevel: parseThinkingLevel(
          env[WORKER_MODEL_THINKING_ENV_VAR],
          WORKER_MODEL_THINKING_ENV_VAR,
        ),
      },
      source: "environment",
    };
  }

  const configPath = options.configPath ?? resolveWorkerModelConfigPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Global worker model is not configured. Run /worker-model to select one or set ${WORKER_MODEL_ENV_VAR} (${configPath}).`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read global worker model config ${configPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid global worker model config ${configPath}: expected an object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim()
  ) {
    throw new Error(
      `Invalid global worker model config ${configPath}: provider and model must be non-empty strings.`,
    );
  }

  return {
    config: {
      provider: value.provider.trim(),
      model: value.model.trim(),
      thinkingLevel: parseThinkingLevel(value.thinkingLevel, "thinkingLevel"),
    },
    source: "config",
  };
}

export function saveWorkerModelConfig(config: WorkerModelConfig, configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

// --- Resolution ---

/**
 * Resolve the configured model for a delegated worker. PI_WORKER_MODEL wins
 * over the config file. Throws when neither source provides a valid model.
 */
export async function resolveWorkerModelSpec(
  options: ConfigOptions = {},
): Promise<WorkerModelSelection> {
  const loaded = loadWorkerModelConfig(options);
  return {
    model: `${loaded.config.provider}/${loaded.config.model}`,
    thinkingLevel: loaded.config.thinkingLevel,
    source: loaded.source,
  };
}

// --- Helpers ---

export function isWorkerThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value as ThinkingLevel);
}

function parseThinkingLevel(value: unknown, source: string): ThinkingLevel {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_WORKER_THINKING_LEVEL;
  }
  if (typeof value === "string" && isWorkerThinkingLevel(value)) return value;
  throw new Error(
    `Invalid ${source} value "${String(value)}". Expected off, minimal, low, medium, high, xhigh, or max.`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
