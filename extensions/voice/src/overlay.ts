import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
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
import { maxDecodeSec, resolveVadModel, SttEngine } from "./transcription.ts";
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
      const w = Math.max(0, Math.floor(width));
      const inner = modalContentWidth(w);
      const out: string[] = [theme.fg("dim", state.modelId)];
      const filled = Math.min(30, Math.round(state.level * 30));
      const eq = "\u2593".repeat(filled) + "\u2591".repeat(Math.max(0, 30 - filled));
      out.push(`${theme.fg("accent", eq)} ${state.elapsedSec}s ${theme.fg("dim", state.status)}`);
      out.push("");
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
        for (const wrapped of wrapTextWithAnsi(line, inner)) {
          out.push(wrapped);
        }
      }
      const padCount = Math.max(0, 2 - visible.length);
      for (let i = 0; i < padCount; i++) out.push("");
      out.push(
        formatStyledKeyHints(theme, [
          ["enter", "paste"],
          ["esc", "cancel"],
        ]),
      );
      return renderModalFrame(theme, w, out, { title: "Voice" });
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
      `Model "${modelId}" not found in ${modelsDir}. Open /voice:settings or see the voice README for setup.`,
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
  // Set on the first partial decode failure: the user is warned once and the
  // overlay stops retrying, so a broken engine cannot spam the notification.
  // Committed text (Enter) still attempts a final transcription.
  let partialFailed = false;
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
          // Moonshine v2 needs short segments so no decode exceeds its length
          // cap; other models keep the default.
          maxSpeechDuration: maxDecodeSec(model) ?? VAD_MAX_SPEECH_DURATION,
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
    if (!active || partialFailed || partialInFlight || partialBuffer.length === 0) return;
    const snapshot = concatFloat32(partialBuffer);
    if (snapshot.length < PARTIAL_MIN_SAMPLES) return;
    partialInFlight = true;
    try {
      const text = stt.recognize(snapshot, SAMPLE_RATE);
      partialInFlight = false;
      if (!active) return;
      state.partial = text.trim();
    } catch (error) {
      partialInFlight = false;
      if (active && !partialFailed) {
        partialFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Voice live transcription failed: ${message}`, "warning");
      }
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
  let result: string | null;
  // The dialog promise can reject (terminal teardown, host shutdown). The
  // finally block still stops the recorder child process and every timer so
  // nothing outlives the overlay.
  try {
    result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
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
  } finally {
    if (renderInterval) clearInterval(renderInterval);
    cleanup();
  }

  if (result) ctx.ui.pasteToEditor(result);
}
