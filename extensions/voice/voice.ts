/**
 * Voice Extension
 *
 * Speech-to-text dictation and local text-to-speech for Pi, powered by
 * sherpa-onnx loaded in-process through its native Node addon. Dictation and
 * speech synthesis stay local. Spoken summaries use a configured Pi model.
 *
 * Commands:
 *   Hold Space for 1 second  Open the voice dictation overlay.
 *   /voice                    Open the voice dictation overlay.
 *   /voice-models             Select the active transcription model.
 *   /voice-speak [full]       Summarize and speak the latest assistant message.
 *   /voice-stop               Stop current speech generation or playback.
 *   /voice-voices             Select the local Kitten TTS voice.
 *   /voice-summary-model      Select the cloud summarization model.
 *   /voice-info               Show model downloads and audio device information.
 *
 * Models live in $PI_VOICE_MODELS (default ~/.cache/pi-voice/models).
 *
 * The sherpa-onnx-node addon is a native .node file, so it must be loaded with
 * require() rather than an ESM import. The repo validator inspects static and
 * dynamic imports but not require(), so createRequire is both the correct and
 * validator-safe way to load it.
 */

// --- Imports ---

import { execSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";

// --- Constants ---

const SAMPLE_RATE = 16000;
const HOLD_TO_VOICE_MS = 1000;
const HOLD_RELEASE_DEBOUNCE_MS = 75;
const HOLD_REPEAT_INITIAL_GAP_MS = 2000;
const HOLD_REPEAT_GAP_MS = 1200;
const HOLD_REPEAT_MIN_EVENTS = 2;
const DEFAULT_MODEL_ID = "moonshine-base-int8";
const DEFAULT_TTS_MODEL_ID = "kitten-nano-en-v0_1-fp16";
const DEFAULT_SUMMARY_PROVIDER = "synthetic";
const DEFAULT_SUMMARY_MODEL_ID = "syn:small:text";
const TTS_STATUS_KEY = "voice-speak";
const KITTEN_VOICES = [
  "expr-voice-2-m",
  "expr-voice-2-f",
  "expr-voice-3-m",
  "expr-voice-3-f",
  "expr-voice-4-m",
  "expr-voice-4-f",
  "expr-voice-5-m",
  "expr-voice-5-f",
] as const;
const MODELS_ENV_VAR = "PI_VOICE_MODELS";
const DEFAULT_MODELS_SUBDIR = join(".cache", "pi-voice", "models");
const VAD_MODEL_FILE = "silero_vad.onnx";
const VAD_WINDOW_SIZE = 512;
const VAD_SPEECH_THRESHOLD = 0.5;
const VAD_SILENCE_DURATION = 0.3;
const VAD_SPEECH_DURATION = 0.1;
const VAD_MAX_SPEECH_DURATION = 20;

// --- Types ---

type ModelKind = "online" | "offline";

type ModelFamily = "whisper" | "moonshine";

interface ModelDef {
  id: string;
  kind: ModelKind;
  family: ModelFamily;
  dirName: string;
  description: string;
  /** Files that must exist for the model to count as downloaded. */
  files: string[];
  downloadUrl: string;
  /** Whisper models are filed as <prefix>-encoder.onnx etc.; Moonshine uses fixed names. */
  filePrefix?: string;
}

interface SherpaOnnx {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizer;
  OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
  readWave: (path: string) => { samples: Float32Array; sampleRate: number };
  writeWave: (path: string, wave: { samples: Float32Array; sampleRate: number }) => void;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => VadInstance;
}

interface VadInstance {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}

interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text: string };
}

interface OnlineStream {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text: string };
}

