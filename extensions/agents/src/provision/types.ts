/**
 * Worktree provisioning: the status records and refusal type shared by the
 * setup pipeline and the worker registry. The mechanism speaks verbs only:
 * carry, run, commit. Project setup policy lives in an executable hook, a
 * `.worktreeinclude`, and the worker sandbox policy file.
 */

// --- Status (mechanism output) ---

/** `yes` ran green; `failed` refused with detail; `skipped` no worktree or
 *  plan-mode worker; `busy` lock wait exhausted. */
export type ProvisionState = "yes" | "none" | "failed" | "skipped" | "busy";

/** Persisted on `WorkerRecord.provision`; echoed in delegate responses. */
export interface ProvisionStatus {
  state: ProvisionState;
  detail?: string;
  at: number;
}
