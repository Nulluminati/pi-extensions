import { completeSimple } from "@earendil-works/pi-ai";
import { Loader } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { extractText } from "../../../lib/session-utils.ts";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { resolveModelsDir } from "./config.ts";
import { DEFAULT_TTS_MODEL_ID, TTS_WIDGET_KEY } from "./constants.ts";
import { modelIsDownloaded, TTS_MODELS } from "./models.ts";

export function findLatestAssistantText(entries: unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as {
      type?: string;
      role?: string;
      content?: unknown;
      message?: { role?: string; content?: unknown };
    };
    const message = entry.type === "message" ? entry.message : entry;
    if (message?.role !== "assistant") continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return undefined;
}

export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSpokenSummaryPrompt(text: string): string {
  return `Summarize the assistant response below in 40 to 70 words for text-to-speech.
Use plain spoken prose with no Markdown, code blocks, URLs, or formatting symbols.
State the outcome, important caveats, and next action. Do not add facts.

Assistant response:
${text.slice(0, 16000)}`;
}

// --- Command handlers ---

export async function summarizeForSpeech(
  text: string,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const resolved = await resolveSmallModel(ctx);
  const completionOptions: {
    apiKey: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    maxTokens: number;
    reasoning?: string;
  } = {
    apiKey: resolved.auth.apiKey,
    maxTokens: 160,
  };
  if (resolved.auth.headers) completionOptions.headers = resolved.auth.headers;
  if (resolved.auth.env) completionOptions.env = resolved.auth.env;
  if (resolved.reasoning) completionOptions.reasoning = resolved.reasoning;
  const response = await completeSimple(
    resolved.model,
    {
      systemPrompt: "You write short, accurate spoken summaries of coding-agent responses.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildSpokenSummaryPrompt(text) }],
          timestamp: Date.now(),
        },
      ],
    },
    completionOptions,
  );
  const summary = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  const cleaned = cleanTextForSpeech(summary);
  if (!cleaned) throw new Error("Summary model returned no text.");
  return cleaned;
}

export async function runVoiceSpeak(
  args: string,
  ctx: ExtensionCommandContext,
  opts: {
    modelsDir?: string;
    ttsModelId?: string;
    summarize: (text: string, ctx: ExtensionCommandContext) => Promise<string>;
    speak: (text: string, speakerId: number) => Promise<void>;
    speakerId: number;
  },
): Promise<void> {
  const source = findLatestAssistantText(ctx.sessionManager.getBranch());
  if (!source) {
    ctx.ui.notify("No assistant message to speak.", "warning");
    return;
  }
  const modelsDir = opts.modelsDir ?? resolveModelsDir(process.env);
  const ttsModelId = opts.ttsModelId ?? DEFAULT_TTS_MODEL_ID;
  const ttsModel = TTS_MODELS.find((model) => model.id === ttsModelId);
  if (!ttsModel || !modelIsDownloaded(modelsDir, ttsModel)) {
    const modelName = ttsModel?.displayName ?? ttsModelId;
    ctx.ui.notify(
      `${modelName} TTS is not downloaded in ${modelsDir}. Open /voice or see the voice README for setup.`,
      "error",
    );
    return;
  }

  setTtsIndicator(ctx, "Preparing speech...");
  try {
    const full = args.trim().toLowerCase() === "full";
    const spokenText = full
      ? cleanTextForSpeech(source)
      : cleanTextForSpeech(await opts.summarize(source, ctx));
    if (!spokenText) {
      ctx.ui.notify("The assistant message has no speakable text.", "warning");
      return;
    }
    setTtsIndicator(ctx, "Speaking...");
    await opts.speak(spokenText, opts.speakerId);
  } catch (error) {
    ctx.ui.notify(
      `Voice playback failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    setTtsIndicator(ctx, undefined);
  }
}

/**
 * Transient speech indicator in the working-indicator style: an animated
 * Loader row (accent spinner + muted message, like pi's "Thinking...")
 * shown as a widget just above the editor while speech is prepared or
 * played, removed when done.
 */
export function setTtsIndicator(ctx: ExtensionCommandContext, text: string | undefined): void {
  if (!ctx.hasUI) return;
  if (text === undefined) {
    ctx.ui.setWidget(TTS_WIDGET_KEY, undefined);
    return;
  }
  ctx.ui.setWidget(TTS_WIDGET_KEY, (tui: any, theme: any) => {
    const loader = new Loader(
      tui,
      (spinner: string) => theme.fg("accent", spinner),
      (message: string) => theme.fg("muted", message),
      text,
    );
    loader.start();
    return {
      render: (width: number) => loader.render(width),
      invalidate: () => loader.invalidate(),
      dispose: () => loader.stop(),
    };
  });
}
