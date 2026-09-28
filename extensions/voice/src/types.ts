import type { spawn } from "node:child_process";

// --- Types ---

export type ModelKind = "online" | "offline";

export type ModelFamily = "whisper" | "moonshine" | "moonshine-v2" | "parakeet";

export interface ModelDef {
  id: string;
  kind: ModelKind;
  family: ModelFamily;
  dirName: string;
  displayName: string;
  description: string;
  /** Files that must exist for the model to count as downloaded. */
  files: string[];
  downloadUrl: string;
  /** Whisper models are filed as <prefix>-encoder.onnx etc.; Moonshine uses fixed names. */
  filePrefix?: string;
}

export interface SherpaOnnx {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizer;
  OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
  readWave: (path: string) => { samples: Float32Array; sampleRate: number };
  writeWave: (path: string, wave: { samples: Float32Array; sampleRate: number }) => void;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => VadInstance;
}

export interface VadInstance {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}

export interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text: string };
}

export interface OnlineStream {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

export interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text: string };
}

export interface OfflineStream {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
}

export interface TtsSherpa {
  OfflineTts: {
    new (config: unknown): OfflineTtsInstance;
    createAsync(config: unknown): Promise<OfflineTtsInstance>;
  };
  GenerationConfig: new (config: unknown) => unknown;
  writeWave: (path: string, wave: { samples: Float32Array; sampleRate: number }) => void;
}

export interface OfflineTtsInstance {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(config: {
    text: string;
    enableExternalBuffer?: boolean;
    generationConfig?: unknown;
    onProgress?: (info: { samples: Float32Array; progress: number }) => boolean;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface OnnxTensor {
  data: unknown;
  dims: readonly number[];
}

export interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensor>>;
}

export interface OnnxRuntime {
  Tensor: new (
    type: "float32" | "int64",
    data: Float32Array | BigInt64Array,
    dimensions: readonly number[],
  ) => OnnxTensor;
  InferenceSession: {
    create(
      modelPath: string,
      options: {
        executionProviders: string[];
        intraOpNumThreads: number;
        interOpNumThreads: number;
      },
    ): Promise<OnnxSession>;
  };
}

export interface SpeechJob {
  cancelled: boolean;
  player: ReturnType<typeof spawn> | null;
}

export interface TranscribeResult {
  text: string;
  durationSec: number;
  elapsedSec: number;
  rtf: number;
  modelId: string;
}

export interface RecorderDeps {
  hasFfmpeg: boolean;
  hasArecord: boolean;
}

export type TtsBackend = "kitten" | "inflect" | "supertonic";

export interface TtsModelDef {
  id: string;
  backend: TtsBackend;
  dirName: string;
  description: string;
  files: string[];
  downloadUrl?: string;
  repository?: string;
  displayName: string;
  /** Kitten model file name; older exports use fp16, newer ones int8. */
  modelFile?: string;
  /** Number of selectable speakers; unset means the model has one fixed voice. */
  speakerCount?: number;
}
