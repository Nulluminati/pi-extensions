import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { concatFloat32, detectRecorders, startStreamingRecorder } from "./audio.ts";
import { resolveModelsDir, resolveSource } from "./config.ts";
import {
  DEFAULT_MODEL_ID,
  SAMPLE_RATE,
  VAD_MAX_SPEECH_DURATION,
  VAD_SILENCE_DURATION,
  VAD_SPEECH_DURATION,
  VAD_SPEECH_THRESHOLD,
  VAD_WINDOW_SIZE,
} from "./constants.ts";
import { getModel, modelIsDownloaded } from "./models.ts";
import { loadSherpa } from "./native.ts";
import { resolveVadModel, SttEngine } from "./transcription.ts";
import type { RecorderDeps, SherpaOnnx, VadInstance } from "./types.ts";

// --- Streaming voice command (overlay with live transcript) ---

const PARTIAL_INTERVAL_MS = 2000;

const PARTIAL_MIN_SAMPLES = SAMPLE_RATE / 2;

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

// 0.5s

export async function runVoiceOverlay(
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
      `Model "${modelId}" not found in ${modelsDir}. Open /voice or see the voice README for setup.`,
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
