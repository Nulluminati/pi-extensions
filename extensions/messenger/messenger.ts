/**
 * Messenger Extension
 *
 * File-based coordination between Pi sessions sharing a project directory:
 * presence registry, per-agent mailboxes, and path reservations that block
 * other sessions' `edit`/`write` calls into claimed paths. No daemon — all
 * state lives under `<cwd>/.pi/messenger/`.
 *
 * Spawning parents should set `PI_MESSENGER_NAME` for workers so mailboxes
 * have stable addresses. Unread mail is delivered into the conversation once
 * the agent settles, so messages from other sessions reach the model without
 * polling.
 */

import type { ExtensionAPI, ExtensionContext } from "pi";
import { checkToolCall } from "./src/enforce.ts";
import {
  formatBlockReason,
  formatMessages,
  formatPresence,
  MESSENGER_STATE_EVENT,
  MESSENGER_STATUS_KEY,
  mailStatusText,
} from "./src/format.ts";
import { resolveAgentName } from "./src/identity.ts";
import { MESSENGER_PARAMETERS } from "./src/schemas.ts";
import {
  heartbeat,
  leaveRegistry,
  loadRegistry,
  loadReservations,
  markRead,
  readInbox,
  release,
  reserve,
  sendMessage,
} from "./src/store.ts";

// --- Constants ---

const INBOX_MESSAGE_TYPE = "messenger-inbox";

// --- Extension ---

