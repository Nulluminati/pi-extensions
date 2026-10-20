// --- Types ---

export type Entry = {
  id?: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
};

export type RecapReason = "idle" | "manual" | "resume" | "focus";

export type RecapState = {
  idleTimer: NodeJS.Timeout | undefined;
  activeController: AbortController | undefined;
  activeReason: RecapReason | undefined;
  agentActive: boolean;
  focusDraftAfterAgent: boolean;
  focusListener: ((chunk: Buffer) => void) | undefined;
  focusEnabled: boolean;
  focusedOutAt: number | undefined;
  pendingRecap: string | undefined;
  lastDraftedLeafId: string | null | undefined;
  autoDismissTimer: NodeJS.Timeout | undefined;
  resumeTimer: NodeJS.Timeout | undefined;
  backgroundFailureNotified: boolean;
};
