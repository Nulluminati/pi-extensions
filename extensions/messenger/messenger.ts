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
 *
 * This file is the composition root: per-instance state and Pi wiring live
 * here; tool actions (src/actions.ts), mail delivery (src/delivery.ts), and
 * the inbox watcher (src/watcher.ts) are delegated to focused modules.
 */

import type { ExtensionAPI, ExtensionContext } from "pi";
import { excludeFromGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { runMessengerAction } from "./src/actions.ts";
import { deliverUnreadMail } from "./src/delivery.ts";
import { checkToolCall } from "./src/enforce.ts";
import {
  formatBlockReason,
  MESSENGER_ICON_COLOR,
  MESSENGER_STATE_EVENT,
  MESSENGER_STATUS_ICON,
  MESSENGER_STATUS_KEY,
  MESSENGER_TEXT_COLOR,
} from "./src/format.ts";
import { assertValidAgentName, resolveAgentName } from "./src/identity.ts";
import { MESSENGER_PARAMETERS } from "./src/schemas.ts";
import { resolveSessionIdentity } from "./src/session-identity.ts";
import {
  claimIdentity,
  heartbeat,
  leaveRegistry,
  loadReservations,
  readInbox,
  readoptReservations,
} from "./src/store.ts";
import { createInboxWatcher } from "./src/watcher.ts";

// --- Constants ---

/** Session entry that persists the agent identity across resumes (pi -c). */
const IDENTITY_CUSTOM_TYPE = "messenger-identity";

// --- Extension ---

export default async function messengerExtension(pi: ExtensionAPI) {
  let agentName = "";
  let delivering = false;

  // --- Status ---

  async function refreshStatus(ctx: ExtensionContext): Promise<number> {
    const unread = agentName ? await readInbox(ctx.cwd, agentName) : [];
    pi.events.emit(MESSENGER_STATE_EVENT, {
      name: agentName || null,
      unread: unread.length,
    });
    if (ctx.hasUI) {
      const text =
        unread.length === 0
          ? undefined
          : formatStatusLine(ctx.ui.theme, {
              icon: MESSENGER_STATUS_ICON,
              prefix: "Messenger",
              text: `${unread.length} unread · ${agentName}`,
              iconColor: MESSENGER_ICON_COLOR,
              textColor: MESSENGER_TEXT_COLOR,
            });
      ctx.ui.setStatus(MESSENGER_STATUS_KEY, text);
    }
    return unread.length;
  }

  // --- Mail delivery ---

  /**
   * Deliver unread mail into the conversation once the agent settles; the
   * delivery itself lives in src/delivery.ts.
   */
  async function deliverInbox(ctx: ExtensionContext): Promise<void> {
    // Single-flight gate is set before the first await so a watcher event and
    // a settle event that arrive together cannot both deliver the same mail.
    if (!agentName || delivering) return;
    delivering = true;
    try {
      await deliverUnreadMail(pi, ctx, agentName, refreshStatus);
    } finally {
      delivering = false;
    }
  }

  // --- Inbox watcher ---

  const inboxWatcher = createInboxWatcher({
    getAgentName: () => agentName,
    deliver: deliverInbox,
  });

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
      return runMessengerAction(params.action, params, ctx, {
        agentName,
        refreshStatus,
      });
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
    const reason = formatBlockReason(block);
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, reason };
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Keep project-local state out of `git status`; best-effort outside repos.
    try {
      await excludeFromGit(ctx.cwd, `${projectStateRelative("messenger")}/`);
    } catch (error) {
      console.error(`[messenger] git exclude failed: ${(error as Error).message}`);
    }
    const resolved = await resolveSessionIdentity(pi, ctx, {
      // "messenger-identity" keeps entries persisted by earlier versions.
      customType: IDENTITY_CUSTOM_TYPE,
      envVar: "PI_MESSENGER_NAME",
      generate: resolveAgentName,
    });
    // Fail fast on an unusable env/persisted name before anything is written,
    // then claim the identity atomically: the candidate loop and the durable
    // presence write happen inside the registry lock, so a concurrent session
    // (e.g. a fork of this one) gets the next suffix instead of sharing a
    // mailbox and reservation identity.
    assertValidAgentName(resolved);
    agentName = await claimIdentity(ctx.cwd, resolved);
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    await heartbeat(ctx.cwd, agentName, {
      pid: process.pid,
      cwd: ctx.cwd,
      ...(model !== undefined ? { model } : {}),
    });
    // The identity persists across resumes, so claims held before quitting
    // are re-adopted here before the orphan grace window can expire them.
    await readoptReservations(ctx.cwd, agentName);
    inboxWatcher.start(ctx);
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
    inboxWatcher.stop();
    if (ctx.hasUI) ctx.ui.setStatus(MESSENGER_STATUS_KEY, undefined);
  });
}
