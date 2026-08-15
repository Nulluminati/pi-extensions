/** Shared types for the plan extension. */

export type PlanMode = "off" | "plan" | "executing";

export interface Plan {
  title: string;
  steps: string[];
  notes?: string;
}

export interface PlanState {
  mode: PlanMode;
  plan: Plan | null;
  toolsBeforePlan: string[] | undefined;
}