interface OfflineStream {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

interface TtsSherpa {
  OfflineTts: {
    new (config: unknown): OfflineTtsInstance;
    createAsync(config: unknown): Promise<OfflineTtsInstance>;
  };
  GenerationConfig: new (config: unknown) => unknown;
  writeWave: (path: string, wave: { samples: Float32Array; sampleRate: number }) => void;
}

interface OfflineTtsInstance {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(config: {
    text: string;
    enableExternalBuffer?: boolean;
    generationConfig?: unknown;
    onProgress?: (info: { samples: Float32Array; progress: number }) => boolean;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

interface SpeechJob {
  cancelled: boolean;
  player: ReturnType<typeof spawn> | null;
}

interface TranscribeResult {
  text: string;
  durationSec: number;
  elapsedSec: number;
  rtf: number;
  modelId: string;
}

interface RecorderDeps {
  hasFfmpeg: boolean;
  hasArecord: boolean;
}

interface HoldToVoiceEditor {
  handleInput(data: string): void;
  wantsKeyRelease?: boolean;
  dispose?: () => void;
}

interface HoldToVoiceDeps {
  isSupported: () => boolean;
  isSpace: (data: string) => boolean;
  isRelease: (data: string) => boolean;
  isRepeat: (data: string) => boolean;
}

interface TtsModelDef {
  id: string;
  dirName: string;
  description: string;
  files: string[];
  downloadUrl: string;
}

interface SummaryModelRef {
  provider: string;
  id: string;
}

// --- Model registry ---

const TTS_MODELS: TtsModelDef[] = [
  {
    id: "kitten-nano-en-v0_1-fp16",
    dirName: "kitten-nano-en-v0_1-fp16",
    description: "Kitten Nano English FP16 with eight local voices.",
    files: ["model.fp16.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2",
  },
];

const MODELS: ModelDef[] = [
  {
    id: "moonshine-base-int8",
    kind: "offline",
    family: "moonshine",
    dirName: "sherpa-onnx-moonshine-base-en-int8",
    description: "Moonshine Base (English), int8. Fast and robust to noisy microphones.",
    files: [
      "preprocess.onnx",
      "encode.int8.onnx",
      "uncached_decode.int8.onnx",
      "cached_decode.int8.onnx",
      "tokens.txt",
    ],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2",
  },
  {
    id: "whisper-tiny-en-int8",
    kind: "offline",
    family: "whisper",
    filePrefix: "tiny.en",
    dirName: "sherpa-onnx-whisper-tiny.en",
    description: "Whisper Tiny (English), int8. Compact general-purpose transcription.",
    files: ["tiny.en-encoder.int8.onnx", "tiny.en-decoder.int8.onnx", "tiny.en-tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2",
  },
  {
    id: "whisper-small-en-int8",
    kind: "offline",
    family: "whisper",
    filePrefix: "small.en",
    dirName: "sherpa-onnx-whisper-small.en",
    description: "Whisper Small (English), int8. More accurate, with slower CPU transcription.",
    files: ["small.en-encoder.int8.onnx", "small.en-decoder.int8.onnx", "small.en-tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2",
  },
];

// --- Pure helpers ---

function addHoldToVoice<T extends HoldToVoiceEditor>(
  editor: T,
  onHold: () => void,
  deps: HoldToVoiceDeps = {
    isSupported: isKittyProtocolActive,
    isSpace: (data) => data === " " || matchesKey(data, Key.space),
    isRelease: isKeyRelease,
    isRepeat: isKeyRepeat,
  },
): T {
  const originalHandleInput = editor.handleInput.bind(editor);
  const originalDispose = editor.dispose?.bind(editor);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatGapTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatStartedAt = 0;
  let repeatLastAt = 0;
  let repeatCount = 0;
  let repeatActive = false;
  let triggered = false;

  const clearHoldTimer = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const clearRepeatGapTimer = (): void => {
    if (repeatGapTimer) clearTimeout(repeatGapTimer);
    repeatGapTimer = null;
  };
  const resetRepeat = (restoreSpace: boolean): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    repeatStartedAt = 0;
    repeatLastAt = 0;
    repeatCount = 0;
    repeatActive = false;
    if (restoreSpace) originalHandleInput(" ");
  };
  const scheduleRepeatReset = (delay: number, restoreSpace: boolean): void => {
    clearRepeatGapTimer();
    repeatGapTimer = setTimeout(() => resetRepeat(restoreSpace), delay);
  };
  const scheduleTriggeredReset = (): void => {
    clearRepeatGapTimer();
    repeatGapTimer = setTimeout(() => {
      triggered = false;
      repeatGapTimer = null;
    }, HOLD_REPEAT_GAP_MS);
  };
  const startHoldTimer = (elapsed: number): void => {
    clearHoldTimer();
    holdTimer = setTimeout(
      () => {
        holdTimer = null;
        clearRepeatGapTimer();
        repeatStartedAt = 0;
        repeatLastAt = 0;
        repeatCount = 0;
        repeatActive = false;
        triggered = true;
        if (!deps.isSupported()) scheduleTriggeredReset();
        onHold();
      },
      Math.max(0, HOLD_TO_VOICE_MS - elapsed),
    );
  };

  editor.wantsKeyRelease = true;
  editor.handleInput = (data: string): void => {
    const supported = deps.isSupported();
    const space = deps.isSpace(data);

    if (!supported) {
      if (!space) {
        resetRepeat(repeatActive);
        originalHandleInput(data);
        return;
      }

      if (triggered) {
        scheduleTriggeredReset();
        return;
      }

      const now = Date.now();
      if (repeatCount === 0) {
        originalHandleInput(" ");
        repeatStartedAt = now;
        repeatLastAt = now;
        repeatCount = 1;
        scheduleRepeatReset(HOLD_REPEAT_INITIAL_GAP_MS, false);
        return;
      }

      const maximumGap = repeatCount === 1 ? HOLD_REPEAT_INITIAL_GAP_MS : HOLD_REPEAT_GAP_MS;
      if (now - repeatLastAt > maximumGap) {
        resetRepeat(repeatActive);
        originalHandleInput(" ");
        repeatStartedAt = now;
        repeatLastAt = now;
        repeatCount = 1;
        scheduleRepeatReset(HOLD_REPEAT_INITIAL_GAP_MS, false);
        return;
      }

      repeatLastAt = now;
      repeatCount++;
      if (!repeatActive) {
        originalHandleInput(" ");
        if (repeatCount >= HOLD_REPEAT_MIN_EVENTS) {
          repeatActive = true;
          for (let i = 0; i < repeatCount; i++) originalHandleInput("\x7f");
          startHoldTimer(now - repeatStartedAt);
        }
      }
      scheduleRepeatReset(HOLD_REPEAT_GAP_MS, repeatActive);
      return;
    }

    if (!space) {
      originalHandleInput(data);
      return;
    }
    if (deps.isRelease(data)) {
      clearHoldTimer();
      if (!triggered) originalHandleInput(" ");
      triggered = false;
      return;
    }
    if (deps.isRepeat(data)) return;
    if (triggered) triggered = false;
    if (holdTimer) return;
    startHoldTimer(0);
  };
  editor.dispose = (): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    originalDispose?.();
  };
  return editor;
}

const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set([
  "thanks for watching",
  "thanks for watching everyone",
  "thank you for watching",
  "please subscribe",
  "please like and subscribe",
  "see you in the next video",
  "see you next time",
  "ill see you in the next video",
  "subtitles by the amaraorg community",
  "transcribed by esoteric",
  "music",
  "applause",
  "silence",
  "you",
  "thank you",
  "bye",
]);

/** Whole-output hallucination: the entire segment is a known Whisper filler phrase or a repetition loop. */
function isHallucination(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (HALLUCINATION_PHRASES.has(normalized)) return true;
  if (isRepetitionLoop(normalized)) return true;
  return false;
}

/** Strip a trailing repetition loop, keeping the legitimate lead text and one instance of the repeated group. */
function stripRepetitionLoop(text: string): string {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 6) return text;
  // Try each group size; for each, find the longest tail of repeating groups.
  for (let groupSize = 1; groupSize <= 4; groupSize++) {
    const minReps = groupSize === 1 ? 4 : 3;
    if (tokens.length < groupSize * minReps) continue;
    // The repeating unit is the last `groupSize` tokens. Walk backward to
    // count how many consecutive copies precede it. "collaboration, collaboration,
    // collaboration" with groupSize=1: unit=["collaboration,"], 3 reps.
    const unit = tokens.slice(-groupSize);
    let reps = 1;
    let i = tokens.length - groupSize * 2;
    while (i >= 0) {
      const candidate = tokens.slice(i, i + groupSize);
      if (sameTokens(candidate, unit)) {
        reps++;
        i -= groupSize;
      } else {
        break;
      }
    }
    if (reps >= minReps) {
      const cutAt = tokens.length - (reps - 1) * groupSize;
      return tokens.slice(0, cutAt).join(" ");
    }
  }
  return text;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRepetitionLoop(normalized: string): boolean {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < 4) return false;
  for (let groupSize = 1; groupSize <= 3; groupSize++) {
    const minRepeats = groupSize === 1 ? 4 : 3;
    if (tokens.length < groupSize * minRepeats) continue;
    let allMatch = true;
    for (let i = groupSize; i < tokens.length; i++) {
      const cur = tokens[i];
      const ref = tokens[i % groupSize];
      if (cur === undefined || ref === undefined || cur !== ref) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Normalize punctuation so "collaboration," matches "collaboration".
    if (normalizeText(a[i] ?? "") !== normalizeText(b[i] ?? "")) return false;
  }
  return true;
}

function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

function resolveModelsDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[MODELS_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv;
  return join(homedir(), DEFAULT_MODELS_SUBDIR);
}

function modelDirPath(modelsDir: string, model: ModelDef | TtsModelDef): string {
  return join(modelsDir, model.dirName);
}

/** True when every file the model needs is present in its directory. */
function modelIsDownloaded(modelsDir: string, model: ModelDef | TtsModelDef): boolean {
  const dir = modelDirPath(modelsDir, model);
  return model.files.every((file) => existsSync(join(dir, file)));
}

function buildKittenConfig(model: TtsModelDef, modelsDir: string, numThreads: number): unknown {
  const dir = modelDirPath(modelsDir, model);
  return {
    model: {
      kitten: {
        model: join(dir, "model.fp16.onnx"),
        voices: join(dir, "voices.bin"),
        tokens: join(dir, "tokens.txt"),
        dataDir: join(dir, "espeak-ng-data"),
      },
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
  };
}

function createSpeechJob(): SpeechJob {
  return { cancelled: false, player: null };
}

function stopSpeechJob(job: SpeechJob): void {
  job.cancelled = true;
  job.player?.kill("SIGKILL");
  job.player = null;
}

async function playKittenSpeech(
  sherpa: TtsSherpa,
  engine: OfflineTtsInstance,
  text: string,
  speakerId: number,
  job: SpeechJob,
): Promise<void> {
  if (job.cancelled) return;
  const playerCommand = hasTool("pw-play") ? "pw-play" : hasTool("ffplay") ? "ffplay" : undefined;
  if (!playerCommand) {
    throw new Error("Install PipeWire (pw-play) or ffmpeg (ffplay) for playback.");
  }

  const audio = await engine.generateAsync({
    text,
    generationConfig: new sherpa.GenerationConfig({
      sid: speakerId,
      speed: 1,
      silenceScale: 0.2,
    }),
    onProgress: () => !job.cancelled,
  });
  if (job.cancelled) return;

  const wavPath = join(tmpdir(), `pi-voice-tts-${process.pid}-${Date.now()}.wav`);
  sherpa.writeWave(wavPath, audio);
  const playerArgs =
    playerCommand === "pw-play"
      ? [wavPath]
      : ["-nodisp", "-autoexit", "-loglevel", "error", wavPath];
  const player = spawn(playerCommand, playerArgs, { stdio: ["ignore", "ignore", "ignore"] });
  job.player = player;
  try {
    await new Promise<void>((resolve, reject) => {
      player.once("error", reject);
      player.once("close", (code) => {
        if (job.cancelled || code === 0 || code === null) resolve();
        else reject(new Error(`${playerCommand} exited with code ${code}`));
      });
    });
  } finally {
    if (job.player === player) job.player = null;
    if (job.cancelled) player.kill("SIGKILL");
    rmSync(wavPath, { force: true });
  }
}

function findLatestAssistantText(entries: unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as {
      type?: string;
      role?: string;
      content?: unknown;
      message?: { role?: string; content?: unknown };
    };
    const message = entry.type === "message" ? entry.message : entry;
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSpokenSummaryPrompt(text: string): string {
  return `Summarize the assistant response below in 40 to 70 words for text-to-speech.
Use plain spoken prose with no Markdown, code blocks, URLs, or formatting symbols.
State the outcome, important caveats, and next action. Do not add facts.

Assistant response:
${text.slice(0, 16000)}`;
}

/** Build the config object for an OnlineRecognizer (streaming transducer). */
function buildOnlineConfig(model: ModelDef, modelsDir: string, numThreads: number): unknown {
  const dir = modelDirPath(modelsDir, model);
  const isInt8 = model.id.endsWith("-int8");
  const suffix = isInt8 ? ".int8" : "";
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, `encoder-epoch-99-avg-1${suffix}.onnx`),
        decoder: join(dir, "decoder-epoch-99-avg-1.onnx"),
        joiner: join(dir, `joiner-epoch-99-avg-1${suffix}.onnx`),
      },
      tokens: join(dir, "tokens.txt"),
      numThreads,
      provider: "cpu",
      debug: 0,
    },
  };
}

/** Build the config object for an OfflineRecognizer (Whisper or Moonshine). */
function buildOfflineConfig(model: ModelDef, modelsDir: string, numThreads: number): unknown {
  const dir = modelDirPath(modelsDir, model);
  const isInt8 = model.id.endsWith("-int8");
  const suffix = isInt8 ? ".int8" : "";
  if (model.family === "moonshine") {
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: {
          preprocessor: join(dir, "preprocess.onnx"),
          encoder: join(dir, `encode${suffix}.onnx`),
          uncachedDecoder: join(dir, `uncached_decode${suffix}.onnx`),
          cachedDecoder: join(dir, `cached_decode${suffix}.onnx`),
        },
        tokens: join(dir, "tokens.txt"),
        numThreads,
        provider: "cpu",
        debug: 0,
      },
    };
  }
  // Whisper family
  const prefix = model.filePrefix ?? "tiny.en";
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(dir, `${prefix}-encoder${suffix}.onnx`),
        decoder: join(dir, `${prefix}-decoder${suffix}.onnx`),
        language: "en",
        task: "transcribe",
        tailPaddings: 1000,
      },
      tokens: join(dir, `${prefix}-tokens.txt`),
      numThreads,
      provider: "cpu",
      debug: 0,
    },
  };
}

