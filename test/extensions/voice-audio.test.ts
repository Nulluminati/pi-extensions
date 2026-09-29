import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectRecorders,
  resolveRecorderCommand,
  startStreamingRecorder,
} from "../../extensions/voice/src/audio.ts";
import { SAMPLE_RATE } from "../../extensions/voice/src/constants.ts";
import { resolvePlaybackCommand } from "../../extensions/voice/src/playback.ts";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawn } from "node:child_process";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

describe("resolveRecorderCommand", () => {
  it("uses avfoundation for ffmpeg capture on darwin", () => {
    stubPlatform("darwin");
    expect(resolveRecorderCommand(":0", { hasFfmpeg: true, hasArecord: false })).toEqual({
      cmd: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
      ],
    });
  });

  it("falls back to sox on darwin when ffmpeg is absent", () => {
    stubPlatform("darwin");
    expect(
      resolveRecorderCommand(":0", { hasFfmpeg: false, hasArecord: false, hasSox: true }),
    ).toEqual({
      cmd: "sox",
      args: ["-d", "-t", "s16le", "-r", String(SAMPLE_RATE), "-c", "1", "-"],
    });
  });

  it("does not select arecord on darwin (ALSA is Linux-only)", () => {
    stubPlatform("darwin");
    expect(resolveRecorderCommand(":0", { hasFfmpeg: false, hasArecord: true })).toBeNull();
  });

  it("keeps pulse capture on linux", () => {
    stubPlatform("linux");
    expect(resolveRecorderCommand("default", { hasFfmpeg: true, hasArecord: false })).toEqual({
      cmd: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "pulse",
        "-i",
        "default",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
      ],
    });
  });

  it("keeps arecord capture on linux", () => {
    stubPlatform("linux");
    expect(resolveRecorderCommand("default", { hasFfmpeg: false, hasArecord: true })).toEqual({
      cmd: "arecord",
      args: [
        "-q",
        "-D",
        "default",
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
    });
  });

  it("returns null when no recorder is available", () => {
    stubPlatform("linux");
    expect(resolveRecorderCommand("default", { hasFfmpeg: false, hasArecord: false })).toBeNull();
    stubPlatform("darwin");
    expect(resolveRecorderCommand(":0", { hasFfmpeg: false, hasArecord: false })).toBeNull();
  });
});

describe("startStreamingRecorder", () => {
  it("returns null when no recorder is available", () => {
    stubPlatform("linux");
    expect(
      startStreamingRecorder("default", { hasFfmpeg: false, hasArecord: false }, () => {}),
    ).toBeNull();
    stubPlatform("darwin");
    expect(
      startStreamingRecorder(":0", { hasFfmpeg: false, hasArecord: false }, () => {}),
    ).toBeNull();
  });

  it("pipes PCM chunks from recorder stdout", () => {
    stubPlatform("linux");
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const chunks: Float32Array[] = [];
    const recorder = startStreamingRecorder(
      "default",
      { hasFfmpeg: true, hasArecord: false },
      (samples) => {
        chunks.push(samples);
      },
    );
    expect(recorder).not.toBeNull();
    expect(mockedSpawn).toHaveBeenCalledWith("ffmpeg", expect.any(Array), expect.anything());
    child.stdout.emit("data", Buffer.from([0x00, 0x40, 0x00, 0x40]));
    expect(chunks).toHaveLength(1);
    recorder?.stop();
  });

  it("surfaces spawn errors through onFailure", () => {
    stubPlatform("linux");
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const failures: string[] = [];
    const recorder = startStreamingRecorder(
      "default",
      { hasFfmpeg: true, hasArecord: false },
      () => {},
      (reason) => {
        failures.push(reason);
      },
    );
    child.emit("error", new Error("spawn ffmpeg ENOENT"));
    expect(failures).toEqual(["spawn ffmpeg ENOENT"]);
    recorder?.stop();
  });

  it("surfaces early recorder exit with the stderr tail", () => {
    stubPlatform("darwin");
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const failures: string[] = [];
    const recorder = startStreamingRecorder(
      ":0",
      { hasFfmpeg: true, hasArecord: false },
      () => {},
      (reason) => {
        failures.push(reason);
      },
    );
    child.stderr.emit("data", Buffer.from("Unknown input format: 'avfoundation'"));
    child.emit("close", 1, null);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Unknown input format: 'avfoundation'");
    recorder?.stop();
  });

  it("does not report a failure after a deliberate stop", () => {
    stubPlatform("linux");
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const failures: string[] = [];
    const recorder = startStreamingRecorder(
      "default",
      { hasFfmpeg: true, hasArecord: false },
      () => {},
      (reason) => {
        failures.push(reason);
      },
    );
    recorder?.stop();
    child.emit("close", null, "SIGKILL");
    expect(failures).toEqual([]);
  });
});

describe("detectRecorders", () => {
  it("detects ffmpeg, arecord, and sox availability", () => {
    mockedExecSync.mockImplementation(((command: string) => {
      if (String(command).includes("sox")) throw new Error("missing");
      if (String(command).includes("arecord")) throw new Error("missing");
      return Buffer.from("/usr/bin/ffmpeg\n");
    }) as never);
    expect(detectRecorders()).toEqual({ hasFfmpeg: true, hasArecord: false, hasSox: false });
  });
});

describe("resolvePlaybackCommand", () => {
  it("prefers afplay when present (macOS native)", () => {
    expect(resolvePlaybackCommand((name) => name === "afplay")).toBe("afplay");
  });

  it("falls back to pw-play when afplay is absent", () => {
    expect(resolvePlaybackCommand((name) => name === "pw-play")).toBe("pw-play");
  });

  it("falls back to ffplay when only ffmpeg is installed", () => {
    expect(resolvePlaybackCommand((name) => name === "ffplay")).toBe("ffplay");
  });

  it("throws an actionable message when no player exists", () => {
    expect(() => resolvePlaybackCommand(() => false)).toThrow(/afplay/);
  });
});
