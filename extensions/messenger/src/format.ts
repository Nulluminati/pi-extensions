/** Rendering helpers for messenger tool results and status. */

import type { Message, PresenceRegistry } from "./types.ts";

// --- Constants ---

export const MESSENGER_STATUS_KEY = "messenger";
export const MESSENGER_STATE_EVENT = "messenger:state";

// Envelope glyph for the footer status line, colored like other extensions'
// status icons (see lib/ui-format.ts consumers); text stays muted.
export const MESSENGER_STATUS_ICON = "✉";
export const MESSENGER_ICON_COLOR = "success";
export const MESSENGER_TEXT_COLOR = "muted";

// --- Formatting ---

export function formatPresence(registry: PresenceRegistry, selfName: string): string {
  const entries = Object.values(registry).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0)
    return "No other agents online. Join happened; presence shows on next heartbeat.";
  return entries
    .map((p) => {
      const self = p.name === selfName ? " (you)" : "";
      const model = p.model ? ` · ${p.model}` : "";
      const status = p.status ? ` · ${p.status}` : "";
      return `${p.name}${self} · pid ${p.pid}${model}${status}`;
    })
    .join("\n");
}

export function formatMessages(messages: Message[]): string {
  if (messages.length === 0) return "Inbox empty.";
  return messages
    .map((m) => `[${new Date(m.at).toLocaleTimeString()}] ${m.from}: ${m.text}`)
    .join("\n");
}

export function formatBlockReason(block: {
  prefix: string;
  owner: string;
  reason?: string;
}): string {
  const reason = block.reason ? ` (${block.reason})` : "";
  return (
    `Blocked: "${block.prefix}" is reserved by ${block.owner}${reason}. ` +
    `Message them with the messenger tool (action=send, to="${block.owner}") to coordinate.`
  );
}
