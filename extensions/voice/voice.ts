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
 *   /voice:settings           Open voice settings.
 *   /voice:speak [full]       Summarize and speak the latest assistant message.
 *   /voice:stop               Stop current speech generation or playback.
 *
 * Models live in $PI_VOICE_MODELS (default ~/.cache/pi-voice/models).
 *
 * The sherpa-onnx-node addon is a native .node file, so it must be loaded with
 * require() rather than an ESM import. The repo validator inspects static and
 * dynamic imports but not require(), so createRequire is both the correct and
 * validator-safe way to load it.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
  removeEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import {
  loadActiveModelId,
  loadActiveSpeakerId,
  loadActiveTtsModelId,
  resolveModelsDir,
  resolveVoiceConfigPath,
  saveActiveModel,
  saveActiveTtsModel,
  saveActiveVoice,
} from "./src/config.ts";
import {
  HOLD_COOLDOWN_MS,
  HOLD_RELEASE_DEBOUNCE_MS,
  HOLD_REPEAT_GAP_MS,
  HOLD_TO_VOICE_MS,
  KITTEN_VOICES,
} from "./src/constants.ts";
import { addHoldToVoice } from "./src/hold.ts";
import type { InflectTtsEngine as InflectTtsEngineType } from "./src/inflect.ts";
import { InflectTtsEngine } from "./src/inflect.ts";
import { buildTtsConfig, modelDirPath, TTS_MODELS } from "./src/models.ts";
import { loadOnnxRuntime, loadSherpa } from "./src/native.ts";
import { runVoiceOverlay } from "./src/overlay.ts";
import {
  createSpeechJob,
  playInflectSpeech,
  playKittenSpeech,
  playSupertonicSpeech,
  stopSpeechJob,
} from "./src/playback.ts";
import { runVoiceSettings } from "./src/settings.ts";
import { runVoiceSpeak, setTtsIndicator, summarizeForSpeech } from "./src/summary.ts";
import type {
  OfflineTtsInstance,
  OnnxRuntime,
  SherpaOnnx,
  SpeechJob,
  TtsModelDef,
  TtsSherpa,
} from "./src/types.ts";

export { encodePcm16Wave } from "./src/audio.ts";
export { resolveModelsDir, resolveSource, resolveVoiceConfigPath } from "./src/config.ts";
export { addHoldToVoice } from "./src/hold.ts";
export {
  buildInflectPhonemeText,
  createInflectGaussianSamples,
  InflectTtsEngine,
  inflectTextToTokens,
  splitInflectText,
} from "./src/inflect.ts";
export {
  buildKittenConfig,
  buildOfflineConfig,
  buildOnlineConfig,
  buildSupertonicConfig,
  buildTtsConfig,
  getModel,
  MODELS,
  modelDirPath,
  modelIsDownloaded,
  TTS_MODELS,
} from "./src/models.ts";
export { runVoiceOverlay } from "./src/overlay.ts";
export { runVoiceSettings } from "./src/settings.ts";
export {
  buildSpokenSummaryPrompt,
  cleanTextForSpeech,
  findLatestAssistantText,
  runVoiceSpeak,
  summarizeForSpeech,
} from "./src/summary.ts";
export {
  isHallucination,
  resolveVadModel,
  SttEngine,
  stripRepetitionLoop,
  transcribeFile,
  transcribeSegment,
  vadSegment,
} from "./src/transcription.ts";

// --- Extension ---

