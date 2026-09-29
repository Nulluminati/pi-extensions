import { execSync, spawn } from "node:child_process";
import { SAMPLE_RATE } from "./constants.ts";
import type { RecorderDeps } from "./types.ts";

export function encodePcm16Wave(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const wave = Buffer.alloc(44 + dataLength);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + dataLength, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wave.writeUInt16LE(bytesPerSample, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    wave.writeInt16LE(pcm, 44 + index * bytesPerSample);
  }
  return wave;
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

export function concatFloat32(arrays: Float32Array[]): Float32Array {
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

export interface RecorderCommand {
  cmd: string;
  args: string[];
}

/** Pick the capture backend for the platform. Linux captures through
 *  PulseAudio (ffmpeg) or ALSA (arecord); macOS has neither, so ffmpeg uses
 *  the avfoundation input and sox is the fallback. */
export function resolveRecorderCommand(source: string, deps: RecorderDeps): RecorderCommand | null {
  if (deps.hasFfmpeg) {
    if (process.platform === "darwin") {
      return {
        cmd: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "avfoundation",
          "-i",
          source,
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-f",
          "s16le",
          "-",
        ],
      };
    }
    return {
      cmd: "ffmpeg",
      args: [
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
      ],
    };
  }
  if (process.platform === "darwin" && deps.hasSox) {
    return {
      cmd: "sox",
      args: ["-d", "-t", "s16le", "-r", String(SAMPLE_RATE), "-c", "1", "-"],
    };
  }
  // arecord is Linux ALSA-only; alsa-utils does not exist on macOS.
  if (process.platform !== "darwin" && deps.hasArecord) {
    return {
      cmd: "arecord",
      args: [
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
      ],
    };
  }
  return null;
}

/** Spawn the platform's recorder with PCM output piped to stdout for
 *  chunk-based capture. `onFailure` reports spawn errors and early exits
 *  (with the stderr tail) so callers can surface them instead of hanging. */
export function startStreamingRecorder(
  source: string,
  deps: RecorderDeps,
  onChunk: (samples: Float32Array, rms: number) => void,
  onFailure?: (reason: string) => void,
): StreamingRecorder | null {
  const resolved = resolveRecorderCommand(source, deps);
  if (!resolved) return null;
  const { cmd, args } = resolved;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stopped = false;
  let stderrTail = "";
  child.stdout?.on("data", (buf: Buffer) => {
    if (buf.length < 2) return;
    const samples = int16ToFloat32(buf);
    onChunk(samples, rmsFloat32(samples));
  });
  child.stderr?.on("data", (buf: Buffer) => {
    // Keep a bounded tail so failure reports stay readable.
    stderrTail = `${stderrTail}${buf.toString("utf8")}`.slice(-400);
  });
  child.on("error", (error: Error) => {
    onFailure?.(error.message);
  });
  child.on("close", (code, signal) => {
    if (stopped) return;
    const exit = code === null ? `signal ${signal}` : `exit code ${code}`;
    onFailure?.(
      `Recorder ${cmd} stopped early (${exit}).${stderrTail ? ` ${stderrTail.trim()}` : ""}`,
    );
  });
  return {
    stop(): void {
      stopped = true;
      child.kill("SIGKILL");
    },
  };
}

export function detectRecorders(): RecorderDeps {
  return {
    hasFfmpeg: hasTool("ffmpeg"),
    hasArecord: hasTool("arecord"),
    hasSox: hasTool("sox"),
  };
}

export function hasTool(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
