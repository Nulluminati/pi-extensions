import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Model,
  ProviderEnv,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNodeError } from "./errors.ts";
import { agentConfigPath } from "./paths.ts";
import { THINKING_LEVELS } from "./thinking-levels.ts";

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "minimal";
const OPENCODE_HOST = "opencode.ai";

export const SMALL_MODEL_ENV_VAR = "PI_SMALL_MODEL";
export const SMALL_MODEL_THINKING_ENV_VAR = "PI_SMALL_MODEL_THINKING";
export const SMALL_MODEL_CONFIG_ENV_VAR = "PI_SMALL_MODEL_CONFIG";

export interface SmallModelConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface SmallModelAuth {
  apiKey: string;
  headers?: ProviderHeaders;
  env?: ProviderEnv;
}

export interface ResolvedSmallModel {
  model: Model<any>;
  auth: SmallModelAuth;
  config: SmallModelConfig;
  /** "environment" when PI_SMALL_MODEL supplied the model, otherwise "config". */
  source: "config" | "environment";
  reasoning: SmallModelReasoning;
}

/** Provider-neutral reasoning option; undefined turns thinking off. */
type SmallModelReasoning = SimpleStreamOptions["reasoning"];

interface ConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function parseSmallModelSpec(
  spec: string,
): Pick<SmallModelConfig, "provider" | "model"> | undefined {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

export function resolveSmallModelConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  agentDir = getAgentDir(),
): string {
  const override = env[SMALL_MODEL_CONFIG_ENV_VAR]?.trim();
  return override || agentConfigPath("small-model", agentDir);
}

/**
 * Load the small-model selection from the environment on top of the config file.
 * `PI_SMALL_MODEL` replaces the provider and model; `PI_SMALL_MODEL_THINKING`,
 * when set, replaces the thinking level. Both variables together fully override
 * the file, so the file is not read in that case.
 */
export function loadSmallModelConfig(options: ConfigOptions = {}): {
  config: SmallModelConfig;
  source: "config" | "environment";
} {
  const env = options.env ?? process.env;
  const environmentModel = parseEnvironmentModel(env);
  const environmentThinking = parseEnvironmentThinkingLevel(env);

  if (environmentModel && environmentThinking) {
    return {
      config: { ...environmentModel, thinkingLevel: environmentThinking },
      source: "environment",
    };
  }

  const configPath = options.configPath ?? resolveSmallModelConfigPath(env);
  const saved = readSavedSmallModelConfig(configPath);

  if (!saved) {
    if (!environmentModel) {
      throw new Error(
        `Global small model is not configured. Run /smallmodel to select one (${configPath}).`,
      );
    }
    return {
      config: {
        ...environmentModel,
        thinkingLevel: environmentThinking ?? DEFAULT_THINKING_LEVEL,
      },
      source: "environment",
    };
  }

  return {
    config: {
      provider: environmentModel?.provider ?? saved.provider,
      model: environmentModel?.model ?? saved.model,
      thinkingLevel: environmentThinking ?? saved.thinkingLevel,
    },
    source: environmentModel ? "environment" : "config",
  };
}

function parseEnvironmentModel(
  env: NodeJS.ProcessEnv,
): Pick<SmallModelConfig, "provider" | "model"> | undefined {
  const environmentSpec = env[SMALL_MODEL_ENV_VAR]?.trim();
  if (!environmentSpec) return undefined;
  const parsed = parseSmallModelSpec(environmentSpec);
  if (!parsed) {
    throw new Error(
      `Invalid ${SMALL_MODEL_ENV_VAR} value "${environmentSpec}". Expected provider/model-id.`,
    );
  }
  return parsed;
}

/** An empty variable counts as unset, like an empty PI_SMALL_MODEL. */
function parseEnvironmentThinkingLevel(env: NodeJS.ProcessEnv): ThinkingLevel | undefined {
  const value = env[SMALL_MODEL_THINKING_ENV_VAR]?.trim();
  if (!value) return undefined;
  return parseThinkingLevel(value, SMALL_MODEL_THINKING_ENV_VAR);
}

/** Returns undefined when the file does not exist; throws when it is unreadable or invalid. */
function readSavedSmallModelConfig(configPath: string): SmallModelConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read global small model config ${configPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid global small model config ${configPath}: expected an object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim()
  ) {
    throw new Error(
      `Invalid global small model config ${configPath}: provider and model must be non-empty strings.`,
    );
  }

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    thinkingLevel: parseThinkingLevel(value.thinkingLevel, "thinkingLevel"),
  };
}

export function saveSmallModelConfig(config: SmallModelConfig, configPath: string): void {
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

export async function resolveSmallModel(
  ctx: ExtensionContext,
  options: ConfigOptions = {},
): Promise<ResolvedSmallModel> {
  const loaded = loadSmallModelConfig(options);
  return resolveSmallModelFromConfig(ctx, loaded.config, loaded.source);
}

export async function resolveSmallModelFromConfig(
  ctx: ExtensionContext,
  config: SmallModelConfig,
  source: "config" | "environment" = "config",
): Promise<ResolvedSmallModel> {
  const label = `${config.provider}/${config.model}`;
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model)
    throw new Error(`Global small model not found: ${label}. Run /smallmodel to replace it.`);
  if (!model.input.includes("text")) {
    throw new Error(
      `Global small model ${label} does not accept text. Run /smallmodel to replace it.`,
    );
  }

  const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!authResult?.ok || !authResult.apiKey) {
    throw new Error(
      `No credentials for global small model ${label}. Configure its provider first.`,
    );
  }

  const auth: SmallModelAuth = { apiKey: authResult.apiKey };
  const sessionHeaders = getOpenCodeSessionHeaders(model, ctx);
  if (sessionHeaders || authResult.headers) {
    auth.headers = { ...sessionHeaders, ...authResult.headers };
  }
  if (authResult.env) auth.env = authResult.env;

  return {
    model,
    auth,
    config,
    source,
    reasoning: model.reasoning ? thinkingLevelToReasoning(config.thinkingLevel) : undefined,
  };
}

function getOpenCodeSessionHeaders(
  model: Model<any>,
  ctx: ExtensionContext,
): ProviderHeaders | undefined {
  if (!isOpenCodeModel(model)) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function isOpenCodeModel(model: Model<any>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  if (!model.baseUrl) return false;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

function parseThinkingLevel(value: unknown, source: string): ThinkingLevel {
  if (value === undefined || value === null || value === "") return DEFAULT_THINKING_LEVEL;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(
    `Invalid ${source} value "${String(value)}". Expected off, minimal, low, medium, high, xhigh, or max.`,
  );
}

function thinkingLevelToReasoning(level: ThinkingLevel): SmallModelReasoning {
  return level === "off" ? undefined : level;
}
