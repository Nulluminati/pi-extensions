import { projectStateRelative } from "../../../lib/paths.ts";

/** Project-relative path of the worker sandbox policy (project-owned config). */
export const WORKER_SANDBOX_RELATIVE = projectStateRelative("sandbox.json");

/** Project-relative path of the executable setup hook (project-owned config). */
export const PROVISION_HOOK_RELATIVE = projectStateRelative("provision-worktree");
