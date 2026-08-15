/** Shared types for the plan extension. */

export type PlanMode = "off" | "plan" | "executing";

export interface PlanStep {
  description: string;
  completed: boolean;
}

export interface Plan {
  title: string;
  steps: PlanStep[];
  notes?: string;
}

export interface PlanState {
  mode: PlanMode;
  plan: Plan | null;
  toolsBeforePlan: string[] | undefined;
}
