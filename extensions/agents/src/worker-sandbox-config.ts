import { projectStateRelative } from "../../../lib/paths.ts";

/** Project-relative path of the worker sandbox policy (project-owned config). */
export const WORKER_SANDBOX_RELATIVE = projectStateRelative("sandbox.json");
