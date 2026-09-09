/** Messenger state types: presence, mailboxes, and path reservations for
 * file-based coordination between Pi sessions sharing a project. */

// --- Types ---

export interface Presence {
  name: string;
  pid: number;
  cwd: string;
  model?: string;
  status?: string;
  startedAt: number;
  lastSeenAt: number;
}

/** One message in an agent's mailbox (JSONL, one per line). */
export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  read?: boolean;
}

export interface Reservation {
  owner: string;
  /** Owning process pid, used to expire claims from crashed sessions. */
  pid?: number;
  reason?: string;
  at: number;
}

/** Registry file shape: agent name → presence. */
export type PresenceRegistry = Record<string, Presence>;

/** Reservations file shape: normalized path prefix → claim. */
export type ReservationMap = Record<string, Reservation>;

export interface InboxEntry {
  id: string;
  from: string;
  text: string;
  at: number;
}
