import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { detectRecorders, hasTool } from "./audio.ts";
import { resolveModelsDir, resolveSource } from "./config.ts";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_TTS_MODEL_ID,
  KITTEN_VOICES,
  SOURCE_ENV_VAR,
} from "./constants.ts";
import { getModel, MODELS, modelIsDownloaded, TTS_MODELS } from "./models.ts";
import { resolveVadModel } from "./transcription.ts";
import type { ModelDef, RecorderDeps, TtsModelDef } from "./types.ts";

interface VoiceSettingsTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface VoiceSettingsOptions {
  modelsDir?: string;
  activeModelId?: string;
  activeTtsModelId?: string;
  activeSpeakerId?: number;
  recorder?: RecorderDeps;
  playbackReady?: boolean;
  source?: string;
  onModelSelect: (modelId: string) => void | Promise<void>;
  onTtsModelSelect: (modelId: string) => void | Promise<void>;
  onSpeakerSelect: (speakerId: number) => void | Promise<void>;
}

function modelSettingValue(modelsDir: string, model: ModelDef | TtsModelDef): string {
  const status = modelIsDownloaded(modelsDir, model) ? "Ready" : "Missing";
  return `${model.displayName} · ${status}`;
}

function speakerSettingValue(model: TtsModelDef, speakerId: number): string {
  if (model.backend === "kitten") {
    const voice = KITTEN_VOICES[speakerId] ?? KITTEN_VOICES[0];
    const match = voice.match(/expr-voice-(\d)-([mf])/);
    if (!match) return voice;
    return `Voice ${match[1]} · ${match[2] === "m" ? "Masculine" : "Feminine"}`;
  }
  const count = model.speakerCount ?? 1;
  return `Voice ${Math.min(speakerId, count - 1) + 1}`;
}

/** Selectable speaker indexes for a model; empty means one fixed voice. */
function speakerIdsFor(model: TtsModelDef): number[] {
  if (model.backend === "kitten") return KITTEN_VOICES.map((_, speakerId) => speakerId);
  return Array.from({ length: model.speakerCount ?? 0 }, (_, speakerId) => speakerId);
}

