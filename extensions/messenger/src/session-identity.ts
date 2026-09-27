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
 * The name this session last persisted, newest entry first. Undefined when
 * nothing was persisted yet.
 */
function lastPersistedName(
  branch: Array<{ type?: string; customType?: string; data?: { name?: string } }>,
  customType: string,
): string | undefined {
  for (const entry of [...branch].reverse()) {
    if (entry.type === "custom" && entry.customType === customType && entry.data?.name) {
      return entry.data.name;
    }
  }
  return undefined;
}

/**
 * Whether a persisted name belongs to the lineage an env name addresses:
 * the name itself, or a claim-time suffix of it (`w1-2` from `w1`, see
 * claimIdentity). A changed env names a different session on purpose and
 * must win.
 */
function isSameLineage(persisted: string, env: string): boolean {
  return persisted === env || persisted.startsWith(`${env}-`);
}

/**
 * Resolve this session's agent identity: environment override, then the name
 * persisted in the session (newest entry wins), then a freshly generated
 * name persisted for future resumes. An env override keeps a persisted
 * suffix of its own lineage (a resumed session stays on the mailbox it
 * claimed after a name collision) and honors a changed env.
 */
export async function resolveSessionIdentity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: SessionIdentityOptions,
): Promise<string> {
  const branch = ctx.sessionManager.getBranch() as Array<{
    type?: string;
    customType?: string;
    data?: { name?: string };
  }>;
  const persisted = lastPersistedName(branch, options.customType);
  const fromEnv = process.env[options.envVar]?.trim();
  if (fromEnv) {
    if (persisted && isSameLineage(persisted, fromEnv)) return persisted;
    return fromEnv;
  }
  if (persisted) return persisted;
  const name = options.generate();
  pi.appendEntry(options.customType, { name });
  return name;
}