function detectRecorders(): RecorderDeps {
  return {
    hasFfmpeg: hasTool("ffmpeg"),
    hasArecord: hasTool("arecord"),
  };
}

function hasTool(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SOURCE_ENV_VAR = "PI_VOICE_SOURCE";

function resolveSource(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[SOURCE_ENV_VAR];
  if (fromEnv?.trim()) return fromEnv.trim();
  return "default";
}

interface SourceInfo {
  name: string;
  description: string;
}

/** Parse `pactl list short sources` into name/description pairs. Pure. */
function parseSourcesListing(output: string): SourceInfo[] {
  const lines = output.split("\n").filter((line) => line.trim());
  const result: SourceInfo[] = [];
  for (const line of lines) {
    // Format: <id>\t<name>\t<driver>\t<sample-spec>\t<state>
    const parts = line.split("\t");
    const name = parts[1]?.trim();
    if (name) result.push({ name, description: parts[4]?.trim() || name });
  }
  return result;
}

function listSources(): SourceInfo[] {
  try {
    const out = execSync("pactl list short sources", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString();
    return parseSourcesListing(out);
  } catch {
    return [];
  }
}

// --- Native addon loading ---

function loadSherpa(): SherpaOnnx {
  // createRequire is required for native .node addons; Node caches the module
  // so repeated calls are instant.
  const require = createRequire(import.meta.url);
  return require("sherpa-onnx-node") as SherpaOnnx;
}

// --- Transcription (dependency-injected for testability) ---

/** Resolve the VAD model path. Returns undefined if not downloaded. */
function resolveVadModel(modelsDir: string): string | undefined {
  const path = join(modelsDir, VAD_MODEL_FILE);
  return existsSync(path) ? path : undefined;
}

/** Segment audio into speech regions using silero VAD. Returns speech segments. */
function vadSegment(
  sherpa: SherpaOnnx,
  vadModelPath: string,
  samples: Float32Array,
  sampleRate: number,
): Float32Array[] {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModelPath,
        threshold: VAD_SPEECH_THRESHOLD,
        minSilenceDuration: VAD_SILENCE_DURATION,
        minSpeechDuration: VAD_SPEECH_DURATION,
        windowSize: VAD_WINDOW_SIZE,
        maxSpeechDuration: VAD_MAX_SPEECH_DURATION,
      },
      sampleRate,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    30,
  );
  for (let i = 0; i < samples.length; i += VAD_WINDOW_SIZE) {
    const chunk = samples.subarray(i, Math.min(i + VAD_WINDOW_SIZE, samples.length));
    vad.acceptWaveform(chunk);
  }
  vad.flush();
  const segments: Float32Array[] = [];
  while (!vad.isEmpty()) {
    const seg = vad.front();
    segments.push(seg.samples);
    vad.pop();
  }
  return segments;
}

