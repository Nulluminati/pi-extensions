/** Agent identity for messenger sessions. Name resolution order:
 * 1. `PI_MESSENGER_NAME` environment variable (set by parents spawning
 *    workers so they get a stable, predictable mailbox),
 * 2. a generated nature-themed name, unique per process.
 * The name is intentionally process-scoped, not session-scoped: one pi
 * process owns one identity. */

import { randomBytes } from "node:crypto";

// --- Constants ---

/** Names become mailbox filenames and presence shards, so they must stay a
 *  single path segment; percent-encoding cannot rescue an empty or absurdly
 *  long name. */
const MAX_NAME_LENGTH = 200;

const ADJECTIVES = [
  "swift",
  "lunar",
  "iron",
  "amber",
  "quiet",
  "bright",
  "cobalt",
  "ember",
  "veiled",
  "north",
  "silent",
  "solar",
];

const NOUNS = [
  "raven",
  "falcon",
  "otter",
  "lynx",
  "heron",
  "badger",
  "maple",
  "birch",
  "quartz",
  "delta",
  "cascade",
  "summit",
];

// --- Identity ---

/**
 * Reject names that cannot be a mailbox: empty, longer than 200 characters,
 * or containing a path separator or NUL. Throws so a bad `PI_MESSENGER_NAME`
 * fails fast at session start instead of silently losing mail.
 */
export function assertValidAgentName(name: string): void {
  if (!name || name.length > MAX_NAME_LENGTH || /[\\/\0]/.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} cannot be used as an agent name: it must be a non-empty ` +
        `single path segment of at most ${MAX_NAME_LENGTH} characters (no "/", "\\", or NUL).`,
    );
  }
}

export function resolveAgentName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_MESSENGER_NAME?.trim();
  if (fromEnv) {
    assertValidAgentName(fromEnv);
    return fromEnv;
  }
  const adjective = ADJECTIVES[randomBytes(1).readUInt8(0) % ADJECTIVES.length];
  const noun = NOUNS[randomBytes(1).readUInt8(0) % NOUNS.length];
  const suffix = randomBytes(1).readUInt8(0).toString(16);
  return `${adjective}-${noun}-${suffix}`;
}
