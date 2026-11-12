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

/** Filesystems cap one path segment at 255 bytes, and percent-encoding expands
 *  each non-ASCII byte and each space to three. The longest filename a name
 *  becomes is the mailbox inside an atomic write:
 *  `<encoded>.jsonl.<pid>.<16 hex>.tmp` — `.jsonl` (6 bytes) plus a staging
 *  suffix of `.` + pid (7 digits, the widest Linux pid) + `.` + 16 hex +
 *  `.tmp` (29 bytes). A claim collision suffix (`-101`, 4 bytes, appended to
 *  the name before it is encoded) also lengthens the filename, so the encoded
 *  name gets 255 - 6 - 29 - 4 = 216 bytes. See store.ts (inboxFileName) and
 *  lib/presence-shards.ts (shardPath). */
const MAILBOX_SUFFIX_BYTES = ".jsonl".length;
const ATOMIC_TEMP_SUFFIX_BYTES = 1 + 7 + 1 + 16 + ".tmp".length;
const CLAIM_SUFFIX_BYTES = "-101".length;
const MAX_ENCODED_NAME_LENGTH =
  255 - MAILBOX_SUFFIX_BYTES - ATOMIC_TEMP_SUFFIX_BYTES - CLAIM_SUFFIX_BYTES;

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
 * containing a path separator or NUL, or long enough once percent-encoded that
 * the filename it becomes would exceed the filesystem's limit. Throws so a bad
 * `PI_MESSENGER_NAME` fails fast at session start instead of silently losing
 * mail.
 */
export function assertValidAgentName(name: string): void {
  if (!name || name.length > MAX_NAME_LENGTH || /[\\/\0]/.test(name)) {
    throw invalidNameError(
      name,
      `it must be a non-empty single path segment of at most ${MAX_NAME_LENGTH} characters ` +
        `(no "/", "\\", or NUL).`,
    );
  }
  const encoded = encodedNameLength(name);
  if (encoded === undefined) {
    throw invalidNameError(name, "it is not valid UTF-16, so it cannot be percent-encoded.");
  }
  if (encoded > MAX_ENCODED_NAME_LENGTH) {
    throw invalidNameError(
      name,
      `its percent-encoded form is ${encoded} bytes, and at most ` +
        `${MAX_ENCODED_NAME_LENGTH} bytes fit in a mailbox filename.`,
    );
  }
}

function invalidNameError(name: string, reason: string): Error {
  return new Error(`${JSON.stringify(name)} cannot be used as an agent name: ${reason}`);
}

/** Percent-encoded length of a name, or undefined when the string is not valid
 *  UTF-16: `encodeURIComponent` throws URIError on a lone surrogate, and no
 *  filename encoding can represent one. */
function encodedNameLength(name: string): number | undefined {
  try {
    return encodeURIComponent(name).length;
  } catch {
    return undefined;
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
