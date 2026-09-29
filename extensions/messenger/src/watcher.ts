/** Inbox watcher: watches the mailbox directory so mail that arrives while
 *  the session is idle is delivered without waiting for a turn. The FSWatcher
 *  is per instance, owned by the object returned from createInboxWatcher. */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "pi";
import { inboxFileName, messengerDir } from "./store.ts";

// --- Types ---

export interface InboxWatcherOptions {
  /** Current agent name; empty until session_start claims an identity. */
  getAgentName: () => string;
  /** Delivers unread mail; the watcher only decides when delivery is safe. */
  deliver: (ctx: ExtensionContext) => Promise<void>;
}

export interface InboxWatcher {
  /** Watch the inbox directory for this session's mailbox. */
  start: (ctx: ExtensionContext) => void;
  /** Release the watch; safe to call repeatedly and before start. */
  stop: () => void;
}

// --- Watcher ---

export function createInboxWatcher(options: InboxWatcherOptions): InboxWatcher {
  const { deliver, getAgentName } = options;
  let watcher: FSWatcher | undefined;

  /**
   * Deliver unread mail when the session is idle. Settle-time delivery only
   * runs after a completed turn, so a session that is open but never prompted
   * would never check its mailbox; the watcher closes that gap by delivering
   * as soon as mail arrives while idle.
   */
  async function deliverWhenIdle(ctx: ExtensionContext): Promise<void> {
    try {
      if (!ctx.isIdle()) return;
      await deliver(ctx);
    } catch (error) {
      // ctx can go stale after session replacement; settle-time delivery
      // still works.
      console.debug("[messenger] inbox delivery failed:", error);
    }
  }

  function startInboxWatcher(ctx: ExtensionContext): void {
    const agentName = getAgentName();
    if (!agentName) return;
    stopInboxWatcher();
    try {
      const inboxDir = join(messengerDir(ctx.cwd), "inbox");
      mkdirSync(inboxDir, { recursive: true });
      watcher = watch(inboxDir, (_event, filename) => {
        if (filename && filename !== inboxFileName(agentName)) return;
        void deliverWhenIdle(ctx);
      });
      // The watched directory can vanish (project cleanup) or the watcher can
      // hit resource limits; delivery still works at settle time.
      watcher.on("error", (error) => {
        console.debug("[messenger] inbox watcher failed:", error);
      });
    } catch (error) {
      // Watching is best-effort; agent_settled delivery remains.
      console.debug("[messenger] inbox watcher could not start:", error);
    }
  }

  function stopInboxWatcher(): void {
    watcher?.close();
    watcher = undefined;
  }

  return { start: startInboxWatcher, stop: stopInboxWatcher };
}
