/**
 * Worker model configuration.
 *
 * Mirrors the small-model config pattern: an environment variable wins over a
 * JSON config file, and nothing is hardcoded — delegate fails with a
 * descriptive error when no worker model is configured. The value is a
 * `provider/model-id` string passed to the worker process as `--model`; the
 * child resolves its own auth. The special keyword `main` inherits the
 * current session's model.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "pi";
import { parseSmallModelSpec } from "./small-model.ts";

// --- Constants ---

export const WORKER_MODEL_ENV_VAR = "PI_WORKER_MODEL";
export const WORKER_MODEL_CONFIG_ENV_VAR = "PI_WORKER_MODEL_CONFIG";
export const WORKER_MODEL_MAIN = "main";

// --- Types ---

export interface WorkerModelConfig {
  provider: string;
  model: string;
}

export interface WorkerModelSelection {
  /** `provider/model-id` string for the worker's --model flag. */
  model: string;
  source: "explicit" | "environment" | "config" | "main";
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
  return override || join(agentDir, "worker-model.json");
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
    return { config: parsed, source: "environment" };
  }

  const configPath = options.configPath ?? resolveWorkerModelConfigPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Global worker model is not configured. Run /worker-model to select one, set ${WORKER_MODEL_ENV_VAR}, or pass the delegate tool's model parameter (${configPath}).`,
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
    config: { provider: value.provider.trim(), model: value.model.trim() },
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
 * Resolve the model for a delegated worker. Order: explicit parameter
 * (including the `main` keyword, which inherits the session model), then the
 * environment/config stack. Throws when nothing resolves.
 */
export async function resolveWorkerModelSpec(
  explicit: string | undefined,
  ctx?: ExtensionContext,
  options: ConfigOptions = {},
): Promise<WorkerModelSelection> {
  const trimmed = explicit?.trim();
  if (trimmed) {
    if (trimmed.toLowerCase() === WORKER_MODEL_MAIN) {
      const sessionModel = ctx?.model;
      if (!sessionModel) {
        throw new Error(
          `Worker model "${WORKER_MODEL_MAIN}" requires the session to have a model, but none is set.`,
        );
      }
      return {
        model: `${sessionModel.provider}/${sessionModel.id}`,
        source: "main",
      };
    }
    const parsed = parseSmallModelSpec(trimmed);
    if (!parsed) {
      throw new Error(
        `Invalid worker model "${trimmed}". Expected provider/model-id, or "main" to inherit the session model.`,
      );
    }
    return { model: `${parsed.provider}/${parsed.model}`, source: "explicit" };
  }

  const loaded = loadWorkerModelConfig(options);
  return { model: `${loaded.config.provider}/${loaded.config.model}`, source: loaded.source };
}

// --- Helpers ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
