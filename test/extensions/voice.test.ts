import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { isKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import voiceExtension, {
  addHoldToVoice,
  buildInflectPhonemeText,
  buildKittenConfig,
  buildOfflineConfig,
  buildSpokenSummaryPrompt,
  cleanTextForSpeech,
  createInflectGaussianSamples,
  encodePcm16Wave,
  findLatestAssistantText,
  getModel,
  inflectTextToTokens,
  isHallucination,
  MODELS,
  modelIsDownloaded,
  resolveModelsDir,
  resolveSource,
  resolveVoiceConfigPath,
  runVoiceSettings,
  runVoiceSpeak,
  splitInflectText,
  stripRepetitionLoop,
  summarizeForSpeech,
  TTS_MODELS,
  transcribeFile,
} from "../../extensions/voice/voice.ts";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv("PI_SMALL_MODEL", "test-provider/test-model");
  vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
});

afterEach(() => {
  vi.mocked(completeSimple).mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(isKittyProtocolActive).mockReturnValue(false);
});

describe("voice-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/voice");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["voice.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(13);
    });
  });

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

    it("does not forward non-Space key releases to the editor", () => {
      const handleInput = vi.fn();
      const editor = addHoldToVoice({ handleInput }, vi.fn(), {
        isSupported: () => true,
        isSpace: () => false,
        isRelease: (data) => data === "a-release",
        isRepeat: () => false,
      });

      editor.handleInput("a-press");
      editor.handleInput("a-release");

      expect(handleInput).toHaveBeenCalledOnce();
      expect(handleInput).toHaveBeenCalledWith("a-press");
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

    it("removes hold-to-voice from around a later inner editor layer on shutdown", async () => {
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      await voiceExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const voiceFactory = ctx.ui.getEditorComponent() as EditorFactory;
      expect(hasEditorFactoryLayer(voiceFactory, "voice-hold")).toBe(true);
      const withVisualLayer = installEditorFactoryLayer(
        voiceFactory,
        "test-visual-layer",
        0,
        (parent, tui, theme, keybindings) => parent?.(tui, theme, keybindings),
      );
      ctx.ui.setEditorComponent(withVisualLayer);

      const sessionShutdown = getEventHandler(mockPi, "session_shutdown");
      await sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

      const restored = ctx.ui.getEditorComponent() as EditorFactory;
      expect(hasEditorFactoryLayer(restored, "voice-hold")).toBe(false);
      expect(hasEditorFactoryLayer(restored, "test-visual-layer")).toBe(true);
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
        expect.stringContaining("Open /voice:settings"),
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
        expect.stringContaining("Open /voice:settings"),
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
      expect(names).toEqual(["voice", "voice:settings", "voice:speak", "voice:stop"]);
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

    it("uses the global small model instead of the active model for a spoken summary", async () => {
      const ctx = createMockCommandContext();
      const activeModel = ctx.model;
      const smallModel = {
        ...activeModel,
        id: "small-model",
        provider: "small-provider",
        reasoning: true,
      };
      vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
      ctx.modelRegistry.find = vi.fn(() => smallModel);
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: "**Short result.** Next, test playback." }],
      });

      const result = await summarizeForSpeech("A long assistant response.", ctx);

      expect(ctx.modelRegistry.find).toHaveBeenCalledWith("small-provider", "small-model");
      expect(completeSimple).toHaveBeenCalledWith(
        smallModel,
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
        expect.objectContaining({
          apiKey: "test-key",
          maxTokens: 160,
          reasoning: "minimal",
        }),
      );
      expect(completeSimple).not.toHaveBeenCalledWith(
        activeModel,
        expect.anything(),
        expect.anything(),
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

    it("accepts a downloaded Inflect model for speech", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-inflect-"));
      const modelDir = join(dir, "inflect-nano-v2-onnx");
      mkdirSync(modelDir);
      writeFileSync(join(modelDir, "duration.onnx"), "stub");
      writeFileSync(join(modelDir, "decode.onnx"), "stub");
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "assistant", content: "Inflect response." } },
      ]);
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("full", ctx, {
        modelsDir: dir,
        ttsModelId: "inflect-nano-v2-onnx",
        summarize: vi.fn(),
        speak,
        speakerId: 0,
      });

      expect(speak).toHaveBeenCalledWith("Inflect response.", 0);
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
      expect(TTS_MODELS).toContainEqual(
        expect.objectContaining({
          id: "kitten-nano-en-v0_1-fp16",
          backend: "kitten",
          files: expect.arrayContaining(["model.fp16.onnx", "voices.bin", "tokens.txt"]),
          downloadUrl: expect.stringContaining("kitten-nano-en-v0_1-fp16.tar.bz2"),
        }),
      );
    });

    it("includes official Inflect Nano and Micro ONNX models", () => {
      expect(TTS_MODELS).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "inflect-nano-v2-onnx",
            backend: "inflect",
            files: ["duration.onnx", "decode.onnx"],
            repository: "owensong/Inflect-Nano-v2-ONNX",
          }),
          expect.objectContaining({
            id: "inflect-micro-v2-onnx",
            backend: "inflect",
            files: ["duration.onnx", "decode.onnx"],
            repository: "owensong/Inflect-Micro-v2-ONNX",
          }),
        ]),
      );
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

  describe("Inflect frontend", () => {
    it("preserves punctuation around phonemized text", () => {
      const phonemize = vi.fn((text: string) => `<${text}>`);

      expect(buildInflectPhonemeText("Hello, world!", phonemize)).toBe("<Hello>, <world>!");
      expect(phonemize).toHaveBeenNthCalledWith(1, "Hello");
      expect(phonemize).toHaveBeenNthCalledWith(2, "world");
    });

    it("maps known symbols and inserts VITS blank tokens", () => {
      const tokens = inflectTextToTokens("a.");

      expect(tokens.length).toBe(5);
      expect(tokens[0]).toBe(0);
      expect(tokens[2]).toBe(0);
      expect(tokens[4]).toBe(0);
      expect(tokens[1]).not.toBe(0);
      expect(tokens[3]).not.toBe(0);
    });

    it("drops unsupported phoneme formatting characters", () => {
      expect(inflectTextToTokens("a͡ɪ")).toEqual(inflectTextToTokens("aɪ"));
    });

    it("splits long text at sentence and punctuation boundaries", () => {
      expect(splitInflectText("First sentence. Second sentence!", 20)).toEqual([
        "First sentence.",
        "Second sentence!",
      ]);
      expect(splitInflectText("one two three four five six", 15)).toEqual([
        "one two three",
        "four five six",
      ]);
    });

    it("generates deterministic Gaussian latent noise", () => {
      const first = createInflectGaussianSamples(6, 7);
      const second = createInflectGaussianSamples(6, 7);
      const different = createInflectGaussianSamples(6, 8);

      expect(first).toEqual(second);
      expect(first).not.toEqual(different);
      expect([...first].every(Number.isFinite)).toBe(true);
    });

    it("encodes generated samples as a 24 kHz PCM WAV", () => {
      const wav = encodePcm16Wave(Float32Array.from([-1, 0, 1]), 24_000);

      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.readUInt32LE(40)).toBe(6);
      expect(wav.readInt16LE(44)).toBe(-32_768);
      expect(wav.readInt16LE(46)).toBe(0);
      expect(wav.readInt16LE(48)).toBe(32_767);
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

  describe("resolveVoiceConfigPath", () => {
    it("uses the global Pi extension config directory by default", () => {
      expect(resolveVoiceConfigPath({}, "/home/zero")).toBe(
        "/home/zero/.pi/agent/extensions/voice/config.json",
      );
    });

    it("uses a trimmed PI_VOICE_CONFIG override", () => {
      expect(
        resolveVoiceConfigPath({ PI_VOICE_CONFIG: "  /custom/voice.json  " }, "/home/zero"),
      ).toBe("/custom/voice.json");
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

  describe("voice settings modal", () => {
    it("shows the voice route, selected models, and connection status", async () => {
      const modelsDir = createDownloadedVoiceModels();
      const ctx = createMockCommandContext();
      let component:
        | { render(width: number): string[]; handleInput?(data: string): void }
        | undefined;
      ctx.ui.custom = vi.fn(async (factory) => {
        component = await factory({ requestRender: vi.fn() }, createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_1-fp16",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: true, hasArecord: false },
        playbackReady: false,
        source: "studio-mic",
        onModelSelect: vi.fn(),
        onTtsModelSelect: vi.fn(),
        onSpeakerSelect: vi.fn(),
      });

      expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: {
          width: "78%",
          minWidth: 72,
          maxHeight: "78%",
          anchor: "center",
          margin: { top: 1, bottom: 1, left: 2, right: 2 },
        },
        onHandle: expect.any(Function),
      });
      const renderedLines = component?.render(72) ?? [];
      const rendered = renderedLines.join("\n");
      expect(renderedLines[0]).toContain("╭── Voice ");
      expect(renderedLines.at(-1)).toBe(`╰${"─".repeat(70)}╯`);
      expect(renderedLines.every((line) => line.length === 72)).toBe(true);
      expect(rendered).not.toContain("FOCUSED");
      expect(rendered).toContain("Voice");
      expect(rendered).toContain("local audio · MIC → TEXT → SPEECH");
      expect(rendered).toContain("─".repeat(66));
      expect(rendered).toContain("Dictation model");
      expect(rendered).toContain("Moonshine Base · Ready");
      expect(rendered).toContain("Speech model");
      expect(rendered).toContain("Kitten Nano · Ready");
      expect(rendered).toContain("Local voice");
      expect(rendered).toContain("Recording input");
      expect(rendered).toContain("studio-mic · Ready");
      expect(rendered).toContain("Speech output");
      expect(rendered).toContain("Not connected");
    });

    it("changes settings with arrow and Enter keys", async () => {
      const modelsDir = createDownloadedVoiceModels();
      const ctx = createMockCommandContext();
      const onModelSelect = vi.fn();
      const onTtsModelSelect = vi.fn();
      const onSpeakerSelect = vi.fn();
      let component:
        | { handleInput?(data: string): void; render(width: number): string[] }
        | undefined;
      ctx.ui.custom = vi.fn(async (factory) => {
        component = await factory({ requestRender: vi.fn() }, createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_1-fp16",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: true, hasArecord: false },
        playbackReady: true,
        source: "default",
        onModelSelect,
        onTtsModelSelect,
        onSpeakerSelect,
      });

      component?.handleInput?.("\r");
      component?.handleInput?.("\x1b[B");
      component?.handleInput?.("\r");
      component?.handleInput?.("\x1b[B");
      component?.handleInput?.("\r");

      expect(onModelSelect).toHaveBeenCalledWith("whisper-tiny-en-int8");
      expect(onTtsModelSelect).toHaveBeenCalledWith("inflect-nano-v2-onnx");
      expect(onSpeakerSelect).not.toHaveBeenCalled();
      expect(component?.render(72).join("\n")).toContain("Fixed voice");
    });

    it("skips missing models while cycling through available choices", async () => {
      const modelsDir = createDownloadedVoiceModels();
      const missingModel = MODELS[1];
      if (!missingModel) throw new Error("Missing dictation model fixture");
      rmSync(join(modelsDir, missingModel.dirName), { recursive: true });
      const ctx = createMockCommandContext();
      const onModelSelect = vi.fn();
      const getComponent = captureCustomComponent(ctx);

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_1-fp16",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: true, hasArecord: false },
        playbackReady: true,
        source: "default",
        onModelSelect,
        onTtsModelSelect: vi.fn(),
        onSpeakerSelect: vi.fn(),
      });
      const component = getComponent();
      component.handleInput?.("\r");

      expect(onModelSelect).toHaveBeenCalledWith("whisper-small-en-int8");
    });

    it("rejects a missing model and restores the previous selection", async () => {
      const modelsDir = mkdtempSync(join(tmpdir(), "pi-voice-missing-"));
      const ctx = createMockCommandContext();
      const onModelSelect = vi.fn();
      let component:
        | { handleInput?(data: string): void; render(width: number): string[] }
        | undefined;
      ctx.ui.custom = vi.fn(async (factory) => {
        component = await factory({ requestRender: vi.fn() }, createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_1-fp16",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: false, hasArecord: false },
        playbackReady: false,
        source: "default",
        onModelSelect,
        onTtsModelSelect: vi.fn(),
        onSpeakerSelect: vi.fn(),
      });
      component?.handleInput?.("\r");

      expect(onModelSelect).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("is not downloaded"),
        "error",
      );
      expect(component?.render(72).join("\n")).toContain("Moonshine Base · Missing");
    });

    it("requires TUI mode", async () => {
      const ctx = createMockCommandContext();
      ctx.mode = "print";

      await runVoiceSettings("", ctx, {
        onModelSelect: vi.fn(),
        onTtsModelSelect: vi.fn(),
        onSpeakerSelect: vi.fn(),
      });

      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith("Voice settings require TUI mode.", "error");
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

  describe("handler wiring", () => {
    it("/voice opens the dictation overlay like holding Space", async () => {
      const modelsDir = mkdtempSync(join(tmpdir(), "pi-voice-empty-models-"));
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const ctx = createMockCommandContext();

      await getCommandHandler(mockPi, "voice")("", ctx);

      // No model is downloaded, so the overlay reports setup guidance and stops.
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Open /voice:settings"),
        "error",
      );
    });

    it("/voice:settings persists dictation, speech, and Kitten voice settings", async () => {
      const configPath = join(mkdtempSync(join(tmpdir(), "pi-voice-config-")), "config.json");
      const modelsDir = createDownloadedVoiceModels(false);
      vi.stubEnv("PI_VOICE_CONFIG", configPath);
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const firstPi = createMockPi();
      await voiceExtension(firstPi);
      const firstHandler = getCommandHandler(firstPi, "voice:settings");
      const firstCtx = createMockCommandContext();
      const getFirstComponent = captureCustomComponent(firstCtx);

      await firstHandler("", firstCtx);
      const firstComponent = getFirstComponent();
      firstComponent.handleInput?.("\x1b[B");
      firstComponent.handleInput?.("\x1b[B");
      firstComponent.handleInput?.("\r");
      firstComponent.handleInput?.("\x1b[A");
      firstComponent.handleInput?.("\r");
      firstComponent.handleInput?.("\x1b[A");
      firstComponent.handleInput?.("\r");

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        voice: "expr-voice-2-f",
        ttsModel: "inflect-nano-v2-onnx",
        dictationModel: "whisper-tiny-en-int8",
      });

      const restartedPi = createMockPi();
      await voiceExtension(restartedPi);
      const restartedHandler = getCommandHandler(restartedPi, "voice:settings");
      const restartedCtx = createMockCommandContext();
      const getRestartedComponent = captureCustomComponent(restartedCtx);

      await restartedHandler("", restartedCtx);

      const rendered = getRestartedComponent().render(72).join("\n");
      expect(rendered).toContain("Whisper Tiny · Ready");
      expect(rendered).toContain("Inflect Nano v2 · Ready");
      expect(rendered).toContain("Fixed voice");
    });

    it.each([
      ["malformed JSON", "{"],
      [
        "unknown settings",
        JSON.stringify({
          voice: "not-a-kitten-voice",
          ttsModel: "unknown-tts-model",
          dictationModel: "unknown-dictation-model",
        }),
      ],
    ])("/voice:settings uses defaults for %s", async (_case, contents) => {
      const configPath = join(mkdtempSync(join(tmpdir(), "pi-voice-config-")), "config.json");
      writeFileSync(configPath, contents);
      vi.stubEnv("PI_VOICE_CONFIG", configPath);
      vi.stubEnv("PI_VOICE_MODELS", mkdtempSync(join(tmpdir(), "pi-voice-empty-models-")));
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice:settings");
      const ctx = createMockCommandContext();
      const getComponent = captureCustomComponent(ctx);

      await handler("", ctx);

      const rendered = getComponent().render(72).join("\n");
      expect(rendered).toContain("Moonshine Base · Missing");
      expect(rendered).toContain("Kitten Nano · Missing");
      expect(rendered).toContain("Voice 2 · Masculine");
    });

    it("/voice:settings reports config write failures and restores the displayed value", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "pi-voice-config-"));
      const blockingFile = join(configDir, "not-a-directory");
      writeFileSync(blockingFile, "blocked");
      vi.stubEnv("PI_VOICE_CONFIG", join(blockingFile, "config.json"));
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice:settings");
      const ctx = createMockCommandContext();
      const getComponent = captureCustomComponent(ctx);

      await handler("", ctx);
      const component = getComponent();
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\r");

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Could not save local voice"),
        "error",
      );
      expect(component.render(72).join("\n")).toContain("Voice 2 · Masculine");
    });

    it("does not register a voice-specific summary model command", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const names = mockPi.registerCommand.mock.calls.map((call: unknown[]) => call[0]);

      expect(names).not.toContain("voice-summary-model");
    });

    it("/voice:stop reports when playback is already idle", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice:stop");
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

function createDownloadedVoiceModels(includeDefaultDictationModel = true): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-models-"));
  for (const model of [...MODELS, ...TTS_MODELS]) {
    if (!includeDefaultDictationModel && model.id === "moonshine-base-int8") continue;
    mkdirSync(join(dir, model.dirName), { recursive: true });
    for (const file of model.files) {
      const path = join(dir, model.dirName, file);
      if (file === "espeak-ng-data") mkdirSync(path, { recursive: true });
      else writeFileSync(path, "stub");
    }
  }
  return dir;
}

interface TestComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
}

function captureCustomComponent(
  ctx: ReturnType<typeof createMockCommandContext>,
): () => TestComponent {
  let component: TestComponent | undefined;
  ctx.ui.custom = vi.fn(async (factory) => {
    component = await factory({ requestRender: vi.fn() }, createTestTheme(), {}, vi.fn());
    return undefined;
  });
  return () => {
    if (!component) throw new Error("Custom component was not created");
    return component;
  };
}

function createTestTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}
