/** Own monitor panes only. The worker runner retains every worker lifecycle operation. */

import { fileURLToPath } from "node:url";
import { loadWorkersFromBranch } from "../../workers/src/store.ts";
import { HerdrRequestError, requestHerdr } from "./client.ts";
import { cleanTranscriptText } from "./transcript-view.ts";
import { readWorkerRecord, type WorkerReference } from "./worker-view.ts";
import { createWorkspaceRegistry, type MonitorPane, monitorPane } from "./workspace-state.ts";

const VIEWER = fileURLToPath(new URL("./worker-viewer.ts", import.meta.url));

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createWorkerMonitors(options: {
  socketPath: string;
  parentPaneId: string;
  cwd: string;
  warn: (error: unknown) => void;
}) {
  const { socketPath, parentPaneId, cwd, warn } = options;
  const seen = new Set<string>();
  const watched = new Set<string>();
  let lastIds: string[] = [];
  let lastCompletedIds: string[] = [];
  let lastSync = 0;
  let initialized = false;
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  const registry = createWorkspaceRegistry({ socketPath, parentPaneId, cwd, open, close });

  async function close(paneId: string): Promise<void> {
    try {
      await requestHerdr(socketPath, "pane.close", { pane_id: paneId });
    } catch (error) {
      // Manually closed monitors no longer need cleanup.
      if (
        error instanceof HerdrRequestError &&
        (error.code === "not_found" || error.code === "pane_not_found")
      )
        return;
      warn(error);
    }
  }

  async function open(
    list: string,
    parent: MonitorPane,
    worker: WorkerReference,
    anchor?: MonitorPane,
    occupied: readonly MonitorPane[] = [],
  ): Promise<MonitorPane | undefined> {
    if (stopped) return undefined;
    const record = await readWorkerRecord(worker.cwd, worker.id);
    const name = typeof record?.name === "string" ? record.name : worker.id;
    const label = `Worker ${Array.from(cleanTranscriptText(name).replace(/\s+/gu, " ").trim()).slice(0, 80).join("") || worker.id}`;
    if (stopped) return undefined;
    if (anchor && !anchor.tabId)
      throw new Error("Herdr returned an invalid monitor tab identifier");
    const result = anchor
      ? await requestHerdr(socketPath, "pane.split", {
          target_pane_id: anchor.paneId,
          direction: "right",
          cwd: worker.cwd,
          focus: false,
        })
      : await requestHerdr(socketPath, "tab.create", {
          workspace_id: parent.workspaceId,
          label: "Workers",
          cwd: worker.cwd,
          focus: false,
        });
    const identity = monitorPane(anchor ? result : { pane: result.root_pane });
    const paneId = identity.paneId;
    if (
      paneId === parent.paneId ||
      identity.terminalId === parent.terminalId ||
      identity.workspaceId !== parent.workspaceId ||
      !identity.tabId ||
      (anchor && identity.tabId !== anchor.tabId) ||
      occupied.some((pane) => pane.paneId === paneId || pane.terminalId === identity.terminalId)
    )
      throw new Error("Herdr returned an invalid monitor pane identifier");
    if (stopped) {
      await close(paneId);
      return undefined;
    }
    try {
      await requestHerdr(socketPath, "pane.rename", { pane_id: paneId, label });
      if (stopped) {
        await close(paneId);
        return undefined;
      }
      // pane.send_input requires shell text. Only trusted paths and the fixed mode enter it.
      const text = `exec ${[process.execPath, VIEWER, worker.cwd, "--transcript", worker.id, list].map(quote).join(" ")}`;
      await requestHerdr(socketPath, "pane.send_input", { pane_id: paneId, text, keys: ["enter"] });
      return identity;
    } catch (error) {
      await close(paneId);
      throw error;
    }
  }

  return {
    refresh(branch: unknown[]): Promise<void> {
      if (stopped) return Promise.resolve();
      const workers = loadWorkersFromBranch(branch);
      for (const worker of workers.values()) {
        if (seen.has(worker.id)) continue;
        seen.add(worker.id);
        // Restore running workers, but do not flood startup with historical finished records.
        if (!initialized && worker.status !== "running") continue;
        watched.add(worker.id);
      }
      initialized = true;
      const ids = [...watched].filter((id) => workers.has(id));
      if (watched.size === 0) return queue;
      const completedIds = ids.filter((id) => workers.get(id)?.status === "completed");
      const unchanged =
        ids.length === lastIds.length &&
        ids.every((id, index) => id === lastIds[index]) &&
        completedIds.length === lastCompletedIds.length &&
        completedIds.every((id, index) => id === lastCompletedIds[index]);
      if (unchanged && Date.now() - lastSync < 20_000) return queue;
      lastIds = ids;
      lastCompletedIds = completedIds;
      lastSync = Date.now();
      queue = queue
        .then(async () => {
          if (!stopped) await registry.update(ids, completedIds);
        })
        .catch(warn);
      return queue;
    },
    async stop(): Promise<void> {
      stopped = true;
      // A late tab response still supplies an owned id; retain it for cleanup, never launch.
      await queue;
      await registry.stop().catch(warn);
    },
  };
}
