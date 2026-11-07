// --- Types ---

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Snapshot of context-window usage. `tokens`/`percent` are null when the
 * estimate is unavailable (e.g. right after a compaction with no post-
 * compaction assistant usage yet). Cached and refreshed on message
 * boundaries so the footer render never recomputes it per keystroke. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface GitStatus {
  ahead: number;
  behind: number;
  conflicted: number;
  untracked: number;
  stashed: boolean;
  modified: number;
  staged: number;
  renamed: number;
  deleted: number;
  typechanged: number;
}

export interface State {
  enabled: boolean;
  turnCount: number;
  thinkingLevel: string;
  // Label of the global small model ("provider/model"), shown in the editor
  // meta line after a "/" separator, beside the main model. Empty when no
  // small model is configured.
  smallModelLabel: string;
  workerModelLabel: string;
  gitBranch: string | null;
  gitStatus: GitStatus | null;
  tokenUsage: TokenUsage;
  contextUsage: ContextUsage | undefined;
  lastHandle: { requestRender: () => void; close: () => void } | null;
  // Flex tier indicator state, published by the Neuralwatt extension on the
  // pi.events bus (see neuralwatt:flex-change). `flexCapable` is true for the
  // current model only when it is a Neuralwatt model with a flex sibling; the
  // badge is shown solely on that. `flexOn` drives the on/off label.
  flexOn: boolean;
  flexCapable: boolean;
  // True while Jev review is off in the main session; shows the warning badge.
  approvalModeOff: boolean;
  // Unread messenger mail count, published by the messenger extension on the
  // pi.events bus (see messenger:state). Shown as an "✉ N" segment in the
  // Session panel while N > 0. It is not cleared on session boundaries: the
  // messenger re-announces its state during its own session_start, and a
  // reset here could clobber an announcement that has already fired.
  unreadMail: number;
  // Aggregated token/cost usage of the project's delegated workers
  // (published on workers:state). Zero while no workers have run.
  workerCostUsd: number;
  workerTokens: number;
}
