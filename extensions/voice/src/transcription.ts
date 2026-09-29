import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MOONSHINE_V2_MAX_SEGMENT_SEC,
  VAD_MAX_SPEECH_DURATION,
  VAD_MODEL_FILE,
  VAD_SILENCE_DURATION,
  VAD_SPEECH_DURATION,
  VAD_SPEECH_THRESHOLD,
  VAD_WINDOW_SIZE,
} from "./constants.ts";
import { buildOfflineConfig, buildOnlineConfig } from "./models.ts";
import type {
  ModelDef,
  OfflineRecognizer,
  OnlineRecognizer,
  SherpaOnnx,
  TranscribeResult,
} from "./types.ts";

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
export function isHallucination(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (HALLUCINATION_PHRASES.has(normalized)) return true;
  if (isRepetitionLoop(normalized)) return true;
  return false;
}

/** Strip a trailing repetition loop, keeping the legitimate lead text and one instance of the repeated group. */
export function stripRepetitionLoop(text: string): string {
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

// --- Transcription (dependency-injected for testability) ---

/** Resolve the VAD model path. Returns undefined if not downloaded. */
export function resolveVadModel(modelsDir: string): string | undefined {
  const path = join(modelsDir, VAD_MODEL_FILE);
  return existsSync(path) ? path : undefined;
}

/**
 * Longest single decode the model supports, or undefined for no limit.
 * Moonshine v2 returns empty transcripts above ~9.2s (see constants), so its
 * audio must be decoded in shorter chunks.
 */
export function maxDecodeSec(model: ModelDef): number | undefined {
  return model.family === "moonshine-v2" ? MOONSHINE_V2_MAX_SEGMENT_SEC : undefined;
}

/** Split samples into at most maxSec-sized chunks; single chunk when short enough. */
export function splitSamples(
  samples: Float32Array,
  sampleRate: number,
  maxSec: number,
): Float32Array[] {
  const maxSamples = Math.floor(maxSec * sampleRate);
  if (samples.length <= maxSamples) return [samples];
  const chunks: Float32Array[] = [];
  for (let offset = 0; offset < samples.length; offset += maxSamples) {
    chunks.push(samples.subarray(offset, Math.min(offset + maxSamples, samples.length)));
  }
  return chunks;
}

/**
 * Decode samples with an offline recognizer in one pass, or in chunks at the
 * model's decode cap, applying the anti-loop filters to each decode result.
 * Shared by one-shot transcription and the cached streaming engine.
 */
function decodeOffline(
  recognizer: OfflineRecognizer,
  model: ModelDef,
  samples: Float32Array,
  sampleRate: number,
): string {
  const parts: string[] = [];
  const maxSec = maxDecodeSec(model);
  for (const chunk of maxSec ? splitSamples(samples, sampleRate, maxSec) : [samples]) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: chunk });
    recognizer.decode(stream);
    const raw = recognizer.getResult(stream).text;
    // Anti-loop layers (offline models only — online models don't loop):
    //   1. Drop the whole segment if it's a known Whisper filler/hallucination.
    //   2. Strip a trailing repetition loop, keeping the legitimate lead text.
    if (isHallucination(raw)) continue;
    const cleaned = stripRepetitionLoop(raw);
    if (cleaned.trim()) parts.push(cleaned.trim());
  }
  return parts.join(" ");
}

/** Segment audio into speech regions using silero VAD. Returns speech segments. */
export function vadSegment(
  sherpa: SherpaOnnx,
  vadModelPath: string,
  samples: Float32Array,
  sampleRate: number,
  maxSpeechDuration: number = VAD_MAX_SPEECH_DURATION,
): Float32Array[] {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModelPath,
        threshold: VAD_SPEECH_THRESHOLD,
        minSilenceDuration: VAD_SILENCE_DURATION,
        minSpeechDuration: VAD_SPEECH_DURATION,
        windowSize: VAD_WINDOW_SIZE,
        maxSpeechDuration,
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
export function transcribeSegment(
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
  return decodeOffline(recognizer, model, samples, sampleRate);
}

export function transcribeFile(
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
  // Moonshine v2 also needs short VAD segments so cuts land near pauses
  // instead of mid-word when the decode cap splits a long utterance.
  const vadMaxSpeech = maxDecodeSec(model) ?? VAD_MAX_SPEECH_DURATION;
  let text: string;
  if (vadModelPath) {
    const segments = vadSegment(sherpa, vadModelPath, wave.samples, wave.sampleRate, vadMaxSpeech);
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
export class SttEngine {
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
    return decodeOffline(r, this.model, samples, sampleRate);
  }
}