/** Transcribe a single segment of audio (no VAD, raw). */
function transcribeSegment(
  sherpa: SherpaOnnx,
  model: ModelDef,
  modelsDir: string,
  samples: Float32Array,
  sampleRate: number,
  numThreads: number,
): string {
  if (model.kind === "online") {
    const recognizer = new sherpa.OnlineRecognizer(buildOnlineConfig(model, modelsDir, numThreads));
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    stream.acceptWaveform({ samples: new Float32Array(sampleRate * 0.4), sampleRate });
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
    return recognizer.getResult(stream).text;
  }
  const recognizer = new sherpa.OfflineRecognizer(buildOfflineConfig(model, modelsDir, numThreads));
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  recognizer.decode(stream);
  const raw = recognizer.getResult(stream).text;
  // Anti-loop layers (offline models only — online models don't loop):
  //   1. Drop the whole segment if it's a known Whisper filler/hallucination.
  //   2. Strip a trailing repetition loop, keeping the legitimate lead text.
  if (isHallucination(raw)) return "";
  return stripRepetitionLoop(raw);
}

function transcribeFile(
  sherpa: SherpaOnnx,
  model: ModelDef,
  modelsDir: string,
  wavPath: string,
  numThreads = 2,
): TranscribeResult {
  const wave = sherpa.readWave(wavPath);
  const durationSec = wave.samples.length / wave.sampleRate;
  if (durationSec <= 0) {
    throw new Error("Audio file is empty or could not be read.");
  }
  const start = performance.now();

  // VAD preprocessing: strip silence and segment into speech regions.
  // Without this, Whisper/Moonshine loop-hallucinate on silent audio,
  // wasting their token budget on repetition instead of actual speech.
  const vadModelPath = resolveVadModel(modelsDir);
  let text: string;
  if (vadModelPath) {
    const segments = vadSegment(sherpa, vadModelPath, wave.samples, wave.sampleRate);
    if (segments.length === 0) {
      text = "";
    } else {
      const parts: string[] = [];
      for (const seg of segments) {
        const segText = transcribeSegment(
          sherpa,
          model,
          modelsDir,
          seg,
          wave.sampleRate,
          numThreads,
        );
        if (segText.trim()) parts.push(segText.trim());
      }
      text = parts.join(" ");
    }
  } else {
    // No VAD model: transcribe the whole clip at once (may loop on silence).
    text = transcribeSegment(sherpa, model, modelsDir, wave.samples, wave.sampleRate, numThreads);
  }
  const elapsedSec = (performance.now() - start) / 1000;
  return {
    text: text.trim(),
    durationSec,
    elapsedSec,
    rtf: elapsedSec / durationSec,
    modelId: model.id,
  };
}

// --- Streaming STT engine (cached recognizer) ---

/**
 * Caches the OfflineRecognizer/OnlineRecognizer across decode calls so the
 * model loads once and every subsequent decode reuses it. Without caching,
 * each decode re-loads the model into RAM, causing OOM under streaming load.
 */
class SttEngine {
  private recognizer: OfflineRecognizer | OnlineRecognizer | null = null;

  constructor(
    private readonly sherpa: SherpaOnnx,
    private readonly model: ModelDef,
    private readonly modelsDir: string,
    private readonly numThreads: number = 2,
  ) {}

  private ensureRecognizer(): void {
    if (this.recognizer) return;
    if (this.model.kind === "online") {
      this.recognizer = new this.sherpa.OnlineRecognizer(
        buildOnlineConfig(this.model, this.modelsDir, this.numThreads),
      );
    } else {
      this.recognizer = new this.sherpa.OfflineRecognizer(
        buildOfflineConfig(this.model, this.modelsDir, this.numThreads),
      );
    }
  }

  recognize(samples: Float32Array, sampleRate: number): string {
    if (samples.length === 0) return "";
    this.ensureRecognizer();
    if (this.model.kind === "online") {
      const r = this.recognizer as OnlineRecognizer;
      const stream = r.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      stream.acceptWaveform({ samples: new Float32Array(sampleRate * 0.4), sampleRate });
      while (r.isReady(stream)) r.decode(stream);
      return r.getResult(stream).text;
    }
    const r = this.recognizer as OfflineRecognizer;
    const stream = r.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    r.decode(stream);
    const raw = r.getResult(stream).text;
    if (isHallucination(raw)) return "";
    return stripRepetitionLoop(raw);
  }
}

// --- Audio utilities ---

