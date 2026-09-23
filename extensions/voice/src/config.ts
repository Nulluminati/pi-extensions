import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentConfigPath, cacheDir } from "../../../lib/paths.ts";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_TTS_MODEL_ID,
  KITTEN_VOICES,
  MODELS_ENV_VAR,
  SOURCE_ENV_VAR,
  VOICE_CONFIG_ENV_VAR,
} from "./constants.ts";
import { MODELS, TTS_MODELS } from "./models.ts";

export function resolveModelsDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[MODELS_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv;
  return join(cacheDir("voice", env), "models");
}

export function resolveVoiceConfigPath(env: NodeJS.ProcessEnv, agentDir = getAgentDir()): string {
  const fromEnv = env[VOICE_CONFIG_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv.trim();
  return agentConfigPath("voice", agentDir);
}

function readVoiceConfig(configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeVoiceConfig(configPath: string, changes: Record<string, unknown>): void {
  const config = { ...readVoiceConfig(configPath), ...changes };
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

export function loadActiveModelId(configPath: string): string {
  const modelId = readVoiceConfig(configPath).dictationModel;
  return typeof modelId === "string" && MODELS.some((model) => model.id === modelId)
    ? modelId
    : DEFAULT_MODEL_ID;
}

export function loadActiveSpeakerId(configPath: string): number {
  const voice = readVoiceConfig(configPath).voice;
  // Numeric voices are speaker indexes for models that expose several (e.g.
  // Supertonic); validate against the active model's speaker count.
  if (typeof voice === "number" && Number.isInteger(voice) && voice >= 0) {
    const model = TTS_MODELS.find((entry) => entry.id === loadActiveTtsModelId(configPath));
    const count = model?.speakerCount;
    return count === undefined || voice < count ? voice : 0;
  }
  if (typeof voice !== "string") return 0;
  const speakerId = KITTEN_VOICES.indexOf(voice as (typeof KITTEN_VOICES)[number]);
  return speakerId >= 0 ? speakerId : 0;
}

export function loadActiveTtsModelId(configPath: string): string {
  const modelId = readVoiceConfig(configPath).ttsModel;
  return typeof modelId === "string" && TTS_MODELS.some((model) => model.id === modelId)
    ? modelId
    : DEFAULT_TTS_MODEL_ID;
}

export function saveActiveModel(configPath: string, modelId: string): void {
  writeVoiceConfig(configPath, { dictationModel: modelId });
}

export function saveActiveVoice(configPath: string, voice: string | number): void {
  writeVoiceConfig(configPath, { voice });
}

export function saveActiveTtsModel(configPath: string, modelId: string): void {
  writeVoiceConfig(configPath, { ttsModel: modelId });
}

export function resolveSource(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[SOURCE_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv.trim();
  return "default";
}
