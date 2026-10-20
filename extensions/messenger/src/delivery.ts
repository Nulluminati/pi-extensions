/** Mail delivery: pushes unread messages into the conversation as a stored
 *  custom message so they participate in context. Used by settle-time
 *  delivery and the idle inbox watcher; concurrency is gated by the caller
 *  (the composition root's single-flight flag). */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { markRead, readInbox } from "./store.ts";
import type { Message } from "./types.ts";

// --- Constants ---

const INBOX_MESSAGE_TYPE = "messenger-inbox";

// --- Helpers ---

/** Renders unread mail as one "From <sender>: <text>" line per message. */
function formatUnreadMail(unread: Message[]): string {
  return unread.map((m) => `From ${m.from}: ${m.text}`).join("\n");
}

// --- Delivery ---

/**
 * Deliver unread mail into the conversation once the agent settles. The
 * message participates in context (it is a stored custom message), so the
 * model sees exactly what arrived — no polling tools required.
 */
export async function deliverUnreadMail(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentName: string,
  refreshStatus: (ctx: ExtensionContext) => Promise<number>,
): Promise<void> {
  const { unread } = await readInbox(ctx.cwd, agentName);
  if (unread.length === 0) return;
  if (!ctx.isIdle()) {
    await refreshStatus(ctx);
    return;
  }
  const body = formatUnreadMail(unread);
  pi.sendMessage(
    {
      customType: INBOX_MESSAGE_TYPE,
      content: [{ type: "text", text: `Messenger inbox (${unread.length} message(s)):\n${body}` }],
      display: true,
    },
    { triggerTurn: true },
  );
  // Announce the arrival (unread count feeds both the themed fallback
  // line and the status bar's ✉ slot), then clear it: auto-delivery
  // marks the mail read, so the count must drop to zero immediately.
  await refreshStatus(ctx);
  await markRead(
    ctx.cwd,
    agentName,
    unread.map((m) => m.id),
  );
  await refreshStatus(ctx);
}