function int16ToFloat32(buf: Buffer): Float32Array {
  const result = new Float32Array(buf.length / 2);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < result.length; i++) {
    result[i] = view.getInt16(i * 2, true) / 32768;
  }
  return result;
}

function rmsFloat32(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s !== undefined) sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

function concatFloat32(arrays: Float32Array[]): Float32Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Float32Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// --- Streaming recorder ---

interface StreamingRecorder {
  stop(): void;
}

/** Spawn ffmpeg/arecord with PCM output piped to stdout for chunk-based capture. */
function startStreamingRecorder(
  source: string,
  deps: RecorderDeps,
  onChunk: (samples: Float32Array, rms: number) => void,
): StreamingRecorder | null {
  let cmd: string | null = null;
  let args: string[] = [];
  if (deps.hasFfmpeg) {
    cmd = "ffmpeg";
    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "pulse",
      "-i",
      source,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "-",
    ];
  } else if (deps.hasArecord) {
    cmd = "arecord";
    args = [
      "-q",
      "-D",
      source,
      "-f",
      "S16_LE",
      "-r",
      String(SAMPLE_RATE),
      "-c",
      "1",
      "-t",
      "raw",
      "-",
    ];
  }
  if (!cmd) return null;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout?.on("data", (buf: Buffer) => {
    if (buf.length < 2) return;
    const samples = int16ToFloat32(buf);
    onChunk(samples, rmsFloat32(samples));
  });
  return {
    stop(): void {
      child.kill("SIGKILL");
    },
  };
}

// --- Voice overlay state + component ---

interface VoiceOverlayState {
  committed: string;
  partial: string;
  level: number;
  elapsedSec: number;
  modelId: string;
  status: string;
}

interface OverlayComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
}

function createVoiceOverlay(
  theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
  state: VoiceOverlayState,
  onCommit: () => void,
  onCancel: () => void,
): OverlayComponent {
  return {
    render(width: number): string[] {
      const w = Math.max(40, width);
      const inner = Math.max(1, w - 2);
      const out: string[] = [];
      // pad to inner width, using visibleWidth so ANSI codes and wide chars don't skew it
      const bar = (s: string): string => {
        const vw = visibleWidth(s);
        const pad = Math.max(0, inner - vw);
        const trunc = vw > inner ? s.slice(0, inner) : s;
        return `│${trunc}${" ".repeat(pad)}│`;
      };
      out.push(`┌${"─".repeat(inner)}┐`);
      out.push(bar(`${theme.fg("accent", theme.bold("VOICE"))} ${theme.fg("dim", state.modelId)}`));
      const filled = Math.min(30, Math.round(state.level * 30));
      const eq = "\u2593".repeat(filled) + "\u2591".repeat(Math.max(0, 30 - filled));
      out.push(
        bar(`${theme.fg("accent", eq)} ${state.elapsedSec}s ${theme.fg("dim", state.status)}`),
      );
      out.push(bar(""));
      const lines: string[] = [];
      if (state.committed) {
        for (const chunk of state.committed.split(/(?<=\.)\s+/)) {
          lines.push(theme.fg("text", chunk));
        }
      }
      if (state.partial) {
        lines.push(theme.fg("dim", state.partial));
      }
      if (lines.length === 0) {
        lines.push(theme.fg("dim", "Listening..."));
      }
      const maxLines = 5;
      const visible = lines.slice(-maxLines);
      for (const line of visible) {
        for (const wrapped of wrapAnsi(line, inner)) {
          out.push(bar(wrapped));
        }
      }
      const padCount = Math.max(0, 2 - visible.length);
      for (let i = 0; i < padCount; i++) out.push(bar(""));
      out.push(bar(theme.fg("dim", "enter: paste  ctrl+x: cancel")));
      out.push(`└${"─".repeat(inner)}┘`);
      return out;
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (matchesKey(data, "enter") || matchesKey(data, "return")) onCommit();
      else if (
        matchesKey(data, "ctrl+x") ||
        matchesKey(data, "ctrl+c") ||
        matchesKey(data, "escape")
      )
        onCancel();
    },
  };
}

