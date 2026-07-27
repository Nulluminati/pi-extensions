import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { concatFloat32 } from "./audio.ts";
import { modelDirPath } from "./models.ts";
import type { OnnxRuntime, OnnxSession, SpeechJob, TtsModelDef } from "./types.ts";

// --- Pure helpers ---

// Inflect v2's Apache-2.0 symbol inventory mirrors runtime/text/symbols.py.
const INFLECT_PUNCTUATION = ';:,.!?¡¿—…"«»“” ';

const INFLECT_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const INFLECT_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";

const INFLECT_SYMBOLS = ["_", ...INFLECT_PUNCTUATION, ...INFLECT_LETTERS, ...INFLECT_IPA];

const INFLECT_SYMBOL_TO_ID = new Map(INFLECT_SYMBOLS.map((symbol, index) => [symbol, index]));

function applyInflectPhonemeOverrides(text: string): string {
  return text
    .replaceAll("sˈæskɐtʃˌuːən", "sɐskˈætʃəwən")
    .replaceAll("flʊɹɹˈɛsənt", "flʊˈɹɛsənt")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildInflectPhonemeText(text: string, phonemize: (text: string) => string): string {
  const parts = text.split(/([,;:.!?])/);
  const phonemeParts: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const words = parts[index]?.trim();
    const punctuation = parts[index + 1] ?? "";
    if (words) phonemeParts.push(`${applyInflectPhonemeOverrides(phonemize(words))}${punctuation}`);
    else if (punctuation) phonemeParts.push(punctuation);
  }
  return phonemeParts.join(" ").trim();
}

export function inflectTextToTokens(phonemeText: string): number[] {
  const tokenIds: number[] = [];
  for (const symbol of phonemeText) {
    const id = INFLECT_SYMBOL_TO_ID.get(symbol);
    if (id !== undefined) tokenIds.push(id);
  }
  if (tokenIds.length === 0) throw new Error("Inflect frontend produced no speakable tokens.");
  const withBlanks = new Array<number>(tokenIds.length * 2 + 1).fill(0);
  for (let index = 0; index < tokenIds.length; index++) {
    withBlanks[index * 2 + 1] = tokenIds[index] ?? 0;
  }
  return withBlanks;
}

export function splitInflectText(text: string, limit = 280): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.split(/(?<=[.!?;:])\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let sentence of sentences.length > 0 ? sentences : [normalized]) {
    while (sentence.length > limit) {
      const search = sentence.slice(0, limit + 1);
      let punctuation = -1;
      for (const mark of [",", ";", ":"])
        punctuation = Math.max(punctuation, search.lastIndexOf(mark));
      let splitAt =
        punctuation >= Math.floor(limit / 2) ? punctuation + 1 : sentence.lastIndexOf(" ", limit);
      if (splitAt < Math.floor(limit / 2)) splitAt = limit;
      chunks.push(sentence.slice(0, splitAt).trim());
      sentence = sentence.slice(splitAt).trimStart();
    }
    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

function phonemizeInflectText(text: string): string {
  return execFileSync("espeak-ng", ["-q", "--ipa=2", "-v", "en-us", text], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
}

export function createInflectGaussianSamples(length: number, seedInput: number): Float32Array {
  let seed = seedInput;
  let spare: number | null = null;
  const random = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let radius = 0;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      radius = u * u + v * v;
    } while (radius >= 1 || radius === 0);
    const multiplier = Math.sqrt((-2 * Math.log(radius)) / radius);
    spare = v * multiplier;
    return u * multiplier;
  };
  return Float32Array.from({ length }, gaussian);
}

function inflectBoundaryPause(text: string): number {
  const ending = text.trim().slice(-1);
  const pauses: Record<string, number> = {
    "?": 0.28,
    "!": 0.24,
    ".": 0.22,
    ";": 0.16,
    ":": 0.13,
    ",": 0.09,
  };
  return pauses[ending] ?? 0.08;
}

function applyInflectEdgeFade(
  samples: Float32Array,
  sampleRate: number,
  milliseconds = 5,
): Float32Array {
  const frames = Math.min(
    Math.round((sampleRate * milliseconds) / 1000),
    Math.floor(samples.length / 2),
  );
  const output = Float32Array.from(samples);
  for (let index = 0; index < frames; index++) {
    const ramp = frames > 1 ? index / (frames - 1) : 1;
    output[index] = (output[index] ?? 0) * ramp;
    const endIndex = output.length - index - 1;
    output[endIndex] = (output[endIndex] ?? 0) * ramp;
  }
  return output;
}

export class InflectTtsEngine {
  readonly sampleRate = 24_000;

  private constructor(
    private readonly ort: OnnxRuntime,
    private readonly durationSession: OnnxSession,
    private readonly decodeSession: OnnxSession,
  ) {}

  static async create(
    ort: OnnxRuntime,
    model: TtsModelDef,
    modelsDir: string,
  ): Promise<InflectTtsEngine> {
    const dir = modelDirPath(modelsDir, model);
    const options = {
      executionProviders: ["cpu"],
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
    };
    const [durationSession, decodeSession] = await Promise.all([
      ort.InferenceSession.create(join(dir, "duration.onnx"), options),
      ort.InferenceSession.create(join(dir, "decode.onnx"), options),
    ]);
    return new InflectTtsEngine(ort, durationSession, decodeSession);
  }

  async generate(text: string, job: SpeechJob): Promise<Float32Array> {
    const chunks = splitInflectText(text);
    const pieces: Float32Array[] = [];
    for (let index = 0; index < chunks.length; index++) {
      if (job.cancelled) break;
      const chunk = chunks[index];
      if (!chunk) continue;
      if (index > 0) {
        const previous = chunks[index - 1] ?? "";
        pieces.push(new Float32Array(Math.round(this.sampleRate * inflectBoundaryPause(previous))));
      }
      pieces.push(await this.generateChunk(chunk, 7 + index));
    }
    return concatFloat32(pieces);
  }

  private async generateChunk(text: string, seed: number): Promise<Float32Array> {
    const phonemeText = buildInflectPhonemeText(text, phonemizeInflectText);
    const tokens = inflectTextToTokens(phonemeText);
    const tokenCount = tokens.length;
    const durationOutputs = await this.durationSession.run({
      tokens: new this.ort.Tensor(
        "int64",
        BigInt64Array.from(tokens, (token) => BigInt(token)),
        [1, tokenCount],
      ),
      lengths: new this.ort.Tensor("int64", BigInt64Array.of(BigInt(tokenCount)), [1]),
      length_scale: new this.ort.Tensor("float32", Float32Array.of(1), []),
    });
    const mean = durationOutputs.m_p_exp;
    const logs = durationOutputs.logs_p_exp;
    const mask = durationOutputs.y_mask;
    if (!mean || !logs || !mask)
      throw new Error("Inflect duration graph returned incomplete output.");

    const dimensions = [...mean.dims];
    const sampleCount = dimensions.reduce((total, value) => total * value, 1);
    const decodeOutputs = await this.decodeSession.run({
      m_p_exp: mean,
      logs_p_exp: logs,
      y_mask: mask,
      zp_noise: new this.ort.Tensor(
        "float32",
        createInflectGaussianSamples(sampleCount, seed),
        dimensions,
      ),
      noise_scale: new this.ort.Tensor("float32", Float32Array.of(0.667), []),
    });
    const waveform = decodeOutputs.waveform;
    if (!waveform || !(waveform.data instanceof Float32Array)) {
      throw new Error("Inflect decode graph returned no float32 waveform.");
    }
    return applyInflectEdgeFade(waveform.data, this.sampleRate);
  }
}
