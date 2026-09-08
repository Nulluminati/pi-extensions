/** Harness evaluation types. An eval task is a reproducible coding scenario:
 * fixture files + a prompt + shell checks that grade the outcome. */

// --- Types ---

export interface FixtureFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface TaskCheck {
  name: string;
  command: string;
}

export interface EvalTask {
  id: string;
  title: string;
  /** What surface this task probes (regressions, consistency, diagnosis…). */
  probes: string;
  prompt: string;
  fixtures: FixtureFile[];
  checks: TaskCheck;
  timeoutMs: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
}

export interface EvalResult {
  taskId: string;
  model: string;
  /** True only when every check passed. */
  pass: boolean;
  checks: CheckResult[];
  durationMs: number;
  /** Worker session exit code (null when it timed out or was killed). */
  exitCode: number | null;
  timedOut: boolean;
  /** Session usage summed over assistant messages. */
  inputTokens: number;
  outputTokens: number;
  /** Final assistant text (the worker's report). */
  finalText?: string;
  /** Blind LLM-judge rubric scores, when a judge was configured. */
  quality?: EvalQuality;
  error?: string;
  at: number;
}

/** Judge rubric: three 0-10 axes plus a weighted overall. */
export interface EvalQuality {
  specAdherence: number;
  codeQuality: number;
  robustness: number;
  overall: number;
  notes?: string;
}