/** Word-wrap text that may contain ANSI codes, preserving visual width. */
function wrapAnsi(text: string, width: number): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= width) return [text];
  // Find the ANSI prefix/suffix so we can re-apply colors on each wrapped line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching
  const prefixMatch = text.match(/^(\x1b\[[0-9;]*m)*/);
  const prefix = prefixMatch ? (prefixMatch[0] ?? "") : "";
  const reset = "\x1b[0m";
  const body = stripped;
  const out: string[] = [];
  let current = "";
  for (const word of body.split(/\s+/)) {
    if (word.length === 0) continue;
    if (`${current} ${word}`.trim().length > width) {
      if (current.trim()) out.push(`${prefix}${current.trim()}${reset}`);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current.trim()) out.push(`${prefix}${current.trim()}${reset}`);
  return out;
}

// --- Streaming voice command (overlay with live transcript) ---

const PARTIAL_INTERVAL_MS = 2000;
const PARTIAL_MIN_SAMPLES = SAMPLE_RATE / 2; // 0.5s

async function runVoiceOverlay(
  _args: string,
  ctx: ExtensionContext,
  opts?: {
    modelsDir?: string;
    sherpa?: SherpaOnnx;
    recorder?: RecorderDeps;
    source?: string;
    stt?: SttEngine;
    activeModelId?: string;
  },
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Voice needs an interactive terminal.", "error");
    return;
  }
  const modelsDir = opts?.modelsDir ?? resolveModelsDir(process.env);
  const modelId = opts?.activeModelId ?? DEFAULT_MODEL_ID;
  const model = getModel(modelId);
  if (!model || !modelIsDownloaded(modelsDir, model)) {
    ctx.ui.notify(
      `Model "${modelId}" not found in ${modelsDir}. Run /voice-info for download instructions.`,
      "error",
    );
    return;
  }
  const source = opts?.source ?? resolveSource(process.env);
  const recorder = opts?.recorder ?? detectRecorders();
  const sherpa = opts?.sherpa ?? loadSherpa();
  const stt = opts?.stt ?? new SttEngine(sherpa, model, modelsDir, 2);
  const vadPath = resolveVadModel(modelsDir);

  const state: VoiceOverlayState = {
    committed: "",
    partial: "",
    level: 0,
    elapsedSec: 0,
    modelId,
    status: "listening",
  };

  let partialBuffer: Float32Array[] = [];
  let partialInFlight = false;
  let active = true;
  let vadInstance: VadInstance | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let partialTimer: ReturnType<typeof setInterval> | null = null;
  const startMs = Date.now();

  if (vadPath) {
    vadInstance = new sherpa.Vad(
      {
        sileroVad: {
          model: vadPath,
          threshold: VAD_SPEECH_THRESHOLD,
          minSilenceDuration: VAD_SILENCE_DURATION,
          minSpeechDuration: VAD_SPEECH_DURATION,
          windowSize: VAD_WINDOW_SIZE,
          maxSpeechDuration: VAD_MAX_SPEECH_DURATION,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      60,
    );
  }

  const rec = startStreamingRecorder(source, recorder, (samples, rms) => {
    if (!active) return;
    state.level = Math.min(1, rms * 4);
    partialBuffer.push(samples);
    if (vadInstance) {
      vadInstance.acceptWaveform(samples);
      while (!vadInstance.isEmpty()) {
        const seg = vadInstance.front();
        vadInstance.pop();
        const text = stt.recognize(seg.samples, SAMPLE_RATE);
        if (text.trim()) {
          state.committed = state.committed ? `${state.committed} ${text}` : text;
        }
        partialBuffer = [];
      }
    }
  });

  if (!rec) {
    ctx.ui.notify("No audio recorder found. Install ffmpeg or alsa-utils.", "error");
    return;
  }

  elapsedTimer = setInterval(() => {
    if (!active) return;
    state.elapsedSec = Math.floor((Date.now() - startMs) / 1000);
  }, 500);

  partialTimer = setInterval(() => {
    if (!active || partialInFlight || partialBuffer.length === 0) return;
    const snapshot = concatFloat32(partialBuffer);
    if (snapshot.length < PARTIAL_MIN_SAMPLES) return;
    partialInFlight = true;
    try {
      const text = stt.recognize(snapshot, SAMPLE_RATE);
      partialInFlight = false;
      if (!active) return;
      state.partial = text.trim();
    } catch {
      partialInFlight = false;
    }
  }, PARTIAL_INTERVAL_MS);

  const cleanup = (): void => {
    active = false;
    rec?.stop();
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (partialTimer) clearInterval(partialTimer);
  };

  let pendingDone: ((result: string | null) => void) | null = null;

  const handleCommit = (): void => {
    if (!active || !pendingDone) return;
    state.status = "finalizing…";
    if (vadInstance) {
      vadInstance.flush();
      while (!vadInstance.isEmpty()) {
        const seg = vadInstance.front();
        vadInstance.pop();
        const text = stt.recognize(seg.samples, SAMPLE_RATE);
        if (text.trim()) state.committed = state.committed ? `${state.committed} ${text}` : text;
      }
    }
    if (partialBuffer.length > 0) {
      const remaining = concatFloat32(partialBuffer);
      if (remaining.length >= PARTIAL_MIN_SAMPLES) {
        const text = stt.recognize(remaining, SAMPLE_RATE);
        if (text.trim()) state.committed = state.committed ? `${state.committed} ${text}` : text;
      }
    }
    if (pendingDone) {
      const d = pendingDone;
      pendingDone = null;
      cleanup();
      d(state.committed || null);
    }
  };

  const handleCancel = (): void => {
    if (!active || !pendingDone) return;
    const d = pendingDone;
    pendingDone = null;
    cleanup();
    d(null);
  };

  let renderInterval: ReturnType<typeof setInterval> | null = null;
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    pendingDone = done;
    const component = createVoiceOverlay(
      theme as {
        fg: (c: string, t: string) => string;
        bold: (t: string) => string;
      },
      state,
      handleCommit,
      handleCancel,
    );
    const tt = tui as { requestRender: () => void };
    renderInterval = setInterval(() => tt.requestRender(), 200);
    return {
      ...component,
      dispose: () => {
        if (renderInterval) clearInterval(renderInterval);
      },
    };
  });

  if (renderInterval) clearInterval(renderInterval);
  cleanup();
  if (result) ctx.ui.pasteToEditor(result);
}

// --- Command handlers ---

async function summarizeForSpeech(
  text: string,
  ctx: ExtensionCommandContext,
  modelRef: SummaryModelRef,
): Promise<string> {
  const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
  if (!model) throw new Error(`Summary model not found: ${modelRef.provider}/${modelRef.id}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) {
    throw new Error(`No credentials for summary model: ${modelRef.provider}/${modelRef.id}`);
  }
  const completionOptions: {
    apiKey: string;
    headers?: Record<string, string>;
    maxTokens: number;
  } = {
    apiKey: auth.apiKey,
    maxTokens: 160,
  };
  if (auth.headers) completionOptions.headers = auth.headers;
  const response = await completeSimple(
    model,
    {
      systemPrompt: "You write short, accurate spoken summaries of coding-agent responses.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildSpokenSummaryPrompt(text) }],
          timestamp: Date.now(),
        },
      ],
    },
    completionOptions,
  );
  const summary = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  const cleaned = cleanTextForSpeech(summary);
  if (!cleaned) throw new Error("Summary model returned no text.");
  return cleaned;
}

async function runVoiceSpeak(
  args: string,
  ctx: ExtensionCommandContext,
  opts: {
    modelsDir?: string;
    summarize: (text: string, ctx: ExtensionCommandContext) => Promise<string>;
    speak: (text: string, speakerId: number) => Promise<void>;
    speakerId: number;
  },
): Promise<void> {
  const source = findLatestAssistantText(ctx.sessionManager.getBranch());
  if (!source) {
    ctx.ui.notify("No assistant message to speak.", "warning");
    return;
  }
  const modelsDir = opts.modelsDir ?? resolveModelsDir(process.env);
  const ttsModel = TTS_MODELS.find((model) => model.id === DEFAULT_TTS_MODEL_ID);
  if (!ttsModel || !modelIsDownloaded(modelsDir, ttsModel)) {
    ctx.ui.notify(
      `Kitten Nano TTS is not downloaded in ${modelsDir}. Run /voice-info for instructions.`,
      "error",
    );
    return;
  }

  ctx.ui.setStatus(TTS_STATUS_KEY, "preparing speech…");
  try {
    const full = args.trim().toLowerCase() === "full";
    const spokenText = full
      ? cleanTextForSpeech(source)
      : cleanTextForSpeech(await opts.summarize(source, ctx));
    if (!spokenText) {
      ctx.ui.notify("The assistant message has no speakable text.", "warning");
      return;
    }
    ctx.ui.setStatus(TTS_STATUS_KEY, "speaking…");
    await opts.speak(spokenText, opts.speakerId);
  } catch (error) {
    ctx.ui.notify(
      `Voice playback failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    ctx.ui.setStatus(TTS_STATUS_KEY, undefined);
  }
}

