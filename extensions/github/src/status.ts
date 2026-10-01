// PR status logic for the github extension. Pure functions over the data
// shapes produced by src/client.ts: no process execution and no UI. The
// overlay consumes summarizePullRequest() for display and filterPullRequests()
// for list filtering.

import type { Check, PullRequest } from "./client.ts";

// --- Types ---

export type CiSummary = "passed" | "failed" | "pending" | "none" | "unknown";

export interface PullRequestStatus {
  review: string;
  ci: CiSummary;
  ready: boolean;
  reasons: string[];
}

export type AuthorFilter = "all" | "mine" | "others";

export type StatusFilter = "all" | "approvals" | "failed-ci" | "ready";

type SingleCheckState = "passed" | "failed" | "pending" | "unknown";

// --- Constants ---

const CI_PASSED_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const CI_FAILED_STATES = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

// QUEUED/IN_PROGRESS are CheckRun statuses; EXPECTED/PENDING is the
// StatusContext waiting state; REQUESTED/WAITING cover suite-level queues.
const CI_PENDING_STATES = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "PENDING",
  "REQUESTED",
  "WAITING",
  "EXPECTED",
]);

// Review decisions the ready check understands. An empty decision means the
// repository requires no reviews; anything else unrecognized is treated as
// unknown and never ready.
const KNOWN_REVIEW_DECISIONS = new Set(["", "APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]);

// --- Check evaluation ---

function classifyState(state: string | undefined): SingleCheckState {
  const value = (state ?? "").toUpperCase();
  if (CI_PASSED_STATES.has(value)) return "passed";
  if (CI_FAILED_STATES.has(value)) return "failed";
  if (CI_PENDING_STATES.has(value)) return "pending";
  return "unknown";
}

function classifyCheckRun(
  status: string | undefined,
  conclusion: string | undefined,
): SingleCheckState {
  const statusValue = (status ?? "").toUpperCase();
  const conclusionValue = (conclusion ?? "").toUpperCase();
  if (statusValue !== "" && statusValue !== "COMPLETED") {
    // Not finished: the status itself carries the state (queued, in progress).
    return CI_PENDING_STATES.has(statusValue) ? "pending" : "unknown";
  }
  if (conclusionValue === "") {
    // COMPLETED without a conclusion, or no data at all.
    return "unknown";
  }
  return classifyState(conclusionValue);
}

function checkState(check: Check): SingleCheckState {
  if (check.__typename === "StatusContext") return classifyState(check.state);
  if (check.status !== undefined || check.conclusion !== undefined) {
    return classifyCheckRun(check.status, check.conclusion);
  }
  // No __typename: fall back to the StatusContext-style field.
  return classifyState(check.state);
}

function rollupCi(rollup: Check[] | null | undefined): CiSummary {
  if (!rollup || rollup.length === 0) return "none";
  let sawPending = false;
  let sawUnknown = false;
  for (const check of rollup) {
    const state = checkState(check);
    if (state === "failed") return "failed";
    if (state === "pending") sawPending = true;
    if (state === "unknown") sawUnknown = true;
  }
  if (sawUnknown) return "unknown";
  if (sawPending) return "pending";
  return "passed";
}

// --- Summary ---

export function summarizePullRequest(pr: PullRequest): PullRequestStatus {
  const reasons: string[] = [];
  const ci = rollupCi(pr.statusCheckRollup);
  const review = pr.reviewDecision;

  if (pr.state !== "OPEN") reasons.push(`state is ${pr.state || "unknown"}, not open`);
  if (pr.isDraft) reasons.push("draft");

  if (pr.mergeable === "CONFLICTING") {
    reasons.push("merge conflicts");
  } else if (pr.mergeable !== "MERGEABLE") {
    reasons.push(`mergeable is ${pr.mergeable || "unknown"}`);
  }

  switch (pr.mergeStateStatus) {
    case "CLEAN":
      break;
    case "BLOCKED":
      reasons.push("blocked by branch protection or required reviews");
      break;
    case "BEHIND":
      reasons.push("branch is behind the base branch");
      break;
    case "UNSTABLE":
      reasons.push("merge state is unstable (failing or pending checks)");
      break;
    case "DIRTY":
      reasons.push("merge conflicts");
      break;
    case "DRAFT":
      reasons.push("draft");
      break;
    case "HAS_HOOKS":
      reasons.push("repository merge hooks may block the merge");
      break;
    default:
      reasons.push(`merge state is ${pr.mergeStateStatus || "unknown"}`);
      break;
  }

  if (ci === "failed") reasons.push("checks failed");
  else if (ci === "pending") reasons.push("checks pending");
  else if (ci === "unknown") reasons.push("check state is unknown");

  if (review === "REVIEW_REQUIRED") reasons.push("review required");
  else if (review === "CHANGES_REQUESTED") reasons.push("changes requested");
  else if (review !== "APPROVED" && review !== "")
    reasons.push(`review state is ${review || "unknown"}`);

  const ready =
    pr.state === "OPEN" &&
    !pr.isDraft &&
    pr.mergeable === "MERGEABLE" &&
    pr.mergeStateStatus === "CLEAN" &&
    (ci === "passed" || ci === "none") &&
    review !== "REVIEW_REQUIRED" &&
    review !== "CHANGES_REQUESTED" &&
    KNOWN_REVIEW_DECISIONS.has(review);

  const reviewLabels: Record<string, string> = {
    APPROVED: "Approved",
    REVIEW_REQUIRED: "Approvals required",
    CHANGES_REQUESTED: "Changes requested",
    "": "Reviews not required",
  };
  return {
    review: reviewLabels[review] ?? "Review status unknown",
    ci,
    ready,
    reasons: [...new Set(reasons)],
  };
}

// --- Filtering ---

export function filterPullRequests(
  prs: PullRequest[],
  viewer: string,
  author: AuthorFilter,
  status: StatusFilter,
): PullRequest[] {
  return prs.filter((pr) => {
    const login = pr.author?.login.toLowerCase();
    const viewerLogin = viewer.toLowerCase();
    if (author === "mine" && login !== viewerLogin) return false;
    if (author === "others" && login === viewerLogin) return false;
    switch (status) {
      case "approvals":
        return pr.reviewDecision === "REVIEW_REQUIRED";
      case "failed-ci":
        return summarizePullRequest(pr).ci === "failed";
      case "ready":
        return summarizePullRequest(pr).ready;
      default:
        return true;
    }
  });
}
