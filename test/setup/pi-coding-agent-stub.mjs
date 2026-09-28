/**
 * Runtime stub for `@earendil-works/pi-coding-agent` in spawned subprocesses.
 *
 * Pi bundles this package at runtime; the repository deliberately does not
 * install it. Tests that spawn bare `node` processes to exercise cross-process
 * behavior import extension modules, which reach the package through
 * lib/paths.ts. Vitest covers the same surface with test/setup/pi-coding-agent.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), CONFIG_DIR_NAME, "agent");
}