async function runVoiceModels(
  _args: string,
  ctx: ExtensionCommandContext,
  opts?: {
    modelsDir?: string;
    activeModelId?: string;
    onSelect?: (modelId: string) => void;
  },
): Promise<void> {
  const modelsDir = opts?.modelsDir ?? resolveModelsDir(process.env);
  const activeModelId = opts?.activeModelId ?? DEFAULT_MODEL_ID;
  const options = MODELS.map((model) => {
    const active = model.id === activeModelId ? " (active)" : "";
    const status = modelIsDownloaded(modelsDir, model) ? "ready" : "missing";
    return `${model.id}${active} [${status}] — ${model.description}`;
  });
  const selected = await ctx.ui.select("Select voice model", options);
  if (!selected) return;

  const selectedIndex = options.indexOf(selected);
  const model = selectedIndex >= 0 ? MODELS[selectedIndex] : undefined;
  if (!model) return;
  if (!modelIsDownloaded(modelsDir, model)) {
    ctx.ui.notify(
      `Model "${model.id}" is not downloaded. Run /voice-info for instructions.`,
      "error",
    );
    return;
  }

  opts?.onSelect?.(model.id);
  ctx.ui.notify(`Voice model set to ${model.id}.`, "info");
}

async function runVoiceInfo(
  _args: string,
  ctx: ExtensionCommandContext,
  opts?: { modelsDir?: string; source?: string; sources?: SourceInfo[] },
): Promise<void> {
  const modelsDir = opts?.modelsDir ?? resolveModelsDir(process.env);
  const currentSource = opts?.source ?? resolveSource(process.env);
  const sources = opts?.sources ?? listSources();
  const lines = [
    `Models directory: ${modelsDir}`,
    "",
    "Model downloads:",
    `  mkdir -p "${modelsDir}" && cd "${modelsDir}"`,
  ];

  for (const model of [...MODELS, ...TTS_MODELS]) {
    const archive = model.downloadUrl.split("/").at(-1);
    const status = modelIsDownloaded(modelsDir, model) ? "ready" : "missing";
    lines.push("", `  # ${model.id} [${status}]`, `  wget ${model.downloadUrl}`);
    if (archive) lines.push(`  tar xf ${archive} && rm ${archive}`);
  }
  lines.push(
    "",
    "  # Silero VAD (recommended)",
    `  wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${VAD_MODEL_FILE}`,
    "",
    `Current source: ${currentSource}`,
    "Audio sources:",
  );

  if (sources.length === 0) {
    lines.push("  No PipeWire/PulseAudio sources found. Install pactl and check the audio setup.");
  } else {
    for (const source of sources) {
      const mark = source.name === currentSource ? "*" : " ";
      lines.push(`  ${mark} ${source.name} (${source.description})`);
    }
  }
  lines.push("", `Set the source with: export ${SOURCE_ENV_VAR}=<name>`);
  ctx.ui.notify(lines.join("\n"), "info");
}

// --- Default export ---

