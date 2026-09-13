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

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { resolveSessionIdentity } from "../../lib/session-identity.ts";
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
  inboxFileName,
  leaveRegistry,
  loadRegistry,
  loadReservations,
  markRead,
  readInbox,
  readoptReservations,
  release,
  reserve,
  sendMessage,
} from "./src/store.ts";

// --- Constants ---

const INBOX_MESSAGE_TYPE = "messenger-inbox";
/** Session entry that persists the agent identity across resumes (pi -c). */
const IDENTITY_CUSTOM_TYPE = "messenger-identity";

// --- Extension ---

export default async function messengerExtension(pi: ExtensionAPI) {
  let agentName = "";
  let delivering = false;
  let inboxWatcher: FSWatcher | undefined;

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
    // Single-flight gate is set before the first await so a watcher event and
    // a settle event that arrive together cannot both deliver the same mail.
    if (!agentName || delivering) return;
    delivering = true;
    try {
      const unread = await readInbox(ctx.cwd, agentName);
      if (unread.length === 0) return;
      if (!ctx.isIdle()) {
        await refreshStatus(ctx);
        return;
      }
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
      await refreshStatus(ctx);
    } finally {
      delivering = false;
    }
  }

  // --- Inbox watcher ---

  /**
   * Deliver unread mail when the session is idle. Settle-time delivery only
   * runs after a completed turn, so a session that is open but never prompted
   * would never check its mailbox; the watcher closes that gap by delivering
   * as soon as mail arrives while idle.
   */
  async function deliverWhenIdle(ctx: ExtensionContext): Promise<void> {
    try {
      if (!ctx.isIdle()) return;
      await deliverInbox(ctx);
    } catch {
      // ctx can go stale after session replacement; settle-time delivery
      // still works.
    }
  }

  function stopInboxWatcher(): void {
    inboxWatcher?.close();
    inboxWatcher = undefined;
  }

  function startInboxWatcher(ctx: ExtensionContext): void {
    if (!agentName) return;
    stopInboxWatcher();
    try {
      const inboxDir = join(ctx.cwd, ".pi", "messenger", "inbox");
      mkdirSync(inboxDir, { recursive: true });
      inboxWatcher = watch(inboxDir, (_event, filename) => {
        if (filename && filename !== inboxFileName(agentName)) return;
        void deliverWhenIdle(ctx);
      });
      // The watched directory can vanish (project cleanup) or the watcher can
      // hit resource limits; delivery still works at settle time.
      inboxWatcher.on("error", () => {});
    } catch {
      // Watching is best-effort; agent_settled delivery remains.
    }
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
        const { reserved, conflicts } = await reserve(
          ctx.cwd,
          agentName,
          paths,
          reason,
          process.pid,
        );
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
    agentName = await resolveSessionIdentity(pi, ctx, {
      // "messenger-identity" keeps entries persisted by earlier versions.
      customType: IDENTITY_CUSTOM_TYPE,
      envVar: "PI_MESSENGER_NAME",
      generate: resolveAgentName,
    });
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    await heartbeat(ctx.cwd, agentName, {
      pid: process.pid,
      cwd: ctx.cwd,
      ...(model !== undefined ? { model } : {}),
    });
    // The identity persists across resumes, so claims held before quitting
    // are re-adopted here before the orphan grace window can expire them.
    await readoptReservations(ctx.cwd, agentName);
    startInboxWatcher(ctx);
    await refreshStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await heartbeat(ctx.cwd, agentName, { pid: process.pid, cwd: ctx.cwd });
    await deliverInbox(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Drop presence only. Claims and mailboxes persist: the identity is
    // stored in the session, so a resumed session (pi -c) re-adopts its
    // claims on session_start. If the session never resumes, claims expire
    // via the orphan grace window in loadReservations.
    await leaveRegistry(ctx.cwd, agentName);
    stopInboxWatcher();
    if (ctx.hasUI) ctx.ui.setStatus(MESSENGER_STATUS_KEY, undefined);
  });
}
