/**
 * Shared helpers for the worker blocker-reporting channel.
 *
 * A delegated worker session declares "I cannot proceed" through its
 * `report_blocker` tool (worker-blocker extension). The sanitized reason is
 * appended as an `workers_blocker` marker line to the worker's own event
 * spool (`streams/<id>.jsonl`) — the file the parent already tails — so the
 * parent ingests it into the worker record and wakes once with ids and
 * status words only. The reason text itself stays behind the pull-only
 * output boundary: it is read via the workers tool (action=status), never
 * auto-delivered.
 *
 * Both halves of the channel (the worker-side tool and the parent-side
 * runner) import from here so the marker format and the sanitizing rules
 * cannot drift apart.
 */

// --- Constants ---

/** Spool marker type written by the worker's report_blocker tool. The
 * `workers_` prefix distinguishes parent/worker-appended markers from pi's
 * own JSON events. */
export const BLOCKER_MARKER_TYPE = "workers_blocker";

/** Environment variable the runner sets for a worker session: the absolute
 * path of the worker's own spool file. */
export const WORKER_STREAM_ENV_VAR = "PI_WORKER_STREAM";

/** Hard cap on a blocker reason: it travels one line and must stay a
 * glanceable status, not a report. */
export const BLOCKER_REASON_MAX_CHARS = 500;

// --- Types ---

/** A blocker reported by a worker: one sanitized line plus a timestamp. */
export interface WorkerBlocker {
  reason: string;
  at: number;
}

// --- Sanitizing ---

/**
 * Force a blocker reason into a single short line: control characters
 * (C0/C1) and Unicode line/paragraph separators become spaces, whitespace
 * runs collapse, and the result is trimmed and capped. Non-string input
 * yields an empty reason (nothing to report).
 */
/** Whether a code point is a C0/C1 control character or a Unicode
 * line/paragraph separator — the characters that must not survive in a
 * one-line blocker reason. */
function isStrippableControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

export function sanitizeBlockerReason(raw: unknown): { reason: string; truncated: boolean } {
  if (typeof raw !== "string") return { reason: "", truncated: false };
  let spaced = "";
  for (const char of raw) spaced += isStrippableControl(char.codePointAt(0) ?? 0) ? " " : char;
  const oneLine = spaced.replace(/\s+/g, " ").trim();
  if (oneLine.length <= BLOCKER_REASON_MAX_CHARS) return { reason: oneLine, truncated: false };
  return { reason: oneLine.slice(0, BLOCKER_REASON_MAX_CHARS), truncated: true };
}

// --- Parsing ---

/**
 * Parse one spool line as an `workers_blocker` marker; undefined for
 * anything else. The reason is re-sanitized defensively: markers may come
 * from files written by other processes.
 */
export function parseBlockerMarker(line: string): WorkerBlocker | undefined {
  let event: { type?: unknown; reason?: unknown; at?: unknown };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (event.type !== BLOCKER_MARKER_TYPE) return undefined;
  const { reason } = sanitizeBlockerReason(event.reason);
  if (!reason) return undefined;
  return { reason, at: typeof event.at === "number" ? event.at : Date.now() };
}
