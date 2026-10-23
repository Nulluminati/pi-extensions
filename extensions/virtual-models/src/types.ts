import type { ClassifierResult, ModelRouteRequest } from "pi";

interface ClassifierRecord {
  attempted: boolean;
  status: string;
  provider: string;
  model: string;
  usage?: ClassifierResult["usage"];
}
export interface RouteRecord {
  policyVersion: string;
  role: "main" | "worker";
  selected: string;
  requestReason: ModelRouteRequest["reason"];
  requestedThinking: string;
  effectiveThinking?: string;
  dispatched?: string;
  previous?: string;
  switched?: boolean;
  reason: string;
  status: "routed" | "paused" | "error";
  latencyMs: number;
  classifier?: ClassifierRecord;
}
