// --- Constants ---

export const SAMPLE_RATE = 16000;

export const HOLD_TO_VOICE_MS = 1000;

export const HOLD_RELEASE_DEBOUNCE_MS = 75;

// Window within which a second Space event counts as an auto-repeat of a
// held key instead of a fresh press. Lets a repeat classify a press as a
// hold without typing hold text; a lone press types immediately.
export const SPACE_REPEAT_WINDOW_MS = 400;

// Window after the voice overlay closes during which Space presses insert
// normally instead of arming a hold, so the key press that opened (or closed)
// the panel cannot instantly reopen it.
export const HOLD_COOLDOWN_MS = 1500;

export const HOLD_REPEAT_GAP_MS = 1200;

export const HOLD_REPEAT_MIN_EVENTS = 2;

export const DEFAULT_MODEL_ID = "moonshine-v2-base-en";

export const DEFAULT_TTS_MODEL_ID = "kitten-nano-en-v0_8-int8";

export const TTS_WIDGET_KEY = "voice-speak";

// Supertonic 3 generates with a fixed denoising step count and language tag;
// all shipped dictation models are English, so the voice language follows.
export const SUPERTONIC_NUM_STEPS = 8;
export const SUPERTONIC_LANG = "en";

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

export const VAD_MODEL_FILE = "silero_vad.onnx";

export const VAD_WINDOW_SIZE = 512;

export const VAD_SPEECH_THRESHOLD = 0.5;

export const VAD_SILENCE_DURATION = 0.3;

export const VAD_SPEECH_DURATION = 0.1;

export const VAD_MAX_SPEECH_DURATION = 20;

// Moonshine v2 ONNX exports silently return an empty transcript for audio
// longer than about 9.2 seconds: sherpa-onnx fed the decoder a frame-length
// attention mask while the graphs expect raw audio length (k2-fsa/sherpa-onnx
// issues #3471 and #3975, fixed upstream by PR #3976 but not yet in an npm
// release). Keep decodes under the measured 9.2s threshold until the fixed
// addon ships, then remove this cap.
export const MOONSHINE_V2_MAX_SEGMENT_SEC = 9;

export const SOURCE_ENV_VAR = "PI_VOICE_SOURCE";
