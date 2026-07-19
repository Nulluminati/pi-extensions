import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { isKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import voiceExtension, {
  addHoldToVoice,
  buildKittenConfig,
  buildOfflineConfig,
  buildSpokenSummaryPrompt,
  cleanTextForSpeech,
  findLatestAssistantText,
  getModel,
  isHallucination,
  MODELS,
  modelIsDownloaded,
  parseSourcesListing,
  resolveModelsDir,
  resolveSource,
  runVoiceInfo,
  runVoiceModels,
  runVoiceSpeak,
  stripRepetitionLoop,
  summarizeForSpeech,
  TTS_MODELS,
  transcribeFile,
} from "../../extensions/voice/voice.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

afterEach(() => {
  vi.mocked(completeSimple).mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(isKittyProtocolActive).mockReturnValue(false);
});

describe("voice-extension", () => {
  describe("hold-to-voice editor", () => {
    it("opens voice after holding Space for one second", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => true,
        isSpace: (data) => data === "press" || data === "release",
        isRelease: (data) => data === "release",
        isRepeat: () => false,
      });

      editor.handleInput("press");
      vi.advanceTimersByTime(999);
      expect(onHold).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(onHold).toHaveBeenCalledTimes(1);
      expect(handleInput).not.toHaveBeenCalled();
      editor.handleInput("release");
      expect(handleInput).not.toHaveBeenCalled();
    });

    it("inserts a normal space when released before the hold threshold", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const editor = addHoldToVoice({ handleInput }, vi.fn(), {
        isSupported: () => true,
        isSpace: (data) => data === "press" || data === "release",
        isRelease: (data) => data === "release",
        isRepeat: () => false,
      });

      editor.handleInput("press");
      vi.advanceTimersByTime(500);
      editor.handleInput("release");

      expect(handleInput).toHaveBeenCalledWith(" ");
    });

    it("passes a tapped Space through when key-release reporting is unavailable", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const editor = addHoldToVoice({ handleInput }, vi.fn(), {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });

      editor.handleInput(" ");
      vi.advanceTimersByTime(1000);

      expect(handleInput).toHaveBeenCalledWith(" ");
    });

    it("opens voice from slow remote-session Space auto-repeat", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });

      editor.handleInput(" ");
      vi.advanceTimersByTime(800);
      editor.handleInput(" ");
      vi.advanceTimersByTime(200);

      expect(onHold).toHaveBeenCalledTimes(1);
    });

    it("opens voice from sustained Space auto-repeat without key-release reporting", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });

      editor.handleInput(" ");
      vi.advanceTimersByTime(500);
      for (let elapsed = 500; elapsed < 1000; elapsed += 100) {
        editor.handleInput(" ");
        vi.advanceTimersByTime(100);
      }

      expect(onHold).toHaveBeenCalledTimes(1);
    });
  });

  describe("editor lifecycle", () => {
    it("does not install hold-to-voice outside TUI mode", async () => {
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.mode = "print";
      await voiceExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);

      expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
    });

    it("installs hold-to-voice on session start and restores the previous editor on shutdown", async () => {
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      const baseEditor: { handleInput: ReturnType<typeof vi.fn>; wantsKeyRelease?: boolean } = {
        handleInput: vi.fn(),
      };
      const previousFactory = vi.fn(() => baseEditor);
      ctx.ui.setEditorComponent(previousFactory);
      ctx.ui.setEditorComponent.mockClear();
      await voiceExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);

      expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledWith(expect.any(Function));
      const installedFactory = ctx.ui.getEditorComponent();
      expect(installedFactory({}, {}, {})).toBe(baseEditor);
      expect(baseEditor.wantsKeyRelease).toBe(true);

      const sessionShutdown = getEventHandler(mockPi, "session_shutdown");
      await sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(ctx.ui.setEditorComponent).toHaveBeenLastCalledWith(previousFactory);
    });

    it("opens voice from the global terminal hook when the editor misses Space", async () => {
      vi.useFakeTimers();
      const modelsDir = mkdtempSync(join(tmpdir(), "pi-voice-global-hold-"));
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.ui.getEditorText = vi.fn(() => "prompt  ");
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");

      inputHandler(" ");
      vi.advanceTimersByTime(250);
      inputHandler("\x1b[I");
      vi.advanceTimersByTime(250);
      inputHandler(" ");
      vi.advanceTimersByTime(500);

      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("prompt");
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Run /voice-info"),
        "error",
      );
    });

    it("keeps holding across NX release-press repeat pairs", async () => {
      vi.useFakeTimers();
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const modelsDir = mkdtempSync(join(tmpdir(), "pi-voice-nx-hold-"));
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.ui.getEditorText = vi.fn(() => "prompt    ");
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");

      inputHandler(" ");
      vi.advanceTimersByTime(500);
      for (let elapsed = 500; elapsed < 1000; elapsed += 100) {
        inputHandler("space-release");
        vi.advanceTimersByTime(1);
        inputHandler(" ");
        vi.advanceTimersByTime(99);
      }

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Run /voice-info"),
        "error",
      );
    });

    it("does not open voice after a single Space with no repeat", async () => {
      vi.useFakeTimers();
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");

      inputHandler(" ");
      vi.advanceTimersByTime(1000);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("re-wraps an editor installed by another extension during startup", async () => {
      vi.useFakeTimers();
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const laterEditor: { handleInput: ReturnType<typeof vi.fn>; wantsKeyRelease?: boolean } = {
        handleInput: vi.fn(),
      };
      const laterFactory = vi.fn(() => laterEditor);
      ctx.ui.setEditorComponent(laterFactory);
      ctx.ui.setEditorComponent.mockClear();

      await vi.runAllTimersAsync();

      expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
      const installedFactory = ctx.ui.getEditorComponent();
      expect(installedFactory({}, {}, {})).toBe(laterEditor);
      expect(laterEditor.wantsKeyRelease).toBe(true);
    });
  });

  describe("registration", () => {
    it("registers dictation and speech commands", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const names = mockPi.registerCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(names).toEqual([
        "voice",
        "voice-models",
        "voice-info",
        "voice-speak",
        "voice-stop",
        "voice-voices",
        "voice-summary-model",
      ]);
    });

    it("each command has a description and a handler", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      for (const call of mockPi.registerCommand.mock.calls) {
        const opts = call[1] as { description: string; handler: (...a: unknown[]) => unknown };
        expect(typeof opts.description).toBe("string");
        expect(opts.description.length).toBeGreaterThan(0);
        expect(typeof opts.handler).toBe("function");
      }
    });
  });

  describe("spoken summaries", () => {
    it("finds the latest assistant text in the active branch", () => {
      const text = findLatestAssistantText([
        { type: "message", message: { role: "assistant", content: "older" } },
        { type: "message", message: { role: "user", content: "question" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "Latest answer." },
            ],
          },
        },
      ]);

      expect(text).toBe("Latest answer.");
    });

    it("returns undefined when the branch has no assistant text", () => {
      expect(
        findLatestAssistantText([
          { type: "message", message: { role: "user", content: "question" } },
        ]),
      ).toBeUndefined();
    });

    it("cleans Markdown and code from text before speaking", () => {
      expect(
        cleanTextForSpeech(
          "## Result\n\n- Fixed **voice** in [`voice.ts`](https://example.test).\n```ts\nconst hidden = true;\n```",
        ),
      ).toBe("Result Fixed voice in voice.ts.");
    });

    it("builds a terse plain-speech summary prompt", () => {
      const prompt = buildSpokenSummaryPrompt("Implemented voice playback and all tests pass.");
      expect(prompt).toContain("40 to 70 words");
      expect(prompt).toContain("plain spoken prose");
      expect(prompt).toContain("Implemented voice playback");
    });

    it("uses the configured cloud model for a spoken summary", async () => {
      const ctx = createMockCommandContext();
      ctx.modelRegistry.find = vi.fn(() => ctx.model);
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: "**Short result.** Next, test playback." }],
      });

      const result = await summarizeForSpeech("A long assistant response.", ctx, {
        provider: "synthetic",
        id: "syn:small:text",
      });

      expect(ctx.modelRegistry.find).toHaveBeenCalledWith("synthetic", "syn:small:text");
      expect(completeSimple).toHaveBeenCalledWith(
        ctx.model,
        expect.objectContaining({
          systemPrompt: expect.stringContaining("spoken summaries"),
          messages: [
            expect.objectContaining({
              content: [
                expect.objectContaining({
                  text: expect.stringContaining("A long assistant response"),
                }),
              ],
            }),
          ],
        }),
        expect.objectContaining({ apiKey: "test-key", maxTokens: 160 }),
      );
      expect(result).toBe("Short result. Next, test playback.");
    });

    it("summarizes and speaks the latest assistant message", async () => {
      const dir = createDownloadedTtsModel();
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "assistant", content: "A detailed answer." } },
      ]);
      const summarize = vi.fn(async () => "A short summary.");
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("", ctx, {
        modelsDir: dir,
        summarize,
        speak,
        speakerId: 2,
      });

      expect(summarize).toHaveBeenCalledWith("A detailed answer.", ctx);
      expect(speak).toHaveBeenCalledWith("A short summary.", 2);
    });

    it("speaks the cleaned full message without calling the summary model", async () => {
      const dir = createDownloadedTtsModel();
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() => [
        {
          type: "message",
          message: { role: "assistant", content: "**Done.** `npm test` passes." },
        },
      ]);
      const summarize = vi.fn();
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("full", ctx, { modelsDir: dir, summarize, speak, speakerId: 0 });

      expect(summarize).not.toHaveBeenCalled();
      expect(speak).toHaveBeenCalledWith("Done. npm test passes.", 0);
    });

    it("reports when there is no assistant message to speak", async () => {
      const ctx = createMockCommandContext();
      await runVoiceSpeak("", ctx, {
        modelsDir: createDownloadedTtsModel(),
        summarize: vi.fn(),
        speak: vi.fn(),
        speakerId: 0,
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith("No assistant message to speak.", "warning");
    });

    it("reports missing local TTS model files", async () => {
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "assistant", content: "Answer" } },
      ]);
      await runVoiceSpeak("", ctx, {
        modelsDir: mkdtempSync(join(tmpdir(), "pi-voice-no-tts-")),
        summarize: vi.fn(),
        speak: vi.fn(),
        speakerId: 0,
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Kitten Nano"), "error");
    });
  });

  describe("TTS model registry", () => {
    it("includes Kitten Nano with its required files and download URL", () => {
      expect(TTS_MODELS).toEqual([
        expect.objectContaining({
          id: "kitten-nano-en-v0_1-fp16",
          files: expect.arrayContaining(["model.fp16.onnx", "voices.bin", "tokens.txt"]),
          downloadUrl: expect.stringContaining("kitten-nano-en-v0_1-fp16.tar.bz2"),
        }),
      ]);
    });

    it("builds a sherpa Kitten configuration", () => {
      const config = buildKittenConfig(TTS_MODELS[0]!, "/models", 4) as {
        model: {
          kitten: { model: string; voices: string; tokens: string; dataDir: string };
          numThreads: number;
          provider: string;
        };
      };
      expect(config.model.kitten.model).toBe("/models/kitten-nano-en-v0_1-fp16/model.fp16.onnx");
      expect(config.model.kitten.voices).toContain("voices.bin");
      expect(config.model.kitten.tokens).toContain("tokens.txt");
      expect(config.model.kitten.dataDir).toContain("espeak-ng-data");
      expect(config.model.numThreads).toBe(4);
      expect(config.model.provider).toBe("cpu");
    });
  });

  describe("model registry + downloads", () => {
    it("getModel returns registered models", () => {
      expect(getModel("moonshine-base-int8")?.kind).toBe("offline");
      expect(getModel("whisper-tiny-en-int8")?.kind).toBe("offline");
      expect(getModel("does-not-exist")).toBeUndefined();
    });

    it("includes Moonshine Base, Whisper Tiny, and Whisper Small int8", () => {
      expect(MODELS.map((model) => model.id)).toEqual([
        "moonshine-base-int8",
        "whisper-tiny-en-int8",
        "whisper-small-en-int8",
      ]);
    });

    it("modelIsDownloaded is false when files are missing", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-empty-"));
      const model = getModel("moonshine-base-int8")!;
      expect(modelIsDownloaded(dir, model)).toBe(false);
    });

    it("modelIsDownloaded is true when every required file exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-full-"));
      const model = getModel("whisper-tiny-en-int8")!;
      mkdirSync(join(dir, model.dirName), { recursive: true });
      for (const file of model.files) {
        writeFileSync(join(dir, model.dirName, file), "stub");
      }
      expect(modelIsDownloaded(dir, model)).toBe(true);
    });
  });

  describe("resolveModelsDir", () => {
    it("uses PI_VOICE_MODELS when set", () => {
      expect(resolveModelsDir({ PI_VOICE_MODELS: "/custom/path" })).toBe("/custom/path");
    });

    it("ignores a blank PI_VOICE_MODELS", () => {
      expect(resolveModelsDir({ PI_VOICE_MODELS: "  " })).not.toBe("  ");
    });

    it("falls back to ~/.cache/pi-voice/models when unset", () => {
      const dir = resolveModelsDir({});
      expect(dir.endsWith(join(".cache", "pi-voice", "models"))).toBe(true);
    });
  });

  describe("config builders", () => {
    it("buildOfflineConfig builds a whisper sub-config", () => {
      const model = getModel("whisper-tiny-en-int8")!;
      const config = buildOfflineConfig(model, "/m", 2) as {
        modelConfig: {
          whisper: { encoder: string; decoder: string; language: string; task: string };
          tokens: string;
        };
      };
      expect(config.modelConfig.whisper.encoder).toContain("tiny.en-encoder.int8.onnx");
      expect(config.modelConfig.whisper.decoder).toContain("tiny.en-decoder.int8.onnx");
      expect(config.modelConfig.whisper.language).toBe("en");
      expect(config.modelConfig.whisper.task).toBe("transcribe");
      expect(config.modelConfig.tokens).toContain("tiny.en-tokens.txt");
    });

    it("buildOfflineConfig uses the small.en files for Whisper Small", () => {
      const model = getModel("whisper-small-en-int8")!;
      const config = buildOfflineConfig(model, "/m", 2) as {
        modelConfig: { whisper: { encoder: string; decoder: string }; tokens: string };
      };
      expect(config.modelConfig.whisper.encoder).toContain("small.en-encoder.int8.onnx");
      expect(config.modelConfig.whisper.decoder).toContain("small.en-decoder.int8.onnx");
      expect(config.modelConfig.tokens).toContain("small.en-tokens.txt");
    });

    it("buildOfflineConfig builds a moonshine sub-config for moonshine models", () => {
      const model = getModel("moonshine-base-int8")!;
      const config = buildOfflineConfig(model, "/m", 2) as {
        modelConfig: {
          moonshine: {
            preprocessor: string;
            encoder: string;
            uncachedDecoder: string;
            cachedDecoder: string;
          };
          whisper?: unknown;
          tokens: string;
        };
      };
      expect(config.modelConfig.moonshine).toBeDefined();
      expect(config.modelConfig.moonshine.preprocessor).toContain("preprocess.onnx");
      expect(config.modelConfig.moonshine.encoder).toContain("encode.int8.onnx");
      expect(config.modelConfig.moonshine.uncachedDecoder).toContain("uncached_decode.int8.onnx");
      expect(config.modelConfig.moonshine.cachedDecoder).toContain("cached_decode.int8.onnx");
      expect(config.modelConfig.tokens).toContain("tokens.txt");
      expect(config.modelConfig.whisper).toBeUndefined();
    });
  });

  describe("transcribeFile", () => {
    function fakeSherpa(text: string, sampleRate = 16000) {
      const samples = new Float32Array(sampleRate * 2); // 2s of audio
      const stream = { acceptWaveform: () => {} };
      return {
        readWave: () => ({ samples, sampleRate }),
        writeWave: () => {},
        Vad: class {
          acceptWaveform() {}
          isEmpty() {
            return true;
          }
          front() {
            return { start: 0, samples: new Float32Array(0) };
          }
          pop() {}
          flush() {}
        },
        OnlineRecognizer: class {
          createStream() {
            return stream;
          }
          isReady() {
            return false;
          }
          decode() {}
          getResult() {
            return { text };
          }
        },
        OfflineRecognizer: class {
          createStream() {
            return stream;
          }
          decode() {}
          getResult() {
            return { text };
          }
        },
      };
    }

    it("runs the offline path for a whisper model", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-offline-"));
      const model = getModel("whisper-tiny-en-int8")!;
      mkdirSync(join(dir, model.dirName), { recursive: true });
      for (const file of model.files) writeFileSync(join(dir, model.dirName, file), "stub");
      const result = transcribeFile(fakeSherpa("a sentence"), model, dir, "/fake.wav");
      expect(result.text).toBe("a sentence");
      expect(result.modelId).toBe("whisper-tiny-en-int8");
    });

    it("throws on empty audio", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-empty-audio-"));
      const model = getModel("moonshine-base-int8")!;
      mkdirSync(join(dir, model.dirName), { recursive: true });
      for (const file of model.files) writeFileSync(join(dir, model.dirName, file), "stub");
      const empty = {
        readWave: () => ({ samples: new Float32Array(0), sampleRate: 16000 }),
        writeWave: () => {},
        Vad: class {
          acceptWaveform() {}
          isEmpty() {
            return true;
          }
          front() {
            return { start: 0, samples: new Float32Array(0) };
          }
          pop() {}
          flush() {}
        },
        OnlineRecognizer: class {
          createStream() {
            return { acceptWaveform: () => {} };
          }
          isReady() {
            return false;
          }
          decode() {}
          getResult() {
            return { text: "" };
          }
        },
        OfflineRecognizer: class {
          createStream() {
            return { acceptWaveform: () => {} };
          }
          decode() {}
          getResult() {
            return { text: "" };
          }
        },
      };
      expect(() => transcribeFile(empty, model, dir, "/fake.wav")).toThrow(/empty/i);
    });
  });

  describe("runVoiceModels command", () => {
    it("shows a selection menu and activates a downloaded model", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-ready-"));
      for (const model of MODELS) {
        mkdirSync(join(dir, model.dirName), { recursive: true });
        for (const file of model.files) writeFileSync(join(dir, model.dirName, file), "stub");
      }
      const ctx = createMockCommandContext();
      ctx.ui.select = vi.fn(async (_title, options) => options[1]);
      const onSelect = vi.fn();

      await runVoiceModels("", ctx, {
        modelsDir: dir,
        activeModelId: "moonshine-base-int8",
        onSelect,
      });

      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Select voice model",
        expect.arrayContaining([
          expect.stringContaining("moonshine-base-int8"),
          expect.stringContaining("whisper-tiny-en-int8"),
        ]),
      );
      expect(onSelect).toHaveBeenCalledWith("whisper-tiny-en-int8");
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Voice model set to whisper-tiny-en-int8.",
        "info",
      );
    });

    it("does not activate a model that has not been downloaded", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-missing-"));
      const ctx = createMockCommandContext();
      ctx.ui.select = vi.fn(async (_title, options) => options[1]);
      const onSelect = vi.fn();

      await runVoiceModels("", ctx, {
        modelsDir: dir,
        activeModelId: "moonshine-base-int8",
        onSelect,
      });

      expect(onSelect).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Run /voice-info"),
        "error",
      );
    });
  });

  describe("runVoiceInfo command", () => {
    it("shows model downloads and voice device information together", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-info-"));
      const ctx = createMockCommandContext();

      await runVoiceInfo("", ctx, {
        modelsDir: dir,
        source: "studio-mic",
        sources: [
          { name: "studio-mic", description: "RUNNING" },
          { name: "laptop-mic", description: "SUSPENDED" },
        ],
      });

      const message = (ctx.ui.notify.mock.calls[0] as unknown[])[0] as string;
      expect(message).toContain(dir);
      expect(message).toContain("moonshine-base-int8");
      expect(message).toContain("whisper-tiny-en-int8");
      expect(message).toContain("whisper-small-en-int8");
      expect(message).toContain("kitten-nano-en-v0_1-fp16");
      expect(message).toContain("silero_vad.onnx");
      expect(message).toContain("Current source: studio-mic");
      expect(message).toContain("laptop-mic");
      expect(message).toContain("PI_VOICE_SOURCE");
      expect(message).not.toContain("zipformer");
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("resolveSource", () => {
    it("uses PI_VOICE_SOURCE when set", () => {
      expect(resolveSource({ PI_VOICE_SOURCE: "nx_voice_in" })).toBe("nx_voice_in");
    });

    it("trims whitespace", () => {
      expect(resolveSource({ PI_VOICE_SOURCE: "  nx_voice_in  " })).toBe("nx_voice_in");
    });

    it("defaults to default when unset or blank", () => {
      expect(resolveSource({})).toBe("default");
      expect(resolveSource({ PI_VOICE_SOURCE: "   " })).toBe("default");
    });
  });

  describe("parseSourcesListing", () => {
    it("parses pactl short-format rows into name/description", () => {
      const output = [
        "601\tnx_remapped_out\tPipeWire\tfloat32le 2ch 48000Hz\tRUNNING",
        "636\tnx_voice_out.monitor\tPipeWire\tfloat32le 2ch 48000Hz\tIDLE",
        "",
      ].join("\n");
      const sources = parseSourcesListing(output);
      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({ name: "nx_remapped_out", description: "RUNNING" });
      expect(sources[1]?.name).toBe("nx_voice_out.monitor");
    });

    it("returns empty for no output", () => {
      expect(parseSourcesListing("")).toEqual([]);
      expect(parseSourcesListing("\n\n")).toEqual([]);
    });
  });

  describe("handler wiring", () => {
    it("the /voice-models handler keeps the selected model active", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-active-"));
      for (const model of MODELS) {
        mkdirSync(join(dir, model.dirName), { recursive: true });
        for (const file of model.files) writeFileSync(join(dir, model.dirName, file), "stub");
      }
      vi.stubEnv("PI_VOICE_MODELS", dir);
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice-models");
      const ctx = createMockCommandContext();
      ctx.ui.select = vi
        .fn()
        .mockImplementationOnce(async (_title, options: string[]) =>
          options.find((option) => option.startsWith("whisper-tiny-en-int8")),
        )
        .mockResolvedValueOnce(undefined);

      await handler("", ctx);
      await handler("", ctx);

      expect(ctx.ui.select).toHaveBeenNthCalledWith(
        1,
        "Select voice model",
        expect.arrayContaining([expect.stringContaining("moonshine-base-int8 (active)")]),
      );
      expect(ctx.ui.select).toHaveBeenNthCalledWith(
        2,
        "Select voice model",
        expect.arrayContaining([expect.stringContaining("whisper-tiny-en-int8 (active)")]),
      );
    });

    it("/voice-voices selects the active local speaker", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice-voices");
      const ctx = createMockCommandContext();
      ctx.ui.select = vi.fn(async (_title, options) => options[3]);

      await handler("", ctx);

      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Select local voice",
        expect.arrayContaining(["expr-voice-2-m (active)", "expr-voice-3-f"]),
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith("Local voice set to expr-voice-3-f.", "info");
    });

    it("/voice-summary-model selects an available cloud model", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice-summary-model");
      const ctx = createMockCommandContext();
      ctx.modelRegistry.getAvailable = vi.fn(() => [ctx.model]);
      ctx.ui.select = vi.fn(async (_title, options) => options[0]);

      await handler("", ctx);

      expect(ctx.ui.select).toHaveBeenCalledWith("Select summary model", [
        "test-provider/test-model",
      ]);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Summary model set to test-provider/test-model.",
        "info",
      );
    });

    it("/voice-stop reports when playback is already idle", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice-stop");
      const ctx = createMockCommandContext();

      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("No voice playback is active.", "info");
    });
  });

  describe("hallucination filter", () => {
    it("flags known filler phrases regardless of case/punctuation", () => {
      expect(isHallucination("Thanks for watching!")).toBe(true);
      expect(isHallucination("thanks  for  watching.")).toBe(true);
      expect(isHallucination("THANK YOU FOR WATCHING")).toBe(true);
      expect(isHallucination("[Music]")).toBe(true);
    });

    it("flags empty text", () => {
      expect(isHallucination("")).toBe(true);
      expect(isHallucination("   ")).toBe(true);
    });

    it("flags single-token repetition loops (4+ reps)", () => {
      expect(isHallucination("yeah yeah yeah yeah")).toBe(true);
      expect(isHallucination("ok ok ok ok ok")).toBe(true);
    });

    it("does NOT flag short emphasis (3 reps of single token)", () => {
      expect(isHallucination("yeah yeah yeah")).toBe(false);
    });

    it("flags multi-token repetition loops (3+ reps)", () => {
      expect(isHallucination("yes no yes no yes no")).toBe(true);
      expect(isHallucination("the cat the cat the cat")).toBe(true);
    });

    it("does not flag real speech", () => {
      expect(isHallucination("This is a twelve second voice test.")).toBe(false);
      expect(
        isHallucination(
          "For the pi extension, the new voice extension that we are developing together.",
        ),
      ).toBe(false);
    });
  });

  describe("stripRepetitionLoop", () => {
    it("strips a trailing single-token loop down to one instance", () => {
      const input = "we are debugging collaboration collaboration collaboration collaboration";
      expect(stripRepetitionLoop(input)).toBe("we are debugging collaboration");
    });

    it("strips a trailing multi-token loop down to one instance", () => {
      const input =
        "this is in collaboration with collaboration with collaboration with collaboration with";
      expect(stripRepetitionLoop(input)).toBe("this is in collaboration with");
    });

    it("preserves text with no repetition", () => {
      const input = "This is a twelve second voice test for the pi extension.";
      expect(stripRepetitionLoop(input)).toBe(input);
    });

    it("preserves short text (too short to be a loop)", () => {
      expect(stripRepetitionLoop("hello world")).toBe("hello world");
      expect(stripRepetitionLoop("yeah yeah yeah")).toBe("yeah yeah yeah");
    });

    it("preserves real emphasis that doesn't meet the loop threshold", () => {
      expect(stripRepetitionLoop("yeah yeah yeah let's go")).toBe("yeah yeah yeah let's go");
    });

    it("handles a long single-word transcription loop", () => {
      const input =
        "This is in collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration, collaboration";
      const result = stripRepetitionLoop(input);
      expect(result).toBe("This is in collaboration,");
      expect(result).not.toContain("collaboration, collaboration");
    });
  });
});

function createDownloadedTtsModel(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-tts-"));
  const model = TTS_MODELS[0];
  if (!model) throw new Error("Missing test TTS model definition");
  mkdirSync(join(dir, model.dirName, "espeak-ng-data"), { recursive: true });
  for (const file of model.files) {
    if (file === "espeak-ng-data") continue;
    writeFileSync(join(dir, model.dirName, file), "stub");
  }
  return dir;
}
