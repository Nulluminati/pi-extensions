import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "pi";

// --- Types ---

export type BtwMode = "contextual" | "tangent";

export type BtwStatus = "idle" | "streaming" | "aborted" | "failed" | "summarizing" | "queued";

export type AssistantBlock = TextContent | { type: "thinking"; thinking: string } | ToolCall;

export type BtwMessage =
  | { role: "user"; content: string; timestamp: number }
  | {
      role: "assistant";
      content: AssistantBlock[];
      stopReason: string;
      usage: { totalTokens: number };
      model: string;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
      isError: boolean;
      timestamp: number;
    };

export interface BtwThreadState {
  mode: BtwMode;
  messages: BtwMessage[];
  thinkingOverride: "none" | "low" | "medium" | "high" | null;
}

// Shape sent to the streaming API. Kept intentionally loose: `stream`'s
// context is untyped, and historical messages only need role/content (the
// live model carries provider/api; usage is an output field).
export type StreamMessage =
  | { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }
  | { role: "assistant"; content: AssistantBlock[]; timestamp: number }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
      isError: boolean;
      timestamp: number;
    };

export interface TranscriptEntry {
  kind:
    | "user"
    | "assistant-text"
    | "assistant-thinking"
    | "tool-call"
    | "tool-result"
    | "status"
    | "error";
  text: string;
  meta?: Record<string, unknown>;
  streaming?: boolean;
  failed?: boolean;
}

export interface OverlayHandle {
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
}

export interface OverlaySession {
  done: () => void;
  handle: OverlayHandle;
  tui: { requestRender: () => void } | null;
}

export interface PendingTurn {
  ctx: ExtensionCommandContext;
  question: string;
}

export interface BtwLiveState {
  thread: BtwThreadState;
  overlay: OverlaySession | null;
  transcript: TranscriptEntry[];
  status: BtwStatus;
  statusText: string;
  composer: string;
  scroll: number;
  isStreaming: boolean;
  abortedMidTurn: boolean;
  lastError: string | null;
  abortController: AbortController | null;
  pendingTurn: PendingTurn | null;
}
