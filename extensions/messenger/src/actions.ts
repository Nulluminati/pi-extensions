/** Messenger tool actions: one branch per `action` value. Each branch reads
 *  its inputs defensively from `params` and returns a tool result; failures
 *  throw so the tool layer surfaces the message to the model. Per-instance
 *  state (agent name, status refresh) is passed in by the composition root. */

import type { AgentToolResult, ExtensionContext } from "pi";
import { formatMessages, formatPresence } from "./format.ts";
import {
  heartbeat,
  loadRegistry,
  markRead,
  readInbox,
  release,
  reserve,
  sendMessage,
} from "./store.ts";

// --- Types ---

/** Loose view of the messenger tool parameters; actions narrow defensively. */
export interface MessengerActionParams {
  action?: unknown;
  to?: unknown;
  text?: unknown;
  status?: unknown;
  paths?: unknown;
  reason?: unknown;
}

/** Per-instance collaborators the actions need. */
export interface MessengerActionDeps {
  /** This session's agent name, claimed at session_start. */
  agentName: string;
  /** Refreshes the unread badge and presence event after inbox changes. */
  refreshStatus: (ctx: ExtensionContext) => Promise<number>;
}

// --- Actions ---

/** Dispatch one messenger tool action and build its result. */
export async function runMessengerAction(
  action: unknown,
  params: MessengerActionParams,
  ctx: ExtensionContext,
  deps: MessengerActionDeps,
): Promise<AgentToolResult> {
  const { agentName, refreshStatus } = deps;

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
    // Limite de confiance : un worker ne pousse jamais du texte généré
    // par un modèle dans une autre conversation (mail auto-délivré avec
    // triggerTurn). La sortie d'un worker ne remonte au parent que par
    // les surfaces en lecture du tool workers (status, tail, spool).
    // Les workers REÇOivent du courrier ; ils ne l'envoient pas.
    if (process.env.PI_WORKER === "1") {
      throw new Error(
        "send is disabled for worker sessions: worker output reaches the parent only through the workers tool (status, tail). A worker receives mail but never sends it.",
      );
    }
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
    const { reserved, conflicts } = await reserve(ctx.cwd, agentName, paths, reason, process.pid);
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
          text: released.length > 0 ? `Released: ${released.join(", ")}` : "Nothing to release.",
        },
      ],
      details: { released },
    };
  }

  if (action === "status") {
    const text = typeof params.status === "string" ? params.status.trim() : "";
    // An empty string tells heartbeat to remove the stored status.
    await heartbeat(ctx.cwd, agentName, {
      pid: process.pid,
      cwd: ctx.cwd,
      status: text,
    });
    return {
      content: [{ type: "text", text: text ? `Status set: ${text}` : "Status cleared." }],
      details: {},
    };
  }

  throw new Error(`Unknown messenger action: ${String(action)}`);
}
