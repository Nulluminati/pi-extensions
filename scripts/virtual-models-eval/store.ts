/** Write-before-call checkpoints. Interrupted retries remain separate attempts, never replacement scores. */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";
import type { Case } from "./plan.ts";

interface Manifest {
  fingerprint: string;
  configurations: Record<string, string | null>;
  cases: Case[];
  phase: string;
  [key: string]: unknown;
}
export interface Attempt {
  id: string;
  caseId: string;
  attempt: number;
  startedAt: string;
  status: "running" | "completed" | "interrupted";
  previousAttempt?: string;
  finishedAt?: string;
  passed?: boolean;
  reason?: string;
  [key: string]: unknown;
}
export class ExperimentStore {
  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
    readonly attempts: Attempt[],
  ) {}
  static async create(directory: string, manifest: Manifest): Promise<ExperimentStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await readFile(join(directory, "manifest.json"));
      throw new Error("Manifest exists; use --resume");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await writeJsonAtomic(
      join(directory, "manifest.json"),
      { ...manifest, createdAt: new Date().toISOString(), schemaVersion: 1 },
      { mode: 0o600 },
    );
    await mkdir(join(directory, "attempts"), { mode: 0o700 });
    return new ExperimentStore(directory, manifest, []);
  }
  static async resume(
    directory: string,
    fingerprint: string,
    configurations: Record<string, string | null>,
  ): Promise<ExperimentStore> {
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as Manifest;
    if (manifest.fingerprint !== fingerprint)
      throw new Error("Experiment fingerprint changed; create a versioned experiment instead");
    const keys = [
      ...new Set([...Object.keys(configurations), ...Object.keys(manifest.configurations)]),
    ].sort();
    if (keys.some((key) => configurations[key] !== manifest.configurations[key]))
      throw new Error("Original configuration changed; pause before resume");
    const attempts: Attempt[] = [];
    for (const name of (await readdir(join(directory, "attempts")))
      .filter((name) => name.endsWith(".json"))
      .sort())
      attempts.push(
        JSON.parse(await readFile(join(directory, "attempts", name), "utf8")) as Attempt,
      );
    const store = new ExperimentStore(directory, manifest, attempts);
    for (const attempt of attempts.filter((entry) => entry.status === "running"))
      await store.finish(attempt.id, {
        status: "interrupted",
        passed: false,
        reason: "Controller interrupted before final checkpoint; raw events remain authoritative",
      });
    return store;
  }
  pending(cases: readonly Case[]): Case[] {
    return cases.filter(
      (item) =>
        !this.attempts.some((entry) => entry.caseId === item.id && entry.status === "completed"),
    );
  }
  async start(item: Case): Promise<Attempt> {
    if (!this.pending([item]).length) throw new Error("Case already completed");
    if (this.attempts.some((entry) => entry.status === "running"))
      throw new Error("Sequential experiment already has a running attempt");
    const previous = this.attempts
      .filter((entry) => entry.caseId === item.id)
      .sort((a, b) => a.attempt - b.attempt)
      .at(-1);
    const attempt = (previous?.attempt ?? 0) + 1;
    const entry: Attempt = {
      id: `${item.id}-a${attempt}`,
      caseId: item.id,
      attempt,
      startedAt: new Date().toISOString(),
      status: "running",
      ...(previous ? { previousAttempt: previous.id } : {}),
    };
    await writeJsonAtomic(join(this.directory, "attempts", `${entry.id}.json`), entry, {
      mode: 0o600,
    });
    this.attempts.push(entry);
    return entry;
  }
  async finish(
    id: string,
    result: {
      status: "completed" | "interrupted";
      passed: boolean;
      reason: string;
      [key: string]: unknown;
    },
  ) {
    const entry = this.attempts.find((attempt) => attempt.id === id);
    if (entry?.status !== "running") throw new Error("Attempt is not running");
    Object.assign(entry, result, { finishedAt: new Date().toISOString() });
    await writeJsonAtomic(join(this.directory, "attempts", `${id}.json`), entry, { mode: 0o600 });
  }
}
