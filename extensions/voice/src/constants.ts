import { join } from "node:path";

// --- Constants ---

export const SAMPLE_RATE = 16000;

export const HOLD_TO_VOICE_MS = 1000;

export const HOLD_RELEASE_DEBOUNCE_MS = 75;

export const HOLD_REPEAT_INITIAL_GAP_MS = 2000;

export const HOLD_REPEAT_GAP_MS = 1200;

export const HOLD_REPEAT_MIN_EVENTS = 2;

export const DEFAULT_MODEL_ID = "moonshine-base-int8";

export const DEFAULT_TTS_MODEL_ID = "kitten-nano-en-v0_1-fp16";

export const TTS_STATUS_KEY = "voice-speak";

export const TTS_STATUS_ICON = "🔊";

export const KITTEN_VOICES = [
  "expr-voice-2-m",
  "expr-voice-2-f",
  "expr-voice-3-m",
  "expr-voice-3-f",
  "expr-voice-4-m",
  "expr-voice-4-f",
  "expr-voice-5-m",
  "expr-voice-5-f",
] as const;

export const MODELS_ENV_VAR = "PI_VOICE_MODELS";

export const VOICE_CONFIG_ENV_VAR = "PI_VOICE_CONFIG";

export const DEFAULT_MODELS_SUBDIR = join(".cache", "pi-voice", "models");

export const DEFAULT_CONFIG_SUBPATH = join(".pi", "agent", "extensions", "voice", "config.json");

export const VAD_MODEL_FILE = "silero_vad.onnx";

export const VAD_WINDOW_SIZE = 512;

export const VAD_SPEECH_THRESHOLD = 0.5;

export const VAD_SILENCE_DURATION = 0.3;

export const VAD_SPEECH_DURATION = 0.1;

export const VAD_MAX_SPEECH_DURATION = 20;

export const SOURCE_ENV_VAR = "PI_VOICE_SOURCE";
