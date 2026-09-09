/**
 * Persisted per-session agent identity.
 *
 * A session's identity should survive process restarts and /reload: the name
 * is generated once per session and persisted as a custom entry in the
 * session transcript, so `pi -c` (same branch) resumes under the same name.
 * An environment variable overrides the persisted name — parents spawning
 * workers set it so children get stable, predictable mailbox addresses.
 */

import type { ExtensionAPI, ExtensionContext } from "pi";

// --- Types ---

export interface SessionIdentityOptions {
  /** Custom entry type the identity is persisted under (per-extension namespace). */
  customType: string;
  /** Environment variable checked before the persisted entry (e.g. PI_MESSENGER_NAME). */
  envVar: string;
  /** Generates a fresh name when there is no override and nothing persisted. */
  generate: () => string;
}

// --- Identity ---

/**
 * Resolve this session's agent identity: environment override, then the name
 * persisted in the session (newest entry wins), then a freshly generated
 * name persisted for future resumes.
 */
export async function resolveSessionIdentity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: SessionIdentityOptions,
): Promise<string> {
  const fromEnv = process.env[options.envVar]?.trim();
  if (fromEnv) return fromEnv;
  const branch = ctx.sessionManager.getBranch() as Array<{
    type?: string;
    customType?: string;
    data?: { name?: string };
  }>;
  for (const entry of [...branch].reverse()) {
    if (entry.type === "custom" && entry.customType === options.customType && entry.data?.name) {
      return entry.data.name;
    }
  }
  const name = options.generate();
  pi.appendEntry(options.customType, { name });
  return name;
}
