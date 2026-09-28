import { existsSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE } from "./constants.ts";
import type { ModelDef, TtsModelDef } from "./types.ts";

// --- Model registry ---

export const TTS_MODELS: TtsModelDef[] = [
  {
    id: "kitten-nano-en-v0_8-int8",
    backend: "kitten",
    dirName: "kitten-nano-en-v0_8-int8",
    displayName: "Kitten Nano",
    description: "Kitten Nano v0.8 English int8 with eight local voices.",
    files: ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    modelFile: "model.int8.onnx",
    speakerCount: 8,
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2",
  },
  {
    id: "supertonic-3-int8",
    backend: "supertonic",
    dirName: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
    displayName: "Supertonic 3",
    description: "Supertonic 3 English int8 with ten local voices.",
    files: [
      "duration_predictor.int8.onnx",
      "text_encoder.int8.onnx",
      "vector_estimator.int8.onnx",
      "vocoder.int8.onnx",
      "tts.json",
      "unicode_indexer.bin",
      "voice.bin",
    ],
    speakerCount: 10,
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
  },
  {
    id: "inflect-nano-v2-onnx",
    backend: "inflect",
    dirName: "inflect-nano-v2-onnx",
    displayName: "Inflect Nano v2",
    description: "Inflect Nano v2, 3.96M parameters with one fixed English voice.",
    files: ["duration.onnx", "decode.onnx"],
    repository: "owensong/Inflect-Nano-v2-ONNX",
  },
  {
    id: "inflect-micro-v2-onnx",
    backend: "inflect",
    dirName: "inflect-micro-v2-onnx",
    displayName: "Inflect Micro v2",
    description: "Inflect Micro v2, 9.36M parameters with one fixed English voice.",
    files: ["duration.onnx", "decode.onnx"],
    repository: "owensong/Inflect-Micro-v2-ONNX",
  },
];

export const MODELS: ModelDef[] = [
  {
    id: "moonshine-v2-base-en",
    kind: "offline",
    family: "moonshine-v2",
    dirName: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
    displayName: "Moonshine v2 Base",
    description:
      "Moonshine v2 Base (English), int8. Newer and more accurate than v1, with punctuation.",
    files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
  },
  {
    id: "moonshine-v2-tiny-en",
    kind: "offline",
    family: "moonshine-v2",
    dirName: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27",
    displayName: "Moonshine v2 Tiny",
    description: "Moonshine v2 Tiny (English), int8. Fastest option with v2 accuracy.",
    files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
  },
  {
    id: "parakeet-tdt-0.6b-v2-int8",
    kind: "offline",
    family: "parakeet",
    dirName: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    displayName: "Parakeet TDT 0.6B v2",
    description:
      "NVIDIA Parakeet TDT 0.6B v2 (English), int8. Highest accuracy, with punctuation. Large download.",
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
  },
  {
    id: "moonshine-base-int8",
    kind: "offline",
    family: "moonshine",
    dirName: "sherpa-onnx-moonshine-base-en-int8",
    displayName: "Moonshine Base",
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
    displayName: "Whisper Tiny",
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
    displayName: "Whisper Small",
    description: "Whisper Small (English), int8. More accurate, with slower CPU transcription.",
    files: ["small.en-encoder.int8.onnx", "small.en-decoder.int8.onnx", "small.en-tokens.txt"],
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2",
  },
];

export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelDirPath(modelsDir: string, model: ModelDef | TtsModelDef): string {
  return join(modelsDir, model.dirName);
}

/** True when every file the model needs is present in its directory. */
export function modelIsDownloaded(modelsDir: string, model: ModelDef | TtsModelDef): boolean {
  const dir = modelDirPath(modelsDir, model);
  return model.files.every((file) => existsSync(join(dir, file)));
}

export function buildKittenConfig(
  model: TtsModelDef,
  modelsDir: string,
  numThreads: number,
): unknown {
  const dir = modelDirPath(modelsDir, model);
  const modelFile = model.modelFile ?? "model.fp16.onnx";
  return {
    model: {
      kitten: {
        model: join(dir, modelFile),
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

export function buildSupertonicConfig(
  model: TtsModelDef,
  modelsDir: string,
  numThreads: number,
): unknown {
  const dir = modelDirPath(modelsDir, model);
  return {
    model: {
      supertonic: {
        durationPredictor: join(dir, "duration_predictor.int8.onnx"),
        textEncoder: join(dir, "text_encoder.int8.onnx"),
        vectorEstimator: join(dir, "vector_estimator.int8.onnx"),
        vocoder: join(dir, "vocoder.int8.onnx"),
        ttsJson: join(dir, "tts.json"),
        unicodeIndexer: join(dir, "unicode_indexer.bin"),
        voiceStyle: join(dir, "voice.bin"),
      },
      numThreads,
      provider: "cpu",
      debug: 0,
    },
  };
}

/** Build the sherpa TTS config for any sherpa-backed model (kitten or supertonic). */
export function buildTtsConfig(model: TtsModelDef, modelsDir: string, numThreads: number): unknown {
  if (model.backend === "supertonic") return buildSupertonicConfig(model, modelsDir, numThreads);
  return buildKittenConfig(model, modelsDir, numThreads);
}

/** Build the config object for an OnlineRecognizer (streaming transducer). */
export function buildOnlineConfig(model: ModelDef, modelsDir: string, numThreads: number): unknown {
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

/** Build the config object for an OfflineRecognizer (Whisper, Moonshine, or Parakeet). */
export function buildOfflineConfig(
  model: ModelDef,
  modelsDir: string,
  numThreads: number,
): unknown {
  const dir = modelDirPath(modelsDir, model);
  const isInt8 = model.id.endsWith("-int8");
  const suffix = isInt8 ? ".int8" : "";
  if (model.family === "moonshine-v2") {
    // v2 exports merge the decoder into one file and drop the standalone
    // preprocessor; the encoder consumes raw features directly.
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: {
          encoder: join(dir, "encoder_model.ort"),
          mergedDecoder: join(dir, "decoder_model_merged.ort"),
        },
        tokens: join(dir, "tokens.txt"),
        numThreads,
        provider: "cpu",
        debug: 0,
      },
    };
  }
  if (model.family === "parakeet") {
    // NeMo Parakeet TDT exports use the generic transducer config with a
    // modelType hint so sherpa-onnx applies the correct decoder.
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, "encoder.int8.onnx"),
          decoder: join(dir, "decoder.int8.onnx"),
          joiner: join(dir, "joiner.int8.onnx"),
        },
        tokens: join(dir, "tokens.txt"),
        modelType: "nemo_transducer",
        numThreads,
        provider: "cpu",
        debug: 0,
      },
    };
  }
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
