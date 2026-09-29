import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
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

async function writeVoiceConfig(
  configPath: string,
  changes: Record<string, unknown>,
): Promise<void> {
  // Settings rows save independently and each save merges into the existing
  // file; the lock keeps a slow save from clobbering a newer one.
  await withFileLock(`${configPath}.lock`, async () => {
    const config = { ...readVoiceConfig(configPath), ...changes };
    // The config carries user identity details; the atomic writer keeps the
    // file 0600 and never leaves a torn file behind on crash.
    await writeJsonAtomic(configPath, config, { mode: 0o600 });
  });
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

export async function saveActiveModel(configPath: string, modelId: string): Promise<void> {
  await writeVoiceConfig(configPath, { dictationModel: modelId });
}

export async function saveActiveVoice(configPath: string, voice: string | number): Promise<void> {
  await writeVoiceConfig(configPath, { voice });
}

export async function saveActiveTtsModel(configPath: string, modelId: string): Promise<void> {
  await writeVoiceConfig(configPath, { ttsModel: modelId });
}

export function resolveSource(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[SOURCE_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv.trim();
  // "default" is a PulseAudio source id; avfoundation addresses the default
  // microphone as ":0" (no video device, first audio device).
  return process.platform === "darwin" ? ":0" : "default";
}
