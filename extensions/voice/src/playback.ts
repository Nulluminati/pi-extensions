import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePcm16Wave, hasTool } from "./audio.ts";
import { SUPERTONIC_LANG, SUPERTONIC_NUM_STEPS } from "./constants.ts";
import type { InflectTtsEngine } from "./inflect.ts";
import type { OfflineTtsInstance, SpeechJob, TtsSherpa } from "./types.ts";

export function createSpeechJob(): SpeechJob {
  return { cancelled: false, player: null };
}

export function stopSpeechJob(job: SpeechJob): void {
  job.cancelled = true;
  job.player?.kill("SIGKILL");
  job.player = null;
}

function resolvePlaybackCommand(): "pw-play" | "ffplay" {
  if (hasTool("pw-play")) return "pw-play";
  if (hasTool("ffplay")) return "ffplay";
  throw new Error("Install PipeWire (pw-play) or ffmpeg (ffplay) for playback.");
}

async function playWaveFile(
  playerCommand: "pw-play" | "ffplay",
  wavPath: string,
  job: SpeechJob,
): Promise<void> {
  const playerArgs =
    playerCommand === "pw-play"
      ? [wavPath]
      : ["-nodisp", "-autoexit", "-loglevel", "error", wavPath];
  const player = spawn(playerCommand, playerArgs, { stdio: ["ignore", "ignore", "ignore"] });
  job.player = player;
  try {
    await new Promise<void>((resolve, reject) => {
      player.once("error", reject);
      player.once("close", (code) => {
        if (job.cancelled || code === 0 || code === null) resolve();
        else reject(new Error(`${playerCommand} exited with code ${code}`));
      });
    });
  } finally {
    if (job.player === player) job.player = null;
    if (job.cancelled) player.kill("SIGKILL");
  }
}

async function playSherpaSpeech(
  sherpa: TtsSherpa,
  engine: OfflineTtsInstance,
  text: string,
  job: SpeechJob,
  buildGenerationConfig: (sherpa: TtsSherpa) => unknown,
): Promise<void> {
  if (job.cancelled) return;
  const playerCommand = resolvePlaybackCommand();
  const audio = await engine.generateAsync({
    text,
    generationConfig: buildGenerationConfig(sherpa),
    onProgress: () => !job.cancelled,
  });
  if (job.cancelled) return;

  const wavPath = join(tmpdir(), `pi-voice-tts-${process.pid}-${Date.now()}.wav`);
  sherpa.writeWave(wavPath, audio);
  try {
    await playWaveFile(playerCommand, wavPath, job);
  } finally {
    rmSync(wavPath, { force: true });
  }
}

export async function playKittenSpeech(
  sherpa: TtsSherpa,
  engine: OfflineTtsInstance,
  text: string,
  speakerId: number,
  job: SpeechJob,
): Promise<void> {
  await playSherpaSpeech(
    sherpa,
    engine,
    text,
    job,
    (s) =>
      new s.GenerationConfig({
        sid: speakerId,
        speed: 1,
        silenceScale: 0.2,
      }),
  );
}

export async function playSupertonicSpeech(
  sherpa: TtsSherpa,
  engine: OfflineTtsInstance,
  text: string,
  speakerId: number,
  job: SpeechJob,
): Promise<void> {
  await playSherpaSpeech(
    sherpa,
    engine,
    text,
    job,
    (s) =>
      new s.GenerationConfig({
        sid: speakerId,
        numSteps: SUPERTONIC_NUM_STEPS,
        speed: 1,
        extra: { lang: SUPERTONIC_LANG },
      }),
  );
}

export async function playInflectSpeech(
  engine: InflectTtsEngine,
  text: string,
  job: SpeechJob,
): Promise<void> {
  if (job.cancelled) return;
  if (!hasTool("espeak-ng")) {
    throw new Error("Install espeak-ng for Inflect text processing.");
  }
  const playerCommand = resolvePlaybackCommand();
  const samples = await engine.generate(text, job);
  if (job.cancelled || samples.length === 0) return;

  const wavPath = join(tmpdir(), `pi-voice-inflect-${process.pid}-${Date.now()}.wav`);
  writeFileSync(wavPath, encodePcm16Wave(samples, engine.sampleRate));
  try {
    await playWaveFile(playerCommand, wavPath, job);
  } finally {
    rmSync(wavPath, { force: true });
  }
}