export default async function voiceExtension(pi: ExtensionAPI) {
  const voiceConfigPath = resolveVoiceConfigPath(process.env);
  let activeModelId = loadActiveModelId(voiceConfigPath);
  let activeSpeakerId = loadActiveSpeakerId(voiceConfigPath);
  let activeTtsModelId = loadActiveTtsModelId(voiceConfigPath);
  let speechJob: SpeechJob | null = null;
  let ttsSherpa: (SherpaOnnx & TtsSherpa) | null = null;
  let ttsEnginePromise: Promise<OfflineTtsInstance> | null = null;
  let onnxRuntime: OnnxRuntime | null = null;
  const inflectEnginePromises = new Map<string, Promise<InflectTtsEngineType>>();

  async function getInflectEngine(
    model: TtsModelDef,
    modelsDir: string,
  ): Promise<InflectTtsEngineType> {
    onnxRuntime ??= loadOnnxRuntime();
    const key = modelDirPath(modelsDir, model);
    let enginePromise = inflectEnginePromises.get(key);
    if (!enginePromise) {
      enginePromise = InflectTtsEngine.create(onnxRuntime, model, modelsDir);
      inflectEnginePromises.set(key, enginePromise);
    }
    try {
      return await enginePromise;
    } catch (error) {
      inflectEnginePromises.delete(key);
      throw error;
    }
  }

  async function getTtsEngine(
    model: TtsModelDef,
    modelsDir: string,
  ): Promise<{ sherpa: SherpaOnnx & TtsSherpa; engine: OfflineTtsInstance }> {
    if (model.backend !== "kitten" && model.backend !== "supertonic") {
      throw new Error(`Model ${model.id} does not use the sherpa speech engine.`);
    }
    ttsSherpa ??= loadSherpa() as SherpaOnnx & TtsSherpa;
    ttsEnginePromise ??= ttsSherpa.OfflineTts.createAsync(buildTtsConfig(model, modelsDir, 4));
    try {
      return { sherpa: ttsSherpa, engine: await ttsEnginePromise };
    } catch (error) {
      ttsEnginePromise = null;
      throw error;
    }
  }
  const holdEditorLayerId = "voice-hold";
  let holdEditorInstalled = false;
  let editorRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalInputUnsubscribe: (() => void) | null = null;
  let terminalHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalRepeatCount = 0;
  let voiceOpen = false;
  // True once a Space hold has opened the overlay, until the key is released.
  // Prevents the same hold from reopening the overlay after it closes. The
  // terminal input listener (which sees every keystroke) clears it on release.
  let spaceConsumed = false;
  let holdReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // Authoritative Space down-state from the terminal-level listener, which sees
  // releases even when the editor does not. The editor consults it before
  // firing a hold so a missed release can't open the overlay.
  let spaceDown = false;
  // Post-close grace window: while `Date.now() < cooldownUntil`, Space presses
  // insert normally instead of arming a hold.
  let cooldownUntil = 0;

  const canArmHold = (): boolean => Date.now() >= cooldownUntil;

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
        // The key press that opened the overlay is usually still in flight (the
        // overlay steals focus, so its release may never reach the editor). Reset
        // every piece of hold state and start a grace window during which Space
        // inserts normally, so closing the panel can never be followed by an
        // instant reopen from the same press.
        clearHoldRelease();
        spaceConsumed = false;
        spaceDown = false;
        resetTerminalRepeat();
        cooldownUntil = Date.now() + HOLD_COOLDOWN_MS;
      });
  };

  const resetTerminalRepeat = (): void => {
    if (terminalHoldTimer) clearTimeout(terminalHoldTimer);
    if (terminalReleaseTimer) clearTimeout(terminalReleaseTimer);
    terminalHoldTimer = null;
    terminalReleaseTimer = null;
    terminalRepeatCount = 0;
  };

  const clearHoldRelease = (): void => {
    if (holdReleaseTimer) clearTimeout(holdReleaseTimer);
    holdReleaseTimer = null;
  };

  const scheduleHoldRelease = (): void => {
    clearHoldRelease();
    holdReleaseTimer = setTimeout(() => {
      holdReleaseTimer = null;
      spaceConsumed = false;
    }, HOLD_REPEAT_GAP_MS);
  };

  const triggerTerminalVoice = (ctx: ExtensionContext): void => {
    // A hold may have armed just before the overlay closed; never let it open
    // the panel again during the cooldown window.
    if (!canArmHold()) {
      resetTerminalRepeat();
      return;
    }
    resetTerminalRepeat();
    if (!isKittyProtocolActive()) spaceConsumed = true;
    openVoice(ctx);
  };

  const scheduleTerminalHold = (ctx: ExtensionContext, minimumEvents: number): void => {
    if (terminalHoldTimer) return;
    terminalHoldTimer = setTimeout(() => {
      terminalHoldTimer = null;
      // In kitty mode a release is observable even when the editor missed it;
      // don't open the overlay from a key that was already released.
      if (isKittyProtocolActive() && !spaceDown) {
        resetTerminalRepeat();
        return;
      }
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
      const kitty = isKittyProtocolActive();

      // This listener fires for every keystroke regardless of focus, so it is
      // the only handler that can observe Space release while the overlay is
      // open (the editor is unfocused then and misses it). Re-arm hold-to-voice
      // only after the key is released, so a single hold can't reopen it.
      if (!kitty) {
        if (space) {
          scheduleHoldRelease();
        } else {
          const codePoint = data.length === 1 ? data.codePointAt(0) : undefined;
          const userInput =
            data === "\r" ||
            data === "\n" ||
            data === "\x7f" ||
            (codePoint !== undefined && codePoint >= 32);
          if (userInput) {
            clearHoldRelease();
            spaceConsumed = false;
            spaceDown = false;
          }
        }
      }

      if (voiceOpen) return;
      if (spaceConsumed) return;

      if (kitty) {
        if (!space) return;
        if (release) {
          spaceDown = false;
          if (terminalReleaseTimer) clearTimeout(terminalReleaseTimer);
          terminalReleaseTimer = setTimeout(() => {
            terminalReleaseTimer = null;
            resetTerminalRepeat();
          }, HOLD_RELEASE_DEBOUNCE_MS);
          return;
        }
        if (repeat) return;
        if (!canArmHold()) return; // cooldown: plain Space passthrough
        spaceDown = true;
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
        if (userInput) {
          resetTerminalRepeat();
          spaceDown = false;
        }
        return;
      }
      if (!canArmHold()) return; // cooldown: don't count toward a hold
      spaceDown = true;
      terminalRepeatCount++;
      scheduleTerminalHold(ctx, 2);
      return;
    });
  };

  const installHoldEditor = (ctx: ExtensionContext): void => {
    const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
    if (hasEditorFactoryLayer(current, holdEditorLayerId)) {
      holdEditorInstalled = true;
      return;
    }

    const holdEditorFactory = installEditorFactoryLayer(
      current,
      holdEditorLayerId,
      100,
      (parent, tui, theme, keybindings) => {
        const editor =
          (parent?.(tui, theme, keybindings) as InstanceType<typeof CustomEditor> | undefined) ??
          new CustomEditor(
            tui as ConstructorParameters<typeof CustomEditor>[0],
            theme as ConstructorParameters<typeof CustomEditor>[1],
            keybindings as ConstructorParameters<typeof CustomEditor>[2],
          );
        return addHoldToVoice(
          editor,
          () => {
            if (!isKittyProtocolActive()) spaceConsumed = true;
            openVoice(ctx);
          },
          {
            isSuppressed: () => spaceConsumed,
            canArm: canArmHold,
            isKeyDown: () => spaceDown,
          },
        );
      },
    );
    ctx.ui.setEditorComponent(holdEditorFactory);
    holdEditorInstalled = true;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || holdEditorInstalled) return;
    installTerminalHold(ctx);
    installHoldEditor(ctx);
    editorRecheckTimer = setTimeout(() => {
      editorRecheckTimer = null;
      const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
      if (!hasEditorFactoryLayer(current, holdEditorLayerId)) installHoldEditor(ctx);
    }, 0);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (speechJob) stopSpeechJob(speechJob);
    speechJob = null;
    if (editorRecheckTimer) clearTimeout(editorRecheckTimer);
    editorRecheckTimer = null;
    clearHoldRelease();
    spaceConsumed = false;
    spaceDown = false;
    cooldownUntil = 0;
    resetTerminalRepeat();
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    if (!holdEditorInstalled) return;
    const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
    const restored = removeEditorFactoryLayer(current, holdEditorLayerId);
    if (restored !== current) ctx.ui.setEditorComponent(restored);
    holdEditorInstalled = false;
  });

  pi.registerCommand("voice", {
    description: "Open the voice dictation overlay (same as holding Space)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      openVoice(ctx);
    },
  });

  pi.registerCommand("voice:settings", {
    description: "Open voice model, voice, and connection settings",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      await runVoiceSettings(args, ctx, {
        activeModelId,
        activeTtsModelId,
        activeSpeakerId,
        onModelSelect: (modelId) => {
          saveActiveModel(voiceConfigPath, modelId);
          activeModelId = modelId;
        },
        onTtsModelSelect: (modelId) => {
          saveActiveTtsModel(voiceConfigPath, modelId);
          activeTtsModelId = modelId;
        },
        onSpeakerSelect: (speakerId) => {
          const ttsModel = TTS_MODELS.find((model) => model.id === activeTtsModelId);
          if (ttsModel?.backend === "supertonic") {
            // Supertonic voices are unnamed speakers addressed by index.
            if (speakerId < 0 || speakerId >= (ttsModel.speakerCount ?? 0)) {
              throw new Error(`Unknown local voice index: ${speakerId}`);
            }
            saveActiveVoice(voiceConfigPath, speakerId);
            activeSpeakerId = speakerId;
            return;
          }
          const voice = KITTEN_VOICES[speakerId];
          if (!voice) throw new Error(`Unknown local voice index: ${speakerId}`);
          saveActiveVoice(voiceConfigPath, voice);
          activeSpeakerId = speakerId;
        },
      });
    },
  });

  pi.registerCommand("voice:speak", {
    description: "Summarize and locally speak the latest assistant message",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (speechJob) stopSpeechJob(speechJob);
      const job = createSpeechJob();
      speechJob = job;
      const modelsDir = resolveModelsDir(process.env);
      const ttsModel = TTS_MODELS.find((model) => model.id === activeTtsModelId);
      void runVoiceSpeak(args, ctx, {
        modelsDir,
        ttsModelId: activeTtsModelId,
        speakerId: activeSpeakerId,
        summarize: (text, commandCtx) => summarizeForSpeech(text, commandCtx),
        speak: async (text, speakerId) => {
          if (!ttsModel) throw new Error(`Speech model is not configured: ${activeTtsModelId}`);
          if (ttsModel.backend === "kitten") {
            const { sherpa, engine } = await getTtsEngine(ttsModel, modelsDir);
            await playKittenSpeech(sherpa, engine, text, speakerId, job);
            return;
          }
          if (ttsModel.backend === "supertonic") {
            const { sherpa, engine } = await getTtsEngine(ttsModel, modelsDir);
            await playSupertonicSpeech(sherpa, engine, text, speakerId, job);
            return;
          }
          const engine = await getInflectEngine(ttsModel, modelsDir);
          await playInflectSpeech(engine, text, job);
        },
      }).finally(() => {
        if (speechJob === job) speechJob = null;
      });
    },
  });

  pi.registerCommand("voice:stop", {
    description: "Stop local voice generation or playback",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (!speechJob) {
        ctx.ui.notify("No voice playback is active.", "info");
        return;
      }
      stopSpeechJob(speechJob);
      speechJob = null;
      setTtsIndicator(ctx, undefined);
      ctx.ui.notify("Voice playback stopped.", "info");
    },
  });
}
