import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { isKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePcm16Wave } from "../../extensions/voice/src/audio.ts";
import {
  loadActiveSpeakerId,
  resolveModelsDir,
  resolveSource,
  resolveVoiceConfigPath,
  saveActiveVoice,
} from "../../extensions/voice/src/config.ts";
import { SAMPLE_RATE } from "../../extensions/voice/src/constants.ts";
import { addHoldToVoice } from "../../extensions/voice/src/hold.ts";
import {
  buildInflectPhonemeText,
  createInflectGaussianSamples,
  inflectTextToTokens,
  splitInflectText,
} from "../../extensions/voice/src/inflect.ts";
import {
  buildKittenConfig,
  buildOfflineConfig,
  buildSupertonicConfig,
  buildTtsConfig,
  getModel,
  MODELS,
  modelIsDownloaded,
  TTS_MODELS,
} from "../../extensions/voice/src/models.ts";
import { runVoiceOverlay } from "../../extensions/voice/src/overlay.ts";
import { describeRecorderBackend, runVoiceSettings } from "../../extensions/voice/src/settings.ts";
import {
  buildSpokenSummaryPrompt,
  cleanTextForSpeech,
  findLatestAssistantText,
  runVoiceSpeak,
  summarizeForSpeech,
} from "../../extensions/voice/src/summary.ts";
import {
  isHallucination,
  SttEngine,
  splitSamples,
  stripRepetitionLoop,
  transcribeFile,
} from "../../extensions/voice/src/transcription.ts";
import type { SherpaOnnx } from "../../extensions/voice/src/types.ts";
import voiceExtension from "../../extensions/voice/voice.ts";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { createMockCommandContext, createMockModel } from "../mocks/context-mocks.ts";
import { mockFn } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import {
  fakeTui,
  getCommandHandler,
  getEventHandler,
  sessionEntries,
} from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: vi.fn(),
}));

/** Recorder fake: captures the overlay's chunk callback so a test can feed
 *  microphone samples without spawning a real ffmpeg/arecord child process,
 *  plus each fake recorder so tests can assert the overlay stopped it. */
const recorderHarness = vi.hoisted(() => {
  const chunkHandlers: Array<(samples: Float32Array, rms: number) => void> = [];
  const recorders: Array<{ stop: () => void }> = [];
  return {
    chunkHandlers,
    recorders,
    emit(samples: Float32Array): void {
      for (const handler of chunkHandlers) handler(samples, 0.5);
    },
  };
});

vi.mock("../../extensions/voice/src/audio.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extensions/voice/src/audio.ts")>();
  return {
    ...actual,
    startStreamingRecorder: vi.fn(
      (_source: string, _deps: unknown, onChunk: (samples: Float32Array, rms: number) => void) => {
        recorderHarness.chunkHandlers.push(onChunk);
        const recorder = { stop: vi.fn() };
        recorderHarness.recorders.push(recorder);
        return recorder;
      },
    ),
  };
});

/** Sherpa fake: records every OfflineTts engine config, so a test can assert
 *  which model each engine was built from. The native addon loads through
 *  createRequire, so the ESM module seam is the interception point. */
const sherpaHarness = vi.hoisted(() => {
  const configs: unknown[] = [];
  const createAsync = vi.fn(async (config: unknown) => {
    configs.push(config);
    return {
      generateAsync: async (): Promise<never> => {
        throw new Error("test playback suppressed");
      },
    };
  });
  return { configs, createAsync };
});

vi.mock("../../extensions/voice/src/native.ts", () => ({
  loadSherpa: () => ({
    OfflineTts: { createAsync: sherpaHarness.createAsync },
    GenerationConfig: class GenerationConfig {},
    writeWave: () => {},
  }),
  loadOnnxRuntime: () => ({}),
}));

beforeEach(() => {
  vi.stubEnv("HERDR_ENV", "");
  vi.stubEnv("PI_SMALL_MODEL", "test-provider/test-model");
  vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
});

