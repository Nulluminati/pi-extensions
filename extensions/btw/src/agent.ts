import type {
  AssistantMessage,
  Message,
  ProviderStreamOptions,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { modelLabel, thinkingLevelToReasoning } from "./model.ts";
import {
  buildSystemPrompt,
  formatMainBackground,
  persistThread,
  statusToText,
  threadToStreamMessages,
} from "./thread.ts";
import {
  extractToolResultText,
  finalizeTurnEntries,
  parseToolArgs,
  previewToolResultText,
  processStreamEvent,
  requestRender,
} from "./transcript.ts";
import type { AssistantBlock, BtwLiveState, BtwMessage, StreamMessage } from "./types.ts";

// --- Side agent loop ---

function assistantContentFromText(
  text: string,
  thinking: string,
  toolCalls: ToolCall[],
): AssistantBlock[] {
  const out: AssistantBlock[] = [];
  if (thinking) out.push({ type: "thinking", thinking });
  if (text) out.push({ type: "text", text });
  for (const call of toolCalls) out.push(call);
  return out;
}

/**
 * Single entry point for launching a side turn. If a turn is already
 * streaming, the incoming question is queued (status `queued`) and run
 * once the current turn finishes — instead of racing two turns against
 * the same transcript and abort controller.
 */
export function requestSideTurn(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: BtwLiveState,
  question: string,
): void {
  if (state.isStreaming) {
    state.pendingTurn = { ctx, question };
    state.status = "queued";
    state.statusText = statusToText("queued", null);
    requestRender(state);
    return;
  }
  void runSideTurn(pi, ctx, state, question).then(() => {
    const next = state.pendingTurn;
    if (!next) return;
    state.pendingTurn = null;
    requestSideTurn(pi, next.ctx, state, next.question);
  });
}

async function runSideTurn(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: BtwLiveState,
  question: string,
): Promise<void> {
  let resolved: Awaited<ReturnType<typeof resolveSmallModel>>;
  try {
    resolved = await resolveSmallModel(ctx);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const { model, auth } = resolved;

  const mainBackground =
    state.thread.mode === "contextual" ? formatMainBackground(ctx.sessionManager.getBranch()) : "";
  const systemPrompt = buildSystemPrompt(ctx, state.thread.mode, mainBackground);

  const tools = [
    createReadTool(ctx.cwd),
    createBashTool(ctx.cwd),
    createEditTool(ctx.cwd),
    createWriteTool(ctx.cwd),
  ];

  const userMessage: BtwMessage = { role: "user", content: question, timestamp: Date.now() };
  state.thread.messages.push(userMessage);
  state.transcript.push({ kind: "user", text: question });

  state.isStreaming = true;
  state.abortedMidTurn = false;
  state.lastError = null;
  state.status = "streaming";
  state.statusText = "Side agent is thinking…";
  state.transcript.push({ kind: "assistant-text", text: "", streaming: true });
  state.scroll = 0;
  requestRender(state);
  persistThread(pi, state);

  // Seed the working transcript with the full side-thread history so the
  // side agent carries context across turns (the current question was just
  // appended to the thread above).
  const workingMessages: StreamMessage[] = threadToStreamMessages(state.thread);

  const maxTurns = 8;
  let totalTokens = 0;
  let modelName = modelLabel(model);
  const effectiveReasoning = state.thread.thinkingOverride
    ? thinkingLevelToReasoning(state.thread.thinkingOverride)
    : resolved.reasoning;
  for (let turn = 0; turn < maxTurns; turn++) {
    const abort = new AbortController();
    state.abortController = abort;
    const streamOptions: ProviderStreamOptions = { apiKey: auth.apiKey };
    if (auth.headers) streamOptions.headers = auth.headers;
    if (auth.env) streamOptions.env = auth.env;
    streamOptions.signal = abort.signal;
    if (effectiveReasoning) streamOptions.reasoning = effectiveReasoning;

    const eventStream = stream(
      model as unknown as Parameters<typeof stream>[0],
      // Side-thread assistant turns keep only role, content and timestamp, not
      // the provider metadata a full AssistantMessage carries.
      { systemPrompt, tools, messages: workingMessages as Message[] },
      streamOptions,
    );

    let textBuffer = "";
    let thinkingBuffer = "";
    const collectedToolCalls: ToolCall[] = [];
    let sawStreamError = false;
    let streamErrorMessage = "";
    let streamErrorReason: "aborted" | "error" | null = null;

    try {
      for await (const event of eventStream) {
        if (abort.signal.aborted) break;
        if ((event as { type: string }).type === "error") {
          sawStreamError = true;
          const errEvent = event as {
            type: "error";
            reason: string;
            error?: { errorMessage?: string };
          };
          streamErrorMessage = errEvent.error?.errorMessage ?? errEvent.reason;
          streamErrorReason = errEvent.reason === "aborted" ? "aborted" : "error";
        }
        processStreamEvent(
          state,
          event as import("@earendil-works/pi-ai").AssistantMessageEvent,
          (s) => {
            textBuffer = s;
          },
          (s) => {
            thinkingBuffer = s;
          },
          (c) => {
            collectedToolCalls.push(c);
          },
        );
      }
    } catch (err) {
      sawStreamError = true;
      streamErrorMessage = err instanceof Error ? err.message : String(err);
    }

    let finalMessage: AssistantMessage | null = null;
    try {
      finalMessage = (await eventStream.result()) as AssistantMessage | null;
    } catch {
      finalMessage = null;
    }
    if (finalMessage) {
      totalTokens = finalMessage.usage?.totalTokens ?? totalTokens;
      modelName = finalMessage.model ?? modelName;
    } else if (sawStreamError) {
      // already tracked
    }

    if (sawStreamError) {
      if (streamErrorReason === "aborted") {
        state.abortedMidTurn = true;
        state.status = "aborted";
        state.statusText = statusToText("aborted", null);
        state.transcript = state.transcript.filter(
          (e) => !(e.kind === "assistant-text" && e.streaming),
        );
        break;
      }
      state.lastError = streamErrorMessage || "stream error";
      state.status = "failed";
      state.statusText = statusToText("failed", state.lastError);
      state.transcript = state.transcript.filter(
        (e) => !(e.kind === "assistant-text" && e.streaming),
      );
      state.transcript.push({ kind: "error", text: `Side agent failed: ${state.lastError}` });
      break;
    }

    if (abort.signal.aborted) {
      state.abortedMidTurn = true;
      state.status = "aborted";
      state.statusText = statusToText("aborted", null);
      state.transcript = state.transcript.filter(
        (e) => !(e.kind === "assistant-text" && e.streaming),
      );
      break;
    }

    if (collectedToolCalls.length === 0) {
      state.transcript = finalizeTurnEntries(state.transcript, textBuffer, thinkingBuffer);
      const assistantBlocks = assistantContentFromText(textBuffer, thinkingBuffer, []);
      if (assistantBlocks.length > 0) {
        state.thread.messages.push({
          role: "assistant",
          content: assistantBlocks,
          stopReason: "stop",
          usage: { totalTokens },
          model: modelName,
          timestamp: Date.now(),
        });
      }
      break;
    }

    state.transcript = finalizeTurnEntries(state.transcript, textBuffer, thinkingBuffer);
    const assistantBlocks = assistantContentFromText(
      textBuffer,
      thinkingBuffer,
      collectedToolCalls,
    );
    const assistantTimestamp = Date.now();
    state.thread.messages.push({
      role: "assistant",
      content: assistantBlocks,
      stopReason: "toolUse",
      usage: { totalTokens },
      model: modelName,
      timestamp: assistantTimestamp,
    });
    // Mirror into the working transcript so the next stream call sees the
    // assistant tool-call message BEFORE the tool results it requested.
    workingMessages.push({
      role: "assistant",
      content: assistantBlocks,
      timestamp: assistantTimestamp,
    });
    // Drop the now-completed empty assistant-text entry from the transcript
    // if there was no actual text/thinking content — the tool calls are
    // already in their own entries and a blank "exchange" inflates the count.
    if (!textBuffer && !thinkingBuffer) {
      state.transcript = state.transcript.filter(
        (e) =>
          !(
            (e.kind === "assistant-text" || e.kind === "assistant-thinking") &&
            e.text === "" &&
            !e.streaming
          ),
      );
    }

    for (const call of collectedToolCalls) {
      const tool = tools.find((t: { name: string }) => t.name === call.name) as
        | {
            execute: (
              id: string,
              args: Record<string, unknown>,
              signal?: AbortSignal,
            ) => Promise<{ content: TextContent[]; details?: unknown; isError?: boolean }>;
          }
        | undefined;
      const args = parseToolArgs(call.arguments);
      let resultContent: TextContent[] = [];
      let isError = false;
      const toolCallStart = Date.now();
      try {
        if (!tool) {
          isError = true;
          resultContent = [{ type: "text", text: `Unknown tool: ${call.name}` }];
        } else {
          const result = await tool.execute(call.id, args, abort.signal);
          resultContent = result?.content ?? [];
          isError = Boolean(result?.isError);
        }
      } catch (err) {
        isError = true;
        const msg = err instanceof Error ? err.message : String(err);
        resultContent = [{ type: "text", text: `Tool execution failed: ${msg}` }];
      }
      const toolResultText = extractToolResultText(resultContent);
      state.transcript.push({
        kind: "tool-result",
        text: previewToolResultText(toolResultText),
        failed: isError,
      });
      state.thread.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: resultContent,
        isError,
        timestamp: toolCallStart,
      });
      workingMessages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: resultContent,
        isError,
        timestamp: toolCallStart,
      });
      state.statusText = `Running ${call.name}…`;
      requestRender(state);
    }
    state.transcript.push({ kind: "assistant-text", text: "", streaming: true });
    state.statusText = "Side agent is thinking…";
    requestRender(state);
  }

  state.isStreaming = false;
  state.abortController = null;
  // If the turn cap was hit mid-tool-use, a trailing streaming placeholder
  // was left in the transcript with no response behind it — drop it so the
  // overlay doesn't show a stuck "btw: ▌" line. (Normal completion converts
  // the placeholder to non-streaming; abort/failed paths already filter it.)
  state.transcript = state.transcript.filter((e) => !(e.kind === "assistant-text" && e.streaming));
  if (state.status !== "aborted" && state.status !== "failed") {
    state.status = "idle";
  }
  state.statusText = statusToText(state.status, state.lastError);
  requestRender(state);
  persistThread(pi, state);
}