export default async function messengerExtension(pi: ExtensionAPI) {
  let agentName = "";
  let delivering = false;

  // --- Publishing ---

  async function refreshStatus(ctx: ExtensionContext): Promise<number> {
    const unread = agentName ? await readInbox(ctx.cwd, agentName) : [];
    pi.events.emit(MESSENGER_STATE_EVENT, {
      name: agentName || null,
      unread: unread.length,
    });
    if (ctx.hasUI) {
      const text = mailStatusText(unread.length, agentName);
      ctx.ui.setStatus(MESSENGER_STATUS_KEY, text);
    }
    return unread.length;
  }

  // --- Mail delivery ---

  /**
   * Deliver unread mail into the conversation once the agent settles. The
   * message participates in context (it is a stored custom message), so the
   * model sees exactly what arrived — no polling tools required.
   */
  async function deliverInbox(ctx: ExtensionContext): Promise<void> {
    if (!agentName || delivering) return;
    const unread = await readInbox(ctx.cwd, agentName);
    if (unread.length === 0) return;
    if (!ctx.isIdle()) {
      await refreshStatus(ctx);
      return;
    }
    delivering = true;
    try {
      const body = unread.map((m) => `From ${m.from}: ${m.text}`).join("\n");
      pi.sendMessage(
        {
          customType: INBOX_MESSAGE_TYPE,
          content: [
            { type: "text", text: `Messenger inbox (${unread.length} message(s)):\n${body}` },
          ],
          display: true,
        },
        { triggerTurn: true },
      );
      await markRead(
        ctx.cwd,
        agentName,
        unread.map((m) => m.id),
      );
    } finally {
      delivering = false;
    }
    await refreshStatus(ctx);
  }

  // --- Tool ---

  pi.registerTool({
    name: "messenger",
    label: "Messenger",
    description:
      "Coordinate with other Pi sessions working in this project: see who is online (list), send messages (send), read your inbox (inbox), and claim file paths so other agents cannot edit them (reserve/release). Use send to ask another agent a question or hand off work; use reserve before starting edits in a shared area.",
    promptGuidelines: [
      "Use messenger (action=reserve) to claim paths before editing files in a project where other agents may be working, and action=send to coordinate instead of fighting over the same files.",
    ],
    parameters: MESSENGER_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === "whoami") {
        return {
          content: [{ type: "text", text: `You are "${agentName}".` }],
          details: { name: agentName },
        };
      }

      if (action === "list") {
        const registry = await loadRegistry(ctx.cwd);
        return {
          content: [{ type: "text", text: formatPresence(registry, agentName) }],
          details: { count: Object.keys(registry).length },
        };
      }

      if (action === "send") {
        const to = typeof params.to === "string" ? params.to.trim() : "";
        const text = typeof params.text === "string" ? params.text.trim() : "";
        if (!to) throw new Error("send requires to (recipient agent name).");
        if (!text) throw new Error("send requires text.");
        const registry = await loadRegistry(ctx.cwd);
        const message = await sendMessage(ctx.cwd, to, agentName, text);
        const note = registry[to]
          ? "Recipient is online; mail is delivered when their session settles."
          : `Warning: "${to}" is not currently online. The message is stored in their mailbox.`;
        return {
          content: [{ type: "text", text: `Sent to ${to}. ${note}` }],
          details: { messageId: message.id },
        };
      }

      if (action === "inbox") {
        const unread = await readInbox(ctx.cwd, agentName);
        await markRead(
          ctx.cwd,
          agentName,
          unread.map((m) => m.id),
        );
        await refreshStatus(ctx);
        return {
          content: [{ type: "text", text: formatMessages(unread) }],
          details: { count: unread.length },
        };
      }

      if (action === "reserve") {
        const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
        if (paths.length === 0) throw new Error("reserve requires paths (array of paths).");
        const reason = typeof params.reason === "string" ? params.reason : undefined;
        const { reserved, conflicts } = await reserve(ctx.cwd, agentName, paths, reason);
        const lines: string[] = [];
        for (const p of reserved) lines.push(`Reserved ${p}.`);
        for (const c of conflicts) {
          lines.push(`Could not reserve ${c.path}: held by ${c.owner}.`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") || "Nothing reserved." }],
          details: { reserved, conflicts },
        };
      }

      if (action === "release") {
        const paths = Array.isArray(params.paths) ? params.paths.map(String) : undefined;
        const released = await release(ctx.cwd, agentName, paths);
        return {
          content: [
            {
              type: "text",
              text:
                released.length > 0 ? `Released: ${released.join(", ")}` : "Nothing to release.",
            },
          ],
          details: { released },
        };
      }

      if (action === "status") {
        const text = typeof params.status === "string" ? params.status.trim() : "";
        await heartbeat(ctx.cwd, agentName, {
          pid: process.pid,
          cwd: ctx.cwd,
          ...(text ? { status: text } : {}),
        });
        return {
          content: [{ type: "text", text: text ? `Status set: ${text}` : "Status cleared." }],
          details: {},
        };
      }

      throw new Error(`Unknown messenger action: ${String(action)}`);
    },
  });

  // --- Reservation enforcement (edit/write only; bash is not covered) ---

  pi.on("tool_call", async (event, ctx) => {
    if (!agentName) return undefined;
    const reservations = await loadReservations(ctx.cwd);
    const block = checkToolCall(
      event.toolName,
      event.input as Record<string, unknown>,
      ctx.cwd,
      agentName,
      reservations,
    );
    if (!block) return undefined;
    ctx.ui.notify(formatBlockReason(block), "warning");
    return { block: true, reason: formatBlockReason(block) };
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    agentName = resolveAgentName();
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    await heartbeat(ctx.cwd, agentName, {
      pid: process.pid,
      cwd: ctx.cwd,
      ...(model !== undefined ? { model } : {}),
    });
    await refreshStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await heartbeat(ctx.cwd, agentName, { pid: process.pid, cwd: ctx.cwd });
    await deliverInbox(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Release our reservations and presence so other agents aren't blocked by
    // a dead session. Mailboxes are intentionally kept.
    await leaveRegistry(ctx.cwd, agentName);
    await release(ctx.cwd, agentName);
    if (ctx.hasUI) ctx.ui.setStatus(MESSENGER_STATUS_KEY, undefined);
  });
}