/** Every mkdtemp directory this suite creates; afterEach removes them. */
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(completeSimple).mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(isKittyProtocolActive).mockReturnValue(false);
  // Test fixtures build stub model trees under /tmp; remove them so repeated
  // runs do not accumulate thousands of leftover directories.
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The editor layers under test never read these arguments.
const EDITOR_FACTORY_ARGS = [{}, {}, {}] as unknown as Parameters<EditorFactory>;

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
    it("inserts Space in Herdr when Kitty is active but no key release arrives", () => {
      vi.useFakeTimers();
      vi.stubEnv("HERDR_ENV", "1");
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });
      editor.handleInput("a");
      editor.handleInput(" ");
      editor.handleInput("b");
      vi.advanceTimersByTime(1100);
      expect(handleInput).toHaveBeenNthCalledWith(1, "a");
      expect(handleInput).toHaveBeenNthCalledWith(2, " ");
      expect(handleInput).toHaveBeenNthCalledWith(3, "b");
      expect(onHold).not.toHaveBeenCalled();
    });

    it("ignores optional Space releases in Herdr's repeat-based hold mode", () => {
      vi.useFakeTimers();
      vi.stubEnv("HERDR_ENV", "1");
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSpace: (data) => data === " " || data === "release",
        isRelease: (data) => data === "release",
        isRepeat: () => false,
      });
      editor.handleInput(" ");
      editor.handleInput("release");
      editor.handleInput("b");
      vi.advanceTimersByTime(1100);
      expect(handleInput).toHaveBeenCalledTimes(2);
      expect(handleInput).toHaveBeenNthCalledWith(1, " ");
      expect(handleInput).toHaveBeenNthCalledWith(2, "b");
      expect(onHold).not.toHaveBeenCalled();
    });

    it("keeps repeat-based hold-to-dictate working inside Herdr with Kitty active", () => {
      vi.useFakeTimers();
      vi.stubEnv("HERDR_ENV", "1");
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });
      editor.handleInput(" ");
      vi.advanceTimersByTime(300);
      editor.handleInput(" ");
      vi.advanceTimersByTime(700);
      expect(onHold).toHaveBeenCalledTimes(1);
      // The burst's first Space typed immediately and the trigger removed it.
      expect(handleInput.mock.calls.map((c) => c[0])).toEqual([" ", "\x7f"]);
    });

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

    it("types a lone Space immediately when key-release reporting is unavailable", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const editor = addHoldToVoice({ handleInput }, vi.fn(), {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });

      editor.handleInput(" ");
      expect(handleInput).toHaveBeenCalledWith(" "); // typed at once: no typing lag
      vi.advanceTimersByTime(1000);
      expect(handleInput).toHaveBeenCalledTimes(1);
    });

    it("opens voice from Space auto-repeat without key-release reporting", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
      });

      // A repeat arriving within the buffering window is a hold candidate.
      editor.handleInput(" ");
      vi.advanceTimersByTime(300);
      editor.handleInput(" ");
      vi.advanceTimersByTime(700);

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
      for (let elapsed = 100; elapsed <= 1000; elapsed += 100) {
        editor.handleInput(" ");
        vi.advanceTimersByTime(100);
      }

      expect(onHold).toHaveBeenCalledTimes(1);
    });

    it("does not re-trigger from the same hold while suppressed (e.g. overlay still tied to it)", () => {
      vi.useFakeTimers();
      let suppressed = false;
      const handleInput = vi.fn();
      // Simulate the extension marking the hold consumed when it opens the overlay.
      const onHold = vi.fn(() => {
        suppressed = true;
      });
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
        isSuppressed: () => suppressed,
      });

      const hold = (): void => {
        editor.handleInput(" ");
        vi.advanceTimersByTime(100);
        for (let elapsed = 100; elapsed < 1000; elapsed += 100) {
          editor.handleInput(" ");
          vi.advanceTimersByTime(100);
        }
      };

      hold();
      expect(onHold).toHaveBeenCalledTimes(1);

      // Overlay opens then closes (editor receives nothing); Space is still held.
      vi.advanceTimersByTime(2000);
      for (let i = 0; i < 10; i++) {
        editor.handleInput(" ");
        vi.advanceTimersByTime(100);
      }
      expect(onHold).toHaveBeenCalledTimes(1);

      // Once the key is released (suppression clears) a fresh hold fires again.
      suppressed = false;
      hold();
      expect(onHold).toHaveBeenCalledTimes(2);
    });

    it("cancels an armed hold when another key is typed before release", () => {
      vi.useFakeTimers();
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => true,
        isSpace: (data) => data === "space-press" || data === "space-release",
        isRelease: (data) => data.endsWith("-release"),
        isRepeat: () => false,
      });

      editor.handleInput("space-press");
      vi.advanceTimersByTime(500);
      editor.handleInput("a-press");
      vi.advanceTimersByTime(600);

      expect(onHold).not.toHaveBeenCalled();
      expect(handleInput).toHaveBeenCalledWith("a-press");
    });

    it("does not fire when Space was already released before the deadline", () => {
      vi.useFakeTimers();
      let keyDown = true;
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => true,
        isSpace: (data) => data === "space-press" || data === "space-release",
        isRelease: (data) => data === "space-release",
        isRepeat: () => false,
        isKeyDown: () => keyDown,
      });

      editor.handleInput("space-press");
      keyDown = false; // release event was never delivered to the editor
      vi.advanceTimersByTime(1000);

      expect(onHold).not.toHaveBeenCalled();
    });

    it("does not arm during cooldown and forwards Space as normal text", () => {
      vi.useFakeTimers();
      let canArm = false;
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => true,
        isSpace: (data) => data === "space-press" || data === "space-release",
        isRelease: (data) => data === "space-release",
        isRepeat: () => false,
        canArm: () => canArm,
      });

      editor.handleInput("space-press");
      vi.advanceTimersByTime(1000);
      editor.handleInput("space-release");

      expect(onHold).not.toHaveBeenCalled();
      expect(handleInput).toHaveBeenCalledWith(" ");

      canArm = true;
      editor.handleInput("space-press");
      vi.advanceTimersByTime(1000);
      expect(onHold).toHaveBeenCalledTimes(1);
    });

    it("does not count Space as a hold while cooldown is active", () => {
      vi.useFakeTimers();
      const canArm = false;
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
        canArm: () => canArm,
      });

      editor.handleInput(" ");
      vi.advanceTimersByTime(100);
      editor.handleInput(" ");
      vi.advanceTimersByTime(1000);

      expect(onHold).not.toHaveBeenCalled();
      expect(handleInput).toHaveBeenNthCalledWith(1, " ");
      expect(handleInput).toHaveBeenNthCalledWith(2, " ");
    });

    it("commits both spaces of a fast double Space when typing continues", () => {
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
      vi.advanceTimersByTime(150);
      editor.handleInput(" "); // looks like a repeat: buffered as hold candidate
      vi.advanceTimersByTime(100);
      editor.handleInput("a"); // typing resumes: commit buffered spaces, then the letter

      expect(handleInput.mock.calls.map((c) => c[0])).toEqual([" ", " ", "a"]);
      expect(onHold).not.toHaveBeenCalled();
    });

    it("types the first Space at once and removes it when the hold fires", () => {
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
      vi.advanceTimersByTime(100);
      editor.handleInput(" ");
      vi.advanceTimersByTime(100);
      editor.handleInput(" ");
      vi.advanceTimersByTime(800);

      expect(onHold).toHaveBeenCalledTimes(1);
      // The burst's first Space was typed immediately, so the trigger removes it.
      expect(handleInput.mock.calls.map((c) => c[0])).toEqual([" ", "\x7f"]);
    });

    it("keeps the typed Space when the hold does not fire because the key was already released", () => {
      vi.useFakeTimers();
      let keyDown = true;
      const handleInput = vi.fn();
      const onHold = vi.fn();
      const editor = addHoldToVoice({ handleInput }, onHold, {
        isSupported: () => false,
        isSpace: (data) => data === " ",
        isRelease: () => false,
        isRepeat: () => false,
        isKeyDown: () => keyDown,
      });

      editor.handleInput(" ");
      vi.advanceTimersByTime(100);
      editor.handleInput(" ");
      keyDown = false;
      vi.advanceTimersByTime(1000);

      expect(onHold).not.toHaveBeenCalled();
      expect(handleInput).toHaveBeenCalledTimes(1);
      expect(handleInput).toHaveBeenCalledWith(" ");
    });

    it("removes the burst Space once when the terminal hook opens voice first", () => {
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
      vi.advanceTimersByTime(100);
      editor.handleInput(" ");
      editor.purgeHoldSpaces?.();
      editor.purgeHoldSpaces?.(); // idempotent: only one removal
      vi.advanceTimersByTime(1000);

      expect(onHold).toHaveBeenCalledTimes(1);
      expect(handleInput.mock.calls.map((c) => c[0])).toEqual([" ", "\x7f"]);
    });

    it("starts a fresh Space burst after the repeat window passes", () => {
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
      editor.handleInput(" ");
      vi.advanceTimersByTime(1000);

      expect(handleInput).toHaveBeenCalledTimes(2);
      expect(handleInput).toHaveBeenNthCalledWith(1, " ");
      expect(handleInput).toHaveBeenNthCalledWith(2, " ");
      expect(onHold).not.toHaveBeenCalled();
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
      const previousFactory = mockFn<EditorFactory>(() => baseEditor);
      ctx.ui.setEditorComponent(previousFactory);
      ctx.ui.setEditorComponent.mockClear();
      await voiceExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);

      expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
      expect(ctx.ui.onTerminalInput).toHaveBeenCalledWith(expect.any(Function));
      const installedFactory = ctx.ui.getEditorComponent();
      expect(installedFactory?.(...EDITOR_FACTORY_ARGS)).toBe(baseEditor);
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
        (parent, tui, theme, keybindings) => {
          if (!parent) throw new Error("test-visual-layer needs a parent editor");
          return parent(tui, theme, keybindings);
        },
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
      const modelsDir = tempDir("pi-voice-global-hold-");
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

      expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Open /voice:settings"),
        "error",
      );
    });

    it("keeps holding across NX release-press repeat pairs", async () => {
      vi.useFakeTimers();
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const modelsDir = tempDir("pi-voice-nx-hold-");
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

    it("does not open voice from a lone Herdr Space even when Kitty is active", async () => {
      vi.useFakeTimers();
      vi.stubEnv("HERDR_ENV", "1");
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      await voiceExtension(mockPi);
      await getEventHandler(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");
      inputHandler(" ");
      vi.advanceTimersByTime(1100);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      await getEventHandler(mockPi, "session_shutdown")(
        { type: "session_shutdown", reason: "exit" },
        ctx,
      );
      expect(vi.getTimerCount()).toBe(0);
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

    it("does not reopen the overlay from a held Space after it closes", async () => {
      vi.useFakeTimers();
      const modelsDir = tempDir("pi-voice-holdreopen-");
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.ui.getEditorText = vi.fn(() => "  ");
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      };

      // Hold Space long enough to fire (model is missing -> notify + overlay).
      inputHandler(" ");
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

      // Overlay has closed. Keep holding Space: must NOT reopen.
      inputHandler(" ");
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

      // After release (gap with no Space) a fresh hold fires again, once the
      // post-close cooldown has expired.
      vi.advanceTimersByTime(1600);
      inputHandler(" ");
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    });

    it("does not reopen the overlay during cooldown after a close in kitty mode", async () => {
      vi.useFakeTimers();
      vi.mocked(isKittyProtocolActive).mockReturnValue(true);
      const modelsDir = tempDir("pi-voice-reopen-kitty-");
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      const mockPi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.ui.getEditorText = vi.fn(() => "prompt  ");
      await voiceExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      const inputHandler = ctx.ui.onTerminalInput.mock.calls[0]?.[0];
      if (!inputHandler) throw new Error("Terminal input handler was not installed");
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      };

      // Hold Space through the one-second deadline: overlay opens.
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

      // Panel closed. A fresh hold pressed immediately must NOT reopen it.
      inputHandler(" ");
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

      // Once the cooldown window passes, a held Space works again.
      vi.advanceTimersByTime(1600);
      inputHandler(" ");
      vi.advanceTimersByTime(1000);
      await flush();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
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
      const laterFactory = mockFn<EditorFactory>(() => laterEditor);
      ctx.ui.setEditorComponent(laterFactory);
      ctx.ui.setEditorComponent.mockClear();

      await vi.runAllTimersAsync();

      expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
      const installedFactory = ctx.ui.getEditorComponent();
      expect(installedFactory?.(...EDITOR_FACTORY_ARGS)).toBe(laterEditor);
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

    it("voice commands do nothing in non-UI mode", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await voiceExtension(mockPi);
      for (const command of ["voice", "voice:settings", "voice:speak", "voice:stop"]) {
        await getCommandHandler(mockPi, command)("", mockCtx);
      }
      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
      expect(mockCtx.ui.setWidget).not.toHaveBeenCalled();
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

    it("joins multiple text blocks with newlines", () => {
      const text = findLatestAssistantText([
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Line one." },
              { type: "text", text: "Line two." },
            ],
          },
        },
      ]);

      expect(text).toBe("Line one.\nLine two.");
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
      const smallModel = createMockModel({
        id: "small-model",
        provider: "small-provider",
        reasoning: true,
      });
      vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
      ctx.modelRegistry.find = vi.fn(() => smallModel);
      vi.mocked(completeSimple).mockResolvedValue(
        fauxAssistantMessage([{ type: "text", text: "**Short result.** Next, test playback." }]),
      );

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
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          { type: "message", message: { role: "assistant", content: "A detailed answer." } },
        ]),
      );
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

    it("shows a Thinking-style speaking indicator widget during speech, then clears it", async () => {
      const dir = createDownloadedTtsModel();
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          { type: "message", message: { role: "assistant", content: "A detailed answer." } },
        ]),
      );
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("", ctx, {
        modelsDir: dir,
        summarize: async () => "A short summary.",
        speak,
        speakerId: 0,
      });

      const calls = ctx.ui.setWidget.mock.calls.filter((call) => call[0] === "voice-speak");
      // preparing → speaking → cleared
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls[calls.length - 1]?.[1]).toBeUndefined();

      const rendered = calls
        .filter((call) => typeof call[1] === "function")
        .map((call) => {
          const factory = call[1] as (
            tui: unknown,
            theme: unknown,
          ) => { render: (width: number) => string[] };
          const component = factory(fakeTui(), {
            fg: (_color: string, text: string) => text,
          });
          return component.render(80).join("\n");
        })
        .join("\n");
      expect(rendered).toContain("Preparing speech");
      expect(rendered).toContain("Speaking");
      // The old footer status line is gone.
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });

    it("speaks the cleaned full message without calling the summary model", async () => {
      const dir = createDownloadedTtsModel();
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          {
            type: "message",
            message: { role: "assistant", content: "**Done.** `npm test` passes." },
          },
        ]),
      );
      const summarize = vi.fn();
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("full", ctx, { modelsDir: dir, summarize, speak, speakerId: 0 });

      expect(summarize).not.toHaveBeenCalled();
      expect(speak).toHaveBeenCalledWith("Done. npm test passes.", 0);
    });

    it("accepts a downloaded Inflect model for speech", async () => {
      const dir = tempDir("pi-voice-inflect-");
      const modelDir = join(dir, "inflect-nano-v2-onnx");
      mkdirSync(modelDir);
      writeFileSync(join(modelDir, "duration.onnx"), "stub");
      writeFileSync(join(modelDir, "decode.onnx"), "stub");
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          { type: "message", message: { role: "assistant", content: "Inflect response." } },
        ]),
      );
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

    it("accepts a downloaded Supertonic model for speech", async () => {
      const dir = tempDir("pi-voice-supertonic-");
      const modelDir = join(dir, "sherpa-onnx-supertonic-3-tts-int8-2026-05-11");
      mkdirSync(modelDir);
      for (const file of [
        "duration_predictor.int8.onnx",
        "text_encoder.int8.onnx",
        "vector_estimator.int8.onnx",
        "vocoder.int8.onnx",
        "tts.json",
        "unicode_indexer.bin",
        "voice.bin",
      ]) {
        writeFileSync(join(modelDir, file), "stub");
      }
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          { type: "message", message: { role: "assistant", content: "Supertonic response." } },
        ]),
      );
      const speak = vi.fn(async () => {});

      await runVoiceSpeak("full", ctx, {
        modelsDir: dir,
        ttsModelId: "supertonic-3-int8",
        summarize: vi.fn(),
        speak,
        speakerId: 3,
      });

      expect(speak).toHaveBeenCalledWith("Supertonic response.", 3);
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
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([{ type: "message", message: { role: "assistant", content: "Answer" } }]),
      );
      await runVoiceSpeak("", ctx, {
        modelsDir: tempDir("pi-voice-no-tts-"),
        summarize: vi.fn(),
        speak: vi.fn(),
        speakerId: 0,
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Kitten Nano"), "error");
    });
  });

  describe("TTS model registry", () => {
    it("includes Kitten Nano v0.8 with its required files and download URL", () => {
      expect(TTS_MODELS).toContainEqual(
        expect.objectContaining({
          id: "kitten-nano-en-v0_8-int8",
          backend: "kitten",
          files: expect.arrayContaining(["model.int8.onnx", "voices.bin", "tokens.txt"]),
          modelFile: "model.int8.onnx",
          speakerCount: 8,
          downloadUrl: expect.stringContaining("kitten-nano-en-v0_8-int8.tar.bz2"),
        }),
      );
    });

    it("includes Supertonic 3 with ten voices and its multi-file layout", () => {
      expect(TTS_MODELS).toContainEqual(
        expect.objectContaining({
          id: "supertonic-3-int8",
          backend: "supertonic",
          files: expect.arrayContaining([
            "duration_predictor.int8.onnx",
            "text_encoder.int8.onnx",
            "vector_estimator.int8.onnx",
            "vocoder.int8.onnx",
            "tts.json",
            "unicode_indexer.bin",
            "voice.bin",
          ]),
          speakerCount: 10,
          downloadUrl: expect.stringContaining(
            "sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
          ),
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
      const kitten = TTS_MODELS.find((model) => model.backend === "kitten");
      if (!kitten) throw new Error("Missing kitten model");
      const config = buildKittenConfig(kitten, "/models", 4) as {
        model: {
          kitten: { model: string; voices: string; tokens: string; dataDir: string };
          numThreads: number;
          provider: string;
        };
      };
      expect(config.model.kitten.model).toBe("/models/kitten-nano-en-v0_8-int8/model.int8.onnx");
      expect(config.model.kitten.voices).toContain("voices.bin");
      expect(config.model.kitten.tokens).toContain("tokens.txt");
      expect(config.model.kitten.dataDir).toContain("espeak-ng-data");
      expect(config.model.numThreads).toBe(4);
      expect(config.model.provider).toBe("cpu");
    });

    it("builds a sherpa Supertonic configuration", () => {
      const supertonic = TTS_MODELS.find((model) => model.backend === "supertonic");
      if (!supertonic) throw new Error("Missing supertonic model");
      const config = buildSupertonicConfig(supertonic, "/models", 4) as {
        model: {
          supertonic: Record<string, string>;
          numThreads: number;
          provider: string;
        };
      };
      expect(config.model.supertonic.durationPredictor).toBe(
        "/models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/duration_predictor.int8.onnx",
      );
      expect(config.model.supertonic.ttsJson).toContain("tts.json");
      expect(config.model.supertonic.voiceStyle).toContain("voice.bin");
      expect(config.model.numThreads).toBe(4);
      expect(config.model.provider).toBe("cpu");
    });

    it("buildTtsConfig dispatches by backend", () => {
      const kitten = TTS_MODELS.find((model) => model.backend === "kitten");
      const supertonic = TTS_MODELS.find((model) => model.backend === "supertonic");
      if (!kitten || !supertonic) throw new Error("Missing TTS models");
      expect(buildTtsConfig(kitten, "/models", 2)).toEqual(buildKittenConfig(kitten, "/models", 2));
      expect(buildTtsConfig(supertonic, "/models", 2)).toEqual(
        buildSupertonicConfig(supertonic, "/models", 2),
      );
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
      expect(getModel("moonshine-v2-base-en")?.kind).toBe("offline");
      expect(getModel("moonshine-base-int8")?.kind).toBe("offline");
      expect(getModel("whisper-tiny-en-int8")?.kind).toBe("offline");
      expect(getModel("does-not-exist")).toBeUndefined();
    });

    it("includes Moonshine v2, Parakeet, and the legacy models", () => {
      expect(MODELS.map((model) => model.id)).toEqual([
        "moonshine-v2-base-en",
        "moonshine-v2-tiny-en",
        "parakeet-tdt-0.6b-v2-int8",
        "moonshine-base-int8",
        "whisper-tiny-en-int8",
        "whisper-small-en-int8",
      ]);
    });

    it("modelIsDownloaded is false when files are missing", () => {
      const dir = tempDir("pi-voice-empty-");
      const model = getModel("moonshine-base-int8")!;
      expect(modelIsDownloaded(dir, model)).toBe(false);
    });

    it("modelIsDownloaded is true when every required file exists", () => {
      const dir = tempDir("pi-voice-full-");
      const model = getModel("whisper-tiny-en-int8")!;
      mkdirSync(join(dir, model.dirName), { recursive: true });
      for (const file of model.files) {
        writeFileSync(join(dir, model.dirName, file), "stub");
      }
      expect(modelIsDownloaded(dir, model)).toBe(true);
    });
  });

  describe("moonshine v2 length cap", () => {
    // sherpa-onnx 1.13.8 returns empty transcripts for Moonshine v2 decodes
    // longer than ~9.2s; the engine must chunk audio below that.
    const MAX_SEC = 9;

    function chunkingFakeSherpa(text: string, sampleRate = 16000) {
      const decodeLengths: number[] = [];
      const vadConfigs: number[] = [];
      const stream = {
        acceptWaveform: (waveform: { samples: Float32Array }) => {
          decodeLengths.push(waveform.samples.length);
        },
      };
      const fake = {
        decodeLengths,
        vadConfigs,
        readWave: () => ({ samples: new Float32Array(sampleRate * 12), sampleRate }),
        writeWave: () => {},
        Vad: class {
          constructor(config: { sileroVad: { maxSpeechDuration: number } }) {
            vadConfigs.push(config.sileroVad.maxSpeechDuration);
          }
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
      return {
        fake,
        asSherpa: () => fake as unknown as SherpaOnnx,
      };
    }

    it("splitSamples keeps short audio as one chunk", () => {
      const samples = new Float32Array(16000 * 5);
      expect(splitSamples(samples, 16000, MAX_SEC)).toEqual([samples]);
    });

    it("splitSamples splits long audio into capped chunks", () => {
      const samples = new Float32Array(16000 * 25);
      const chunks = splitSamples(samples, 16000, MAX_SEC);
      expect(chunks.length).toBe(3);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_SEC * 16000);
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(total).toBe(samples.length);
    });

    it("SttEngine chunks long moonshine v2 input below the cap", () => {
      const model = getModel("moonshine-v2-base-en");
      if (!model) throw new Error("Missing moonshine v2 model");
      const { fake, asSherpa } = chunkingFakeSherpa("chunk text");
      const engine = new SttEngine(asSherpa(), model, "/models", 2);

      const text = engine.recognize(new Float32Array(16000 * 12), 16000);

      expect(text).toBe("chunk text chunk text");
      expect(fake.decodeLengths.length).toBe(2);
      for (const length of fake.decodeLengths) {
        expect(length).toBeLessThanOrEqual(MAX_SEC * 16000);
      }
    });

    it("SttEngine does not chunk models without a cap", () => {
      const model = getModel("whisper-tiny-en-int8");
      if (!model) throw new Error("Missing whisper model");
      const { fake, asSherpa } = chunkingFakeSherpa("whole text");
      const engine = new SttEngine(asSherpa(), model, "/models", 2);

      const text = engine.recognize(new Float32Array(16000 * 12), 16000);

      expect(text).toBe("whole text");
      expect(fake.decodeLengths.length).toBe(1);
      expect(fake.decodeLengths[0]).toBe(16000 * 12);
    });

    it("transcribeFile uses the capped VAD duration for moonshine v2", () => {
      const model = getModel("moonshine-v2-base-en");
      if (!model) throw new Error("Missing moonshine v2 model");
      const capped = chunkingFakeSherpa("text");
      transcribeFile(capped.asSherpa(), model, "/models-without-vad", "/audio.wav");
      expect(capped.fake.vadConfigs).toEqual([]); // no VAD model in dir, so none built

      const sherpa = chunkingFakeSherpa("text");
      const dir = tempDir("pi-voice-vad-");
      writeFileSync(join(dir, "silero_vad.onnx"), "stub");
      transcribeFile(sherpa.asSherpa(), model, dir, "/audio.wav");
      expect(sherpa.fake.vadConfigs).toEqual([MAX_SEC]);
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
      expect(resolveModelsDir({})).toBe(join(homedir(), ".cache", "pi-voice", "models"));
    });

    it("honors XDG_CACHE_HOME when set", () => {
      expect(resolveModelsDir({ XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/pi-voice/models");
    });
  });

  describe("speaker persistence", () => {
    it("restores a numeric Supertonic speaker index within range", () => {
      const configPath = join(tempDir("pi-voice-speaker-"), "config.json");
      writeFileSync(configPath, JSON.stringify({ ttsModel: "supertonic-3-int8", voice: 3 }));
      expect(loadActiveSpeakerId(configPath)).toBe(3);
    });

    it("clamps an out-of-range numeric speaker index to the first voice", () => {
      const configPath = join(tempDir("pi-voice-speaker-"), "config.json");
      writeFileSync(configPath, JSON.stringify({ ttsModel: "supertonic-3-int8", voice: 42 }));
      expect(loadActiveSpeakerId(configPath)).toBe(0);
    });

    it("still restores named Kitten voices", () => {
      const configPath = join(tempDir("pi-voice-speaker-"), "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({ ttsModel: "kitten-nano-en-v0_8-int8", voice: "expr-voice-4-f" }),
      );
      expect(loadActiveSpeakerId(configPath)).toBe(5);
    });
  });

  describe("voice config writes", () => {
    it("writes config atomically through the public save path", async () => {
      const configPath = join(tempDir("pi-voice-config-"), "nested", "config.json");

      await saveActiveVoice(configPath, "expr-voice-4-f");

      const content = readFileSync(configPath, "utf8");
      expect(JSON.parse(content)).toEqual({ voice: "expr-voice-4-f" });
      // Byte-identical to the shared atomic writer's canonical output.
      expect(content).toBe(JSON.stringify({ voice: "expr-voice-4-f" }, null, 2));
      // The voice config may hold user identity details; it stays 0600.
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    });
  });

  describe("resolveVoiceConfigPath", () => {
    it("uses the global Pi agent directory by default", () => {
      expect(resolveVoiceConfigPath({}, "/home/zero/.pi/agent")).toBe(
        "/home/zero/.pi/agent/voice.json",
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

    it("buildOfflineConfig uses the merged decoder for Moonshine v2 models", () => {
      const model = getModel("moonshine-v2-base-en");
      if (!model) throw new Error("Missing moonshine v2 model");
      const config = buildOfflineConfig(model, "/m", 2) as {
        modelConfig: {
          moonshine: { encoder: string; mergedDecoder: string; preprocessor?: string };
          tokens: string;
        };
      };
      expect(config.modelConfig.moonshine.encoder).toContain("encoder_model.ort");
      expect(config.modelConfig.moonshine.mergedDecoder).toContain("decoder_model_merged.ort");
      expect(config.modelConfig.moonshine.preprocessor).toBeUndefined();
      expect(config.modelConfig.tokens).toContain("tokens.txt");
    });

    it("buildOfflineConfig builds a NeMo transducer config for Parakeet", () => {
      const model = getModel("parakeet-tdt-0.6b-v2-int8");
      if (!model) throw new Error("Missing parakeet model");
      const config = buildOfflineConfig(model, "/m", 2) as {
        modelConfig: {
          transducer: { encoder: string; decoder: string; joiner: string };
          modelType: string;
          tokens: string;
        };
      };
      expect(config.modelConfig.transducer.encoder).toContain("encoder.int8.onnx");
      expect(config.modelConfig.transducer.decoder).toContain("decoder.int8.onnx");
      expect(config.modelConfig.transducer.joiner).toContain("joiner.int8.onnx");
      expect(config.modelConfig.modelType).toBe("nemo_transducer");
      expect(config.modelConfig.tokens).toContain("tokens.txt");
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
      const dir = tempDir("pi-voice-offline-");
      const model = getModel("whisper-tiny-en-int8")!;
      mkdirSync(join(dir, model.dirName), { recursive: true });
      for (const file of model.files) writeFileSync(join(dir, model.dirName, file), "stub");
      const result = transcribeFile(fakeSherpa("a sentence"), model, dir, "/fake.wav");
      expect(result.text).toBe("a sentence");
      expect(result.modelId).toBe("whisper-tiny-en-int8");
    });

    it("throws on empty audio", () => {
      const dir = tempDir("pi-voice-empty-audio-");
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
      ctx.ui.custom = mockFn(async (factory) => {
        component = await factory(fakeTui(), createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_8-int8",
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
      expect(renderedLines.every((line) => visibleWidth(line) === 72)).toBe(true);
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
      ctx.ui.custom = mockFn(async (factory) => {
        component = await factory(fakeTui(), createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_8-int8",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: true, hasArecord: false },
        playbackReady: true,
        source: "default",
        onModelSelect,
        onTtsModelSelect,
        onSpeakerSelect,
      });

      // Saves run through the async atomic writer; flush after each Enter so
      // each change settles before the next key, matching real key timing.
      const flushSaves = () => new Promise((resolve) => setTimeout(resolve, 0));
      component?.handleInput?.("\r");
      await flushSaves();
      component?.handleInput?.("\x1b[B");
      component?.handleInput?.("\r");
      await flushSaves();
      component?.handleInput?.("\r");
      await flushSaves();
      component?.handleInput?.("\x1b[B");
      component?.handleInput?.("\r");
      await flushSaves();

      expect(onModelSelect).toHaveBeenCalledWith("whisper-tiny-en-int8");
      // Kitten cycles to Supertonic, then to Inflect's fixed voice.
      expect(onTtsModelSelect).toHaveBeenNthCalledWith(1, "supertonic-3-int8");
      expect(onTtsModelSelect).toHaveBeenNthCalledWith(2, "inflect-nano-v2-onnx");
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
        activeModelId: "moonshine-v2-base-en",
        activeTtsModelId: "kitten-nano-en-v0_8-int8",
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

      expect(onModelSelect).toHaveBeenCalledWith("parakeet-tdt-0.6b-v2-int8");
    });

    it("rejects a missing model and restores the previous selection", async () => {
      const modelsDir = tempDir("pi-voice-missing-");
      const ctx = createMockCommandContext();
      const onModelSelect = vi.fn();
      let component:
        | { handleInput?(data: string): void; render(width: number): string[] }
        | undefined;
      ctx.ui.custom = mockFn(async (factory) => {
        component = await factory(fakeTui(), createTestTheme(), {}, vi.fn());
        return undefined;
      });

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-base-int8",
        activeTtsModelId: "kitten-nano-en-v0_8-int8",
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

    it("cycles Supertonic voices by speaker index", async () => {
      const modelsDir = createDownloadedVoiceModels();
      const ctx = createMockCommandContext();
      const onSpeakerSelect = vi.fn();
      const getComponent = captureCustomComponent(ctx);

      await runVoiceSettings("", ctx, {
        modelsDir,
        activeModelId: "moonshine-v2-base-en",
        activeTtsModelId: "supertonic-3-int8",
        activeSpeakerId: 0,
        recorder: { hasFfmpeg: true, hasArecord: false },
        playbackReady: true,
        source: "default",
        onModelSelect: vi.fn(),
        onTtsModelSelect: vi.fn(),
        onSpeakerSelect,
      });
      const component = getComponent();
      const rendered = component.render(72).join("\n");
      expect(rendered).toMatch(/Speech model +Supertonic 3 · Ready/);
      expect(rendered).toMatch(/Local voice +Voice 1/);

      // Move down to the voice row and cycle to the second speaker.
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\r");

      expect(onSpeakerSelect).toHaveBeenCalledWith(1);
      expect(component.render(72).join("\n")).toContain("Voice 2");
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

  describe("voice overlay partial transcription", () => {
    it("notifies once when live partial transcription fails", async () => {
      vi.useFakeTimers();
      const modelsDir = createDownloadedVoiceModels();
      const ctx = createMockCommandContext();
      let releaseOverlay: ((result: string | null) => void) | undefined;
      ctx.ui.custom = mockFn((factory) => {
        factory(fakeTui(), createTestTheme(), {}, vi.fn());
        return new Promise<string | null>((resolve) => {
          releaseOverlay = resolve;
        });
      });
      const stt = {
        recognize: vi.fn((): string => {
          throw new Error("decode exploded");
        }),
      } as unknown as SttEngine;

      const overlay = runVoiceOverlay("", ctx, {
        modelsDir,
        sherpa: {} as SherpaOnnx,
        recorder: { hasFfmpeg: true, hasArecord: false },
        stt,
      });
      recorderHarness.emit(new Float32Array(SAMPLE_RATE));
      vi.advanceTimersByTime(2000);

      // The first failure surfaces as a single warning naming the cause.
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("decode exploded"),
        "warning",
      );
      expect(stt.recognize).toHaveBeenCalledTimes(1);

      // Later intervals do not retry the failing engine or repeat the warning.
      vi.advanceTimersByTime(8000);
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(stt.recognize).toHaveBeenCalledTimes(1);

      // After the overlay closes no timer still calls into the failed engine.
      releaseOverlay?.(null);
      await overlay;
      vi.advanceTimersByTime(8000);
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(stt.recognize).toHaveBeenCalledTimes(1);
    });
  });

  describe("voice overlay cleanup", () => {
    it("stops the recorder and clears timers when the overlay dialog rejects", async () => {
      vi.useFakeTimers();
      const modelsDir = createDownloadedVoiceModels();
      const ctx = createMockCommandContext();
      // The factory runs (overlay component + render interval start), then the
      // dialog promise rejects, as it can during terminal teardown.
      ctx.ui.custom = mockFn((factory) => {
        factory(fakeTui(), createTestTheme(), {}, vi.fn());
        return Promise.reject(new Error("dialog crashed"));
      });
      const stt = { recognize: vi.fn(() => "") } as unknown as SttEngine;

      const overlay = runVoiceOverlay("", ctx, {
        modelsDir,
        sherpa: {} as SherpaOnnx,
        recorder: { hasFfmpeg: true, hasArecord: false },
        stt,
      });

      await expect(overlay).rejects.toThrow("dialog crashed");

      const recorder = recorderHarness.recorders.at(-1);
      expect(recorder?.stop).toHaveBeenCalledTimes(1);
      // Elapsed, partial, and render intervals must all be gone; a leaked
      // interval keeps firing after the overlay is gone.
      expect(vi.getTimerCount()).toBe(0);
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

    it("defaults to the avfoundation audio source on darwin", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        expect(resolveSource({})).toBe(":0");
        expect(resolveSource({ PI_VOICE_SOURCE: "   " })).toBe(":0");
      } finally {
        if (descriptor) Object.defineProperty(process, "platform", descriptor);
      }
    });

    it("PI_VOICE_SOURCE overrides the platform default", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        expect(resolveSource({ PI_VOICE_SOURCE: ":1" })).toBe(":1");
      } finally {
        if (descriptor) Object.defineProperty(process, "platform", descriptor);
      }
    });
  });

  describe("describeRecorderBackend", () => {
    it("names the darwin capture backend instead of a bare Ready", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        expect(describeRecorderBackend({ hasFfmpeg: true, hasArecord: false })).toBe(
          "Ready (ffmpeg/avfoundation)",
        );
        expect(describeRecorderBackend({ hasFfmpeg: false, hasArecord: false, hasSox: true })).toBe(
          "Ready (sox)",
        );
        expect(describeRecorderBackend({ hasFfmpeg: false, hasArecord: true })).toBe(
          "Not connected",
        );
      } finally {
        if (descriptor) Object.defineProperty(process, "platform", descriptor);
      }
    });

    it("keeps the historical linux wording", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        expect(describeRecorderBackend({ hasFfmpeg: true, hasArecord: false })).toBe("Ready");
        expect(describeRecorderBackend({ hasFfmpeg: false, hasArecord: true })).toBe("Ready");
        expect(describeRecorderBackend({ hasFfmpeg: false, hasArecord: false })).toBe(
          "Not connected",
        );
      } finally {
        if (descriptor) Object.defineProperty(process, "platform", descriptor);
      }
    });
  });

  describe("handler wiring", () => {
    it("/voice opens the dictation overlay like holding Space", async () => {
      const modelsDir = tempDir("pi-voice-empty-models-");
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
      const configPath = join(tempDir("pi-voice-config-"), "config.json");
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
      // Each Enter saves through the real filesystem before the modal's
      // list value advances; wait for the completion notification so the
      // next key always lands on the settled row.
      const waitForNotify = (fragment: string) =>
        vi.waitFor(() =>
          expect(firstCtx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining(fragment),
            "info",
          ),
        );
      firstComponent.handleInput?.("\x1b[B");
      firstComponent.handleInput?.("\x1b[B");
      firstComponent.handleInput?.("\r");
      await waitForNotify("Local voice set to");
      firstComponent.handleInput?.("\x1b[A");
      // Kitten cycles through Supertonic before reaching Inflect.
      firstComponent.handleInput?.("\r");
      await waitForNotify("Speech model set to Supertonic 3");
      firstComponent.handleInput?.("\r");
      await waitForNotify("Speech model set to Inflect Nano v2");
      firstComponent.handleInput?.("\x1b[A");
      firstComponent.handleInput?.("\r");
      await waitForNotify("Dictation model set to");

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        voice: "expr-voice-2-f",
        ttsModel: "inflect-nano-v2-onnx",
        dictationModel: "moonshine-v2-tiny-en",
      });

      const restartedPi = createMockPi();
      await voiceExtension(restartedPi);
      const restartedHandler = getCommandHandler(restartedPi, "voice:settings");
      const restartedCtx = createMockCommandContext();
      const getRestartedComponent = captureCustomComponent(restartedCtx);

      await restartedHandler("", restartedCtx);

      const rendered = getRestartedComponent().render(72).join("\n");
      expect(rendered).toContain("Moonshine v2 Tiny · Ready");
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
      const configPath = join(tempDir("pi-voice-config-"), "config.json");
      writeFileSync(configPath, contents);
      vi.stubEnv("PI_VOICE_CONFIG", configPath);
      vi.stubEnv("PI_VOICE_MODELS", tempDir("pi-voice-empty-models-"));
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const handler = getCommandHandler(mockPi, "voice:settings");
      const ctx = createMockCommandContext();
      const getComponent = captureCustomComponent(ctx);

      await handler("", ctx);

      const rendered = getComponent().render(72).join("\n");
      expect(rendered).toContain("Moonshine v2 Base · Missing");
      expect(rendered).toContain("Kitten Nano · Missing");
      expect(rendered).toContain("Voice 2 · Masculine");
    });

    it("/voice:settings reports config write failures and restores the displayed value", async () => {
      const configDir = tempDir("pi-voice-config-");
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
      // The failed save surfaces asynchronously through the real filesystem;
      // wait for the error notification.
      await vi.waitFor(() =>
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Could not save local voice"),
          "error",
        ),
      );
      expect(component.render(72).join("\n")).toContain("Voice 2 · Masculine");
    });

    it("does not register a voice-specific summary model command", async () => {
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const names = mockPi.registerCommand.mock.calls.map((call: unknown[]) => call[0]);

      expect(names).not.toContain("voice-summary-model");
    });

    it("rebuilds the sherpa speech engine after switching speech models", async () => {
      sherpaHarness.configs.length = 0;
      sherpaHarness.createAsync.mockClear();
      const modelsDir = createDownloadedVoiceModels();
      vi.stubEnv("PI_VOICE_MODELS", modelsDir);
      vi.stubEnv("PI_VOICE_CONFIG", join(tempDir("pi-voice-config-"), "config.json"));
      const mockPi = createMockPi();
      await voiceExtension(mockPi);
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() =>
        sessionEntries([
          { type: "message", message: { role: "assistant", content: "Hello world." } },
        ]),
      );

      // First speak uses the default Kitten model.
      await getCommandHandler(mockPi, "voice:speak")("full", ctx);
      await vi.waitFor(() => expect(sherpaHarness.createAsync).toHaveBeenCalledTimes(1));
      expect(sherpaHarness.configs[0]).toMatchObject({ model: { kitten: expect.anything() } });

      // Switch the speech-model row to Supertonic 3.
      let component: { handleInput?(data: string): void } | undefined;
      ctx.ui.custom = mockFn(async (factory) => {
        component = await factory(
          fakeTui(),
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          vi.fn(),
        );
        return undefined;
      });
      await getCommandHandler(mockPi, "voice:settings")("", ctx);
      component?.handleInput?.("\x1b[B");
      component?.handleInput?.("\r");
      // The model switch saves through the real filesystem; wait for its
      // completion notification before speaking again.
      await vi.waitFor(() =>
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Speech model set to"),
          "info",
        ),
      );

      // The second speak must get an engine built for Supertonic, not reuse
      // the cached Kitten engine.
      await getCommandHandler(mockPi, "voice:speak")("full", ctx);
      await vi.waitFor(() => expect(sherpaHarness.createAsync).toHaveBeenCalledTimes(2));
      expect(sherpaHarness.configs[1]).toMatchObject({
        model: { supertonic: expect.anything() },
      });
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
  const dir = tempDir("pi-voice-tts-");
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
  const dir = tempDir("pi-voice-models-");
  for (const model of [...MODELS, ...TTS_MODELS]) {
    if (!includeDefaultDictationModel && model.id === "moonshine-v2-base-en") continue;
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
  ctx.ui.custom = mockFn(async (factory) => {
    component = await factory(fakeTui(), createTestTheme(), {}, vi.fn());
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
