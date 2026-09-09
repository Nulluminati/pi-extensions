/** Agent identity for messenger sessions. Name resolution order:
 * 1. `PI_MESSENGER_NAME` environment variable (set by parents spawning
 *    workers so they get a stable, predictable mailbox),
 * 2. a generated nature-themed name, unique per process.
 * The name is intentionally process-scoped, not session-scoped: one pi
 * process owns one identity. */

import { randomBytes } from "node:crypto";

// --- Constants ---

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

export function resolveAgentName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_MESSENGER_NAME?.trim();
  if (fromEnv) return fromEnv;
  const adjective = ADJECTIVES[randomBytes(1).readUInt8(0) % ADJECTIVES.length];
  const noun = NOUNS[randomBytes(1).readUInt8(0) % NOUNS.length];
  const suffix = randomBytes(1).readUInt8(0).toString(16);
  return `${adjective}-${noun}-${suffix}`;
}

/** Whether this session's identity is stable (PI_MESSENGER_NAME set) and can
 *  be re-adopted by a restarted session, e.g. `pi -c`. */
export function hasStableName(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_MESSENGER_NAME?.trim());
}
