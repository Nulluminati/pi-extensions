/**
 * In-memory job registry: creation, lookup, pruning, and the persisted
 * snapshot projection. One registry per Pi instance (closure-scoped in the
 * composition root); never module-level.
 */

import { MAX_RETAINED_JOBS } from "./format.ts";
import type { Job, JobKind, JobSnapshot, JobStatus } from "./types.ts";

export interface JobRegistry {
  jobs: Map<number, Job>;
  nextId: number;
}

export function createRegistry(): JobRegistry {
  return { jobs: new Map(), nextId: 1 };
}

export function createJob(
  registry: JobRegistry,
  init: {
    kind: JobKind;
    label: string;
    command: string;
    status?: JobStatus;
  } & Partial<Omit<Job, "id" | "kind" | "label" | "command" | "status">>,
): Job {
  const { kind, label, command, status, ...rest } = init;
  const job: Job = {
    id: registry.nextId++,
    kind,
    label,
    command,
    status: status ?? "running",
    startedAt: Date.now(),
    buffer: "",
    ...rest,
  };
  registry.jobs.set(job.id, job);
  return job;
}

export function getJob(registry: JobRegistry, id: number): Job | undefined {
  return registry.jobs.get(id);
}

export function listJobs(registry: JobRegistry): Job[] {
  return Array.from(registry.jobs.values()).sort((a, b) => a.id - b.id);
}

export function activeJobs(registry: JobRegistry): Job[] {
  return listJobs(registry).filter(
    (job) => job.status === "running" || job.status === "cancelling",
  );
}

/** Prune oldest terminal jobs so memory stays bounded across a long session. */
export function pruneTerminal(registry: JobRegistry): void {
  const terminal = listJobs(registry).filter(
    (job) => job.status !== "running" && job.status !== "cancelling",
  );
  const excess = terminal.length - MAX_RETAINED_JOBS;
  for (let i = 0; i < excess; i++) {
    const job = terminal[i];
    if (job) registry.jobs.delete(job.id);
  }
}

/** Stamp a terminal job and hand it to pruning. */
export function finalizeJob(registry: JobRegistry, job: Job): void {
  job.endedAt = Date.now();
  pruneTerminal(registry);
}

/** Projection persisted via `pi.appendEntry("background-jobs", ...)`. */
export function buildSnapshot(registry: JobRegistry): { jobs: JobSnapshot[] } {
  return {
    jobs: listJobs(registry).map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      command: job.command,
      status: job.status,
      ...(job.spoolPath ? { spoolPath: job.spoolPath } : {}),
    })),
  };
}

/** Plain text for the setStatus fallback, or undefined when none are running;
 *  the composition root wraps it with `formatStatusLine`. */
export function formatStatusText(registry: JobRegistry): string | undefined {
  const active = activeJobs(registry);
  if (active.length === 0) return undefined;
  const labels = active
    .slice(0, 3)
    .map((job) => `#${job.id} ${job.label}`)
    .join(", ");
  const more = active.length > 3 ? ` +${active.length - 3}` : "";
  return `${active.length} job${active.length === 1 ? "" : "s"}: ${labels}${more}`;
}