export default async function voiceExtension(pi: ExtensionAPI) {
  let activeModelId = DEFAULT_MODEL_ID;
  let activeSpeakerId = 0;
  let summaryModelRef: SummaryModelRef = {
    provider: DEFAULT_SUMMARY_PROVIDER,
    id: DEFAULT_SUMMARY_MODEL_ID,
  };
  let speechJob: SpeechJob | null = null;
  let ttsSherpa: (SherpaOnnx & TtsSherpa) | null = null;
  let ttsEnginePromise: Promise<OfflineTtsInstance> | null = null;
  let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

  async function getTtsEngine(
    model: TtsModelDef,
    modelsDir: string,
  ): Promise<{ sherpa: SherpaOnnx & TtsSherpa; engine: OfflineTtsInstance }> {
    ttsSherpa ??= loadSherpa() as SherpaOnnx & TtsSherpa;
    ttsEnginePromise ??= ttsSherpa.OfflineTts.createAsync(buildKittenConfig(model, modelsDir, 4));
    try {
      return { sherpa: ttsSherpa, engine: await ttsEnginePromise };
    } catch (error) {
      ttsEnginePromise = null;
      throw error;
    }
  }
  let holdEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let holdEditorInstalled = false;
  let editorRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalInputUnsubscribe: (() => void) | null = null;
  let terminalHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalRepeatCount = 0;
  let voiceOpen = false;

  const openVoice = (ctx: ExtensionContext): void => {
    if (voiceOpen) return;
    voiceOpen = true;
    void runVoiceOverlay("", ctx, { activeModelId })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Voice failed: ${message}`, "error");
      })
      .finally(() => {
        voiceOpen = false;
      });
  };

  const resetTerminalRepeat = (): void => {
    if (terminalHoldTimer) clearTimeout(terminalHoldTimer);
    if (terminalReleaseTimer) clearTimeout(terminalReleaseTimer);
    terminalHoldTimer = null;
    terminalReleaseTimer = null;
    terminalRepeatCount = 0;
  };

  const removeHeldSpaces = (ctx: ExtensionContext): void => {
    const text = ctx.ui.getEditorText();
    let removeCount = 0;
    while (removeCount < terminalRepeatCount && text[text.length - removeCount - 1] === " ") {
      removeCount++;
    }
    if (removeCount > 0) ctx.ui.setEditorText(text.slice(0, -removeCount));
  };

  const triggerTerminalVoice = (ctx: ExtensionContext): void => {
    removeHeldSpaces(ctx);
    resetTerminalRepeat();
    openVoice(ctx);
  };

  const scheduleTerminalHold = (ctx: ExtensionContext, minimumEvents: number): void => {
    if (terminalHoldTimer) return;
    terminalHoldTimer = setTimeout(() => {
      terminalHoldTimer = null;
      if (terminalRepeatCount >= minimumEvents) triggerTerminalVoice(ctx);
      else resetTerminalRepeat();
    }, HOLD_TO_VOICE_MS);
  };

  const installTerminalHold = (ctx: ExtensionContext): void => {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      const space = data === " " || matchesKey(data, Key.space);
      const release = isKeyRelease(data);
      const repeat = isKeyRepeat(data);
      if (voiceOpen) return;
      if (isKittyProtocolActive()) {
        if (!space) return;
        if (release) {
          if (terminalReleaseTimer) clearTimeout(terminalReleaseTimer);
          terminalReleaseTimer = setTimeout(() => {
            terminalReleaseTimer = null;
            resetTerminalRepeat();
          }, HOLD_RELEASE_DEBOUNCE_MS);
          return;
        }
        if (repeat) return;
        if (terminalReleaseTimer) {
          clearTimeout(terminalReleaseTimer);
          terminalReleaseTimer = null;
          terminalRepeatCount++;
        } else {
          terminalRepeatCount = 1;
        }
        scheduleTerminalHold(ctx, 1);
        return;
      }

      if (!space) {
        const codePoint = data.length === 1 ? data.codePointAt(0) : undefined;
        const userInput =
          data === "\r" ||
          data === "\n" ||
          data === "\x7f" ||
          (codePoint !== undefined && codePoint >= 32);
        if (userInput) resetTerminalRepeat();
        return;
      }
      terminalRepeatCount++;
      scheduleTerminalHold(ctx, 2);
      return;
    });
  };

  const installHoldEditor = (ctx: ExtensionContext): void => {
    previousEditorFactory = ctx.ui.getEditorComponent();
    holdEditorFactory = (
      tui: ConstructorParameters<typeof CustomEditor>[0],
      theme: ConstructorParameters<typeof CustomEditor>[1],
      keybindings: ConstructorParameters<typeof CustomEditor>[2],
    ) => {
      const editor =
        previousEditorFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      return addHoldToVoice(editor, () => openVoice(ctx));
    };
    ctx.ui.setEditorComponent(holdEditorFactory);
    holdEditorInstalled = true;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || holdEditorInstalled) return;
    installTerminalHold(ctx);
    installHoldEditor(ctx);
    editorRecheckTimer = setTimeout(() => {
      editorRecheckTimer = null;
      if (ctx.ui.getEditorComponent() !== holdEditorFactory) installHoldEditor(ctx);
    }, 0);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (speechJob) stopSpeechJob(speechJob);
    speechJob = null;
    if (editorRecheckTimer) clearTimeout(editorRecheckTimer);
    editorRecheckTimer = null;
    resetTerminalRepeat();
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    if (!holdEditorInstalled) return;
    if (ctx.ui.getEditorComponent() === holdEditorFactory) {
      ctx.ui.setEditorComponent(previousEditorFactory);
    }
    holdEditorInstalled = false;
  });

  pi.registerCommand("voice", {
    description: "Open the voice dictation overlay with live transcript",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await runVoiceOverlay(args, ctx, { activeModelId });
    },
  });

  pi.registerCommand("voice-models", {
    description: "Select the active local voice model",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await runVoiceModels(args, ctx, {
        activeModelId,
        onSelect: (modelId) => {
          activeModelId = modelId;
        },
      });
    },
  });

  pi.registerCommand("voice-info", {
    description: "Show voice model downloads and audio device information",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await runVoiceInfo(args, ctx);
    },
  });

  pi.registerCommand("voice-speak", {
    description: "Summarize and locally speak the latest assistant message",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (speechJob) stopSpeechJob(speechJob);
      const job = createSpeechJob();
      speechJob = job;
      const modelsDir = resolveModelsDir(process.env);
      const ttsModel = TTS_MODELS.find((model) => model.id === DEFAULT_TTS_MODEL_ID);
      void runVoiceSpeak(args, ctx, {
        modelsDir,
        speakerId: activeSpeakerId,
        summarize: (text, commandCtx) => summarizeForSpeech(text, commandCtx, summaryModelRef),
        speak: async (text, speakerId) => {
          if (!ttsModel) throw new Error("Kitten Nano TTS model is not configured.");
          const { sherpa, engine } = await getTtsEngine(ttsModel, modelsDir);
          await playKittenSpeech(sherpa, engine, text, speakerId, job);
        },
      }).finally(() => {
        if (speechJob === job) speechJob = null;
      });
    },
  });

  pi.registerCommand("voice-stop", {
    description: "Stop local voice generation or playback",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!speechJob) {
        ctx.ui.notify("No voice playback is active.", "info");
        return;
      }
      stopSpeechJob(speechJob);
      speechJob = null;
      ctx.ui.setStatus(TTS_STATUS_KEY, undefined);
      ctx.ui.notify("Voice playback stopped.", "info");
    },
  });

  pi.registerCommand("voice-voices", {
    description: "Select the local Kitten TTS voice",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const options = KITTEN_VOICES.map(
        (voice, index) => `${voice}${index === activeSpeakerId ? " (active)" : ""}`,
      );
      const selected = await ctx.ui.select("Select local voice", options);
      if (!selected) return;
      const selectedIndex = options.indexOf(selected);
      if (selectedIndex < 0) return;
      activeSpeakerId = selectedIndex;
      ctx.ui.notify(`Local voice set to ${KITTEN_VOICES[activeSpeakerId]}.`, "info");
    },
  });

  pi.registerCommand("voice-summary-model", {
    description: "Select the cloud model used for spoken summaries",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const models = ctx.modelRegistry
        .getAvailable()
        .filter((model) => model.input.includes("text"))
        .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
      const options = models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        const active =
          model.provider === summaryModelRef.provider && model.id === summaryModelRef.id;
        return `${key}${active ? " (active)" : ""}`;
      });
      const selected = await ctx.ui.select("Select summary model", options);
      if (!selected) return;
      const selectedIndex = options.indexOf(selected);
      const model = selectedIndex >= 0 ? models[selectedIndex] : undefined;
      if (!model?.provider) return;
      summaryModelRef = { provider: model.provider, id: model.id };
      ctx.ui.notify(`Summary model set to ${model.provider}/${model.id}.`, "info");
    },
  });
}

// --- Exported for tests ---

export {
  addHoldToVoice,
  buildKittenConfig,
  buildOfflineConfig,
  buildOnlineConfig,
  buildSpokenSummaryPrompt,
  cleanTextForSpeech,
  findLatestAssistantText,
  getModel,
  isHallucination,
  listSources,
  MODELS,
  modelDirPath,
  modelIsDownloaded,
  parseSourcesListing,
  resolveModelsDir,
  resolveSource,
  resolveVadModel,
  runVoiceInfo,
  runVoiceModels,
  runVoiceOverlay,
  runVoiceSpeak,
  SttEngine,
  stripRepetitionLoop,
  summarizeForSpeech,
  TTS_MODELS,
  transcribeFile,
  transcribeSegment,
  vadSegment,
};