export async function runVoiceSettings(
  _args: string,
  ctx: ExtensionCommandContext,
  opts: VoiceSettingsOptions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Voice settings require TUI mode.", "error");
    return;
  }

  const modelsDir = opts.modelsDir ?? resolveModelsDir(process.env);
  const recorder = opts.recorder ?? detectRecorders();
  const playbackReady = opts.playbackReady ?? (hasTool("pw-play") || hasTool("ffplay"));
  const source = opts.source ?? resolveSource(process.env);
  let activeModelId = opts.activeModelId ?? DEFAULT_MODEL_ID;
  let activeTtsModelId = opts.activeTtsModelId ?? DEFAULT_TTS_MODEL_ID;
  let activeSpeakerId = opts.activeSpeakerId ?? 0;

  const dictationValues = new Map(
    MODELS.map((model) => [modelSettingValue(modelsDir, model), model] as const),
  );
  const speechValues = new Map(
    TTS_MODELS.map((model) => [modelSettingValue(modelsDir, model), model] as const),
  );
  const activeModel = getModel(activeModelId) ?? MODELS[0];
  const activeTtsModel = TTS_MODELS.find((model) => model.id === activeTtsModelId) ?? TTS_MODELS[0];
  if (!activeModel || !activeTtsModel) {
    ctx.ui.notify("Voice model registry is empty.", "error");
    return;
  }
  const speakerValues = new Map(
    speakerIdsFor(activeTtsModel).map(
      (speakerId) => [speakerSettingValue(activeTtsModel, speakerId), speakerId] as const,
    ),
  );
  const activeModelValue = modelSettingValue(modelsDir, activeModel);
  const activeTtsModelValue = modelSettingValue(modelsDir, activeTtsModel);
  const selectableDictationValues = MODELS.filter((model) =>
    modelIsDownloaded(modelsDir, model),
  ).map((model) => modelSettingValue(modelsDir, model));
  if (!selectableDictationValues.includes(activeModelValue)) {
    selectableDictationValues.unshift(activeModelValue);
  }
  const selectableSpeechValues = TTS_MODELS.filter((model) =>
    modelIsDownloaded(modelsDir, model),
  ).map((model) => modelSettingValue(modelsDir, model));
  if (!selectableSpeechValues.includes(activeTtsModelValue)) {
    selectableSpeechValues.unshift(activeTtsModelValue);
  }

  const speakerIds = speakerIdsFor(activeTtsModel);
  const voiceItem: SettingItem = {
    id: "voice",
    label: "Local voice",
    description:
      speakerIds.length > 0
        ? `${activeTtsModel.displayName} provides ${speakerIds.length} local voices.`
        : `${activeTtsModel.displayName} uses one fixed voice.`,
    currentValue:
      speakerIds.length > 0 ? speakerSettingValue(activeTtsModel, activeSpeakerId) : "Fixed voice",
  };
  if (speakerIds.length > 0) voiceItem.values = [...speakerValues.keys()];

  const items: SettingItem[] = [
    {
      id: "dictation-model",
      label: "Dictation model",
      description: `Turns microphone audio into text. ${[...dictationValues.keys()].join(" · ")}`,
      currentValue: activeModelValue,
      values: selectableDictationValues,
    },
    {
      id: "speech-model",
      label: "Speech model",
      description: `Turns response summaries into local speech. ${[...speechValues.keys()].join(" · ")}`,
      currentValue: activeTtsModelValue,
      values: selectableSpeechValues,
    },
    voiceItem,
    {
      id: "recording-input",
      label: "Recording input",
      description: `Set a different source with ${SOURCE_ENV_VAR} before starting Pi.`,
      currentValue: `${source} · ${recorder.hasFfmpeg || recorder.hasArecord ? "Ready" : "Not connected"}`,
    },
    {
      id: "speech-output",
      label: "Speech output",
      description: "Playback requires pw-play or ffplay.",
      currentValue: playbackReady ? "Ready" : "Not connected",
    },
    {
      id: "voice-activity",
      label: "Voice activity",
      description: "Silero VAD removes silence before transcription.",
      currentValue: resolveVadModel(modelsDir) ? "Ready" : "Missing (optional)",
    },
  ];

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const settingsTheme = getSettingsListTheme();
      let settingsList: SettingsList;
      settingsList = new SettingsList(
        items,
        items.length,
        { ...settingsTheme, hint: () => "" },
        async (id, newValue) => {
          if (id === "dictation-model") {
            const previousValue = modelSettingValue(
              modelsDir,
              getModel(activeModelId) ?? activeModel,
            );
            const model = dictationValues.get(newValue);
            if (!model || !modelIsDownloaded(modelsDir, model)) {
              settingsList.updateValue(id, previousValue);
              if (model) {
                ctx.ui.notify(
                  `${model.displayName} is not downloaded in ${modelsDir}. See the voice README for setup.`,
                  "error",
                );
              }
              return;
            }
            try {
              await opts.onModelSelect(model.id);
            } catch (error) {
              settingsList.updateValue(id, previousValue);
              ctx.ui.notify(
                `Could not save dictation model: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              return;
            }
            activeModelId = model.id;
            ctx.ui.notify(`Dictation model set to ${model.displayName}.`, "info");
            return;
          }

          if (id === "speech-model") {
            const previousModel =
              TTS_MODELS.find((model) => model.id === activeTtsModelId) ?? activeTtsModel;
            const previousValue = modelSettingValue(modelsDir, previousModel);
            const model = speechValues.get(newValue);
            if (!model || !modelIsDownloaded(modelsDir, model)) {
              settingsList.updateValue(id, previousValue);
              if (model) {
                ctx.ui.notify(
                  `${model.displayName} is not downloaded in ${modelsDir}. See the voice README for setup.`,
                  "error",
                );
              }
              return;
            }
            try {
              await opts.onTtsModelSelect(model.id);
            } catch (error) {
              settingsList.updateValue(id, previousValue);
              ctx.ui.notify(
                `Could not save speech model: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              return;
            }
            activeTtsModelId = model.id;
            const nextSpeakerIds = speakerIdsFor(model);
            if (nextSpeakerIds.length > 0) {
              voiceItem.currentValue = speakerSettingValue(model, activeSpeakerId);
              voiceItem.values = nextSpeakerIds.map((speakerId) =>
                speakerSettingValue(model, speakerId),
              );
              voiceItem.description = `${model.displayName} provides ${nextSpeakerIds.length} local voices.`;
            } else {
              voiceItem.currentValue = "Fixed voice";
              delete voiceItem.values;
              voiceItem.description = `${model.displayName} uses one fixed voice.`;
            }
            ctx.ui.notify(`Speech model set to ${model.displayName}.`, "info");
            return;
          }

          if (id !== "voice") return;
          const previousValue = speakerSettingValue(activeTtsModel, activeSpeakerId);
          const speakerId = speakerValues.get(newValue);
          if (speakerId === undefined) {
            settingsList.updateValue(id, previousValue);
            return;
          }
          try {
            await opts.onSpeakerSelect(speakerId);
          } catch (error) {
            settingsList.updateValue(id, previousValue);
            ctx.ui.notify(
              `Could not save local voice: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          activeSpeakerId = speakerId;
          ctx.ui.notify(`Local voice set to ${newValue}.`, "info");
        },
        () => done(undefined),
      );

      const overlayTheme = theme as VoiceSettingsTheme;
      return {
        render: (width: number) => {
          const frameWidth = Math.max(24, width);
          const contentWidth = modalContentWidth(frameWidth);
          const settingsLines = settingsList.render(contentWidth);
          while (
            settingsLines.length > 0 &&
            visibleWidth(settingsLines[settingsLines.length - 1] ?? "") === 0
          ) {
            settingsLines.pop();
          }

          const divider = overlayTheme.fg("dim", "─".repeat(contentWidth));
          const lines = [
            `${overlayTheme.fg("accent", "local audio")} · MIC → TEXT → SPEECH`,
            divider,
            ...settingsLines,
            divider,
            formatStyledKeyHints(overlayTheme, [
              ["↑↓", "navigate"],
              ["enter/space", "change"],
              ["esc", "cancel"],
            ]),
          ];
          return renderModalFrame(overlayTheme, frameWidth, lines, { title: "Voice" });
        },
        invalidate: () => settingsList.invalidate(),
        handleInput: (data: string) => {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "78%",
        minWidth: 72,
        maxHeight: "78%",
        anchor: "center",
        margin: { top: 1, bottom: 1, left: 2, right: 2 },
      },
      onHandle: (handle) => handle.focus(),
    },
  );
}
