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
  activeTools: ToolExecution[];
  completedToolCount: number;
  gitBranch: string | null;
  gitStatus: GitStatus | null;
  tokenUsage: TokenUsage;
  lastHandle: { requestRender: () => void; close: () => void } | null;
}
