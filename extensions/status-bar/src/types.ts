// --- Types ---

export interface ToolExecution {
  name: string;
  id: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
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
  activeTools: ToolExecution[];
  completedToolCount: number;
  gitBranch: string | null;
  gitStatus: GitStatus | null;
  tokenUsage: TokenUsage;
  lastHandle: { requestRender: () => void; close: () => void } | null;
  // Flex tier indicator state, published by the Neuralwatt extension on the
  // pi.events bus (see neuralwatt:flex-change). `flexCapable` is true for the
  // current model only when it is a Neuralwatt model with a flex sibling; the
  // badge is shown solely on that. `flexOn` drives the on/off label.
  flexOn: boolean;
  flexCapable: boolean;
}
