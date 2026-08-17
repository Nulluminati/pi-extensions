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
  // True while the goal extension has a running goal (status "active"),
  // published on the pi.events bus (see goal:state-change). Shown as a "Goal"
  // badge in the editor frame's top-right cell, beside "Plan Mode" when both
  // are active.
  goalRunning: boolean;
  // Gondolin sandbox VM state, published by the gondolin extension on the
  // pi.events bus (see gondolin:vm-state). Shown as a "with WS <id>" segment
  // on footer line 1 after the working directory; null when no VM exists.
  gondolinVm: { state: "starting" | "ready" | "stopping"; vmId?: string } | null;
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
  // True while the plan extension is in plan mode (see plan:mode-change on the
  // pi.events bus); tints the editor frame with the warning color.
  planModeActive: boolean;
}
