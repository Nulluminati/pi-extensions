/** Cross-session registration and exclusive ownership of workspace monitor panes. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { agentStateDir } from "../../../lib/paths.ts";
import { loadShards, removeShard, writeShard } from "../../../lib/presence-shards.ts";
import { assertWorkerId } from "../../workers/src/ids.ts";
import { HerdrRequestError, requestHerdr } from "./client.ts";
import type { WorkerReference } from "./worker-view.ts";
import { isMonitorSource, type MonitorSource, sourceIsLive } from "./workspace-sources.ts";

export interface MonitorPane {
  paneId: string;
  workspaceId: string;
  terminalId: string;
  tabId?: string;
}

interface Workspace {
  directory: string;
  server: string;
  parent: MonitorPane;
}

interface PaneSlot {
  phase: "pending" | "active" | "closed";
  pane?: MonitorPane;
  workers?: Record<string, WorkerPaneSlot>;
}

interface WorkerPaneSlot {
  phase: "pending" | "active" | "closed";
  worker: WorkerReference;
  pane?: MonitorPane;
  completed?: true;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function monitorPane(result: Record<string, unknown>): MonitorPane {
  const pane = result.pane;
  if (
    !object(pane) ||
    typeof pane.pane_id !== "string" ||
    !pane.pane_id ||
    typeof pane.workspace_id !== "string" ||
    !pane.workspace_id ||
    typeof pane.terminal_id !== "string" ||
    !pane.terminal_id
  )
    throw new Error("Herdr returned an invalid monitor pane identifier");
  return {
    paneId: pane.pane_id,
    workspaceId: pane.workspace_id,
    terminalId: pane.terminal_id,
    ...(typeof pane.tab_id === "string" && pane.tab_id ? { tabId: pane.tab_id } : {}),
  };
}

function paneValue(value: unknown): MonitorPane {
  if (
    !object(value) ||
    typeof value.paneId !== "string" ||
    !value.paneId ||
    typeof value.workspaceId !== "string" ||
    !value.workspaceId ||
    typeof value.terminalId !== "string" ||
    !value.terminalId ||
    (value.tabId !== undefined && (typeof value.tabId !== "string" || !value.tabId))
  )
    throw new Error("Invalid workspace monitor ownership record");
  return {
    paneId: value.paneId,
    workspaceId: value.workspaceId,
    terminalId: value.terminalId,
    ...(typeof value.tabId === "string" ? { tabId: value.tabId } : {}),
  };
}

function phase(value: unknown): value is PaneSlot["phase"] {
  return value === "pending" || value === "active" || value === "closed";
}

function workerKey(worker: WorkerReference): string {
  return createHash("sha256").update(`${worker.cwd}\u0000${worker.id}`).digest("hex");
}

async function readSlot(path: string): Promise<PaneSlot | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!object(value) || !phase(value.phase))
    throw new Error("Invalid workspace monitor ownership record");
  const slot: PaneSlot = { phase: value.phase };
  if (value.pane !== undefined) slot.pane = paneValue(value.pane);
  if (value.workers !== undefined) {
    if (!object(value.workers)) throw new Error("Invalid workspace monitor ownership record");
    slot.workers = {};
    for (const [key, item] of Object.entries(value.workers)) {
      if (
        !object(item) ||
        !phase(item.phase) ||
        !object(item.worker) ||
        typeof item.worker.cwd !== "string" ||
        !isAbsolute(item.worker.cwd) ||
        typeof item.worker.id !== "string"
      )
        throw new Error("Invalid workspace monitor ownership record");
      assertWorkerId(item.worker.id);
      const worker = { cwd: item.worker.cwd, id: item.worker.id };
      if (workerKey(worker) !== key) throw new Error("Invalid workspace monitor ownership record");
      const child: WorkerPaneSlot = { phase: item.phase, worker };
      if (item.completed !== undefined && item.completed !== true)
        throw new Error("Invalid workspace monitor ownership record");
      if (item.completed === true) child.completed = true;
      if (item.pane !== undefined) child.pane = paneValue(item.pane);
      if (child.phase === "active" && !child.pane)
        throw new Error("Invalid workspace monitor ownership record");
      slot.workers[key] = child;
    }
  }
  if (slot.phase === "active" && !slot.pane && !slot.workers)
    throw new Error("Invalid workspace monitor ownership record");
  return slot;
}

async function socketIdentity(socketPath: string): Promise<string> {
  try {
    const path = await realpath(socketPath);
    const info = await stat(path);
    // A socket replacement is a different server incarnation, even at the same pathname.
    return `${path}:${info.dev}:${info.ino}`;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return resolve(socketPath);
    throw error;
  }
}

async function liveSources(directory: string): Promise<MonitorSource[]> {
  const sources: MonitorSource[] = [];
  for (const source of Object.values(await loadShards<MonitorSource>(directory))) {
    if (!isMonitorSource(source)) throw new Error("Invalid workspace monitor source");
    // Heartbeat expiry hides stale output; only process death releases pane ownership.
    sources.push(source);
  }
  return sources;
}

export function createWorkspaceRegistry(options: {
  socketPath: string;
  parentPaneId: string;
  cwd: string;
  open(
    list: string,
    parent: MonitorPane,
    worker: WorkerReference,
    anchor?: MonitorPane,
    occupied?: readonly MonitorPane[],
  ): Promise<MonitorPane | undefined>;
  close(paneId: string): Promise<void>;
}) {
  const { socketPath, parentPaneId, cwd, open, close } = options;
  const name = `pi-${process.pid}-${randomUUID()}`;
  let workspace: Workspace | undefined;

  async function currentWorkspace(): Promise<Workspace> {
    if (process.platform === "win32") throw new Error("Worker monitor panes require a POSIX shell");
    const parent = monitorPane(
      await requestHerdr(socketPath, "pane.current", { caller_pane_id: parentPaneId }),
    );
    const server = await socketIdentity(socketPath);
    const key = createHash("sha256").update(`${server}\u0000${parent.workspaceId}`).digest("hex");
    return { parent, server, directory: join(agentStateDir("herdr"), "workspaces", key) };
  }

  async function samePane(scope: Workspace, pane: MonitorPane): Promise<MonitorPane | undefined> {
    if ((await socketIdentity(socketPath)) !== scope.server) return undefined;
    try {
      const current = monitorPane(
        await requestHerdr(socketPath, "pane.get", { pane_id: pane.paneId }),
      );
      return current.paneId === pane.paneId &&
        current.terminalId === pane.terminalId &&
        pane.workspaceId === scope.parent.workspaceId &&
        current.workspaceId === scope.parent.workspaceId &&
        (pane.tabId === undefined || current.tabId === pane.tabId)
        ? current
        : undefined;
    } catch (error) {
      if (
        error instanceof HerdrRequestError &&
        (error.code === "pane_not_found" || error.code === "not_found")
      )
        return undefined;
      throw error;
    }
  }

  async function publish(scope: Workspace, sources: MonitorSource[]): Promise<void> {
    if (Buffer.byteLength(JSON.stringify({ sources })) > 64 * 1024)
      throw new Error("Workspace worker list exceeded 64 KiB");
    await writeJsonAtomic(join(scope.directory, "worker-ids.json"), { sources }, { mode: 0o600 });
  }

  async function reconcilePanes(
    scope: Workspace,
    path: string,
    list: string,
    sources: MonitorSource[],
    completedIds: string[],
  ): Promise<void> {
    const slot: PaneSlot = (await readSlot(path)) ?? { phase: "active", workers: {} };
    if (slot.phase !== "active") return;
    const hadPanes =
      slot.pane !== undefined ||
      Object.values(slot.workers ?? {}).some(
        (child) => !child.completed && (child.phase === "active" || child.phase === "pending"),
      );
    const workers = slot.workers ?? {};
    slot.workers = workers;
    const occupied: MonitorPane[] = [];
    let anchor: MonitorPane | undefined;
    for (const child of Object.values(workers)) {
      if (child.phase !== "active" || !child.pane) continue;
      const current = await samePane(scope, child.pane);
      if (!current) child.phase = "closed";
      else {
        occupied.push(current);
        anchor ??= current;
      }
    }
    if (slot.pane) {
      const legacy = await samePane(scope, slot.pane);
      if (legacy) {
        occupied.push(legacy);
        anchor ??= legacy;
      } else delete slot.pane;
    }
    if (!anchor && hadPanes) {
      slot.phase = "closed";
      await writeJsonAtomic(path, slot, { mode: 0o600 });
      return;
    }
    const desired = new Map<string, WorkerReference>();
    for (const source of sources) {
      if (!(await sourceIsLive(source))) continue;
      for (const id of source.workerIds) {
        const worker = { cwd: source.cwd, id };
        desired.set(workerKey(worker), worker);
      }
    }
    for (const id of completedIds) {
      assertWorkerId(id);
      const worker = { cwd, id };
      const key = workerKey(worker);
      const child: WorkerPaneSlot = workers[key] ?? { phase: "closed", worker };
      child.completed = true;
      workers[key] = child;
    }
    // Persist completion before cleanup so stale contributors cannot reopen the worker.
    await writeJsonAtomic(path, slot, { mode: 0o600 });
    for (const [key, child] of Object.entries(workers)) {
      if (!child.completed) continue;
      desired.delete(key);
      if (child.phase !== "active" || !child.pane) continue;
      const current = await samePane(scope, child.pane);
      if (current) await close(current.paneId);
      // A failed close retains ownership and retries on the next refresh.
      if (!(await samePane(scope, child.pane))) child.phase = "closed";
    }
    if (
      slot.pane &&
      desired.size === 0 &&
      Object.values(workers).some((child) => child.completed)
    ) {
      const legacy = await samePane(scope, slot.pane);
      if (legacy) await close(legacy.paneId);
      if (!(await samePane(scope, slot.pane))) delete slot.pane;
    }
    occupied.length = 0;
    if (slot.pane) {
      const legacy = await samePane(scope, slot.pane);
      if (legacy) occupied.push(legacy);
    }
    for (const child of Object.values(workers)) {
      if (child.phase === "active" && child.pane) {
        const current = await samePane(scope, child.pane);
        if (current) occupied.push(current);
      }
    }
    anchor = occupied[0];
    await writeJsonAtomic(path, slot, { mode: 0o600 });
    for (const [key, worker] of desired) {
      if (workers[key]) continue;
      // Persist each attempt before mutation, including uncertain split responses.
      workers[key] = { phase: "pending", worker };
      await writeJsonAtomic(path, slot, { mode: 0o600 });
      try {
        const pane = await open(list, scope.parent, worker, anchor, occupied);
        if (pane) {
          workers[key] = { phase: "active", worker, pane };
          occupied.push(pane);
          anchor = pane;
        } else delete workers[key];
        await writeJsonAtomic(path, slot, { mode: 0o600 });
      } catch (error) {
        workers[key] = { phase: "closed", worker };
        if (!anchor) slot.phase = "closed";
        await writeJsonAtomic(path, slot, { mode: 0o600 });
        throw error;
      }
      // The replacement owns the shared tab before the legacy viewer can disappear.
      if (slot.pane && anchor && Object.values(workers).some((child) => child.phase === "active")) {
        const legacy = await samePane(scope, slot.pane);
        if (legacy) await close(legacy.paneId);
        if (!(await samePane(scope, slot.pane))) delete slot.pane;
        await writeJsonAtomic(path, slot, { mode: 0o600 });
      }
    }
    await writeJsonAtomic(path, slot, { mode: 0o600 });
  }

  async function release(scope: Workspace): Promise<void> {
    await withFileLock(join(scope.directory, "monitor.lock"), async () => {
      const sourcesDir = join(scope.directory, "sources");
      await removeShard(sourcesDir, name);
      const sources = await liveSources(sourcesDir);
      if (sources.length > 0) {
        await publish(scope, sources);
        return;
      }
      const slotPath = join(scope.directory, "pane.json");
      const slot = await readSlot(slotPath);
      if (slot?.pane && (await samePane(scope, slot.pane))) await close(slot.pane.paneId);
      for (const child of Object.values(slot?.workers ?? {})) {
        if (child.phase === "active" && child.pane && (await samePane(scope, child.pane)))
          await close(child.pane.paneId);
      }
      for (const path of [slotPath, join(scope.directory, "worker-ids.json")]) {
        await unlink(path).catch((error) => {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        });
      }
    });
  }

  return {
    async update(workerIds: string[], completedIds: string[] = []): Promise<void> {
      const next = await currentWorkspace();
      if (workspace && workspace.directory !== next.directory) await release(workspace);
      workspace = next;
      await mkdir(next.directory, { recursive: true, mode: 0o700 });
      await withFileLock(join(next.directory, "monitor.lock"), async () => {
        const sourcesDir = join(next.directory, "sources");
        await mkdir(sourcesDir, { recursive: true, mode: 0o700 });
        await writeShard(sourcesDir, {
          name,
          pid: process.pid,
          cwd,
          workerIds,
          updatedAt: Date.now(),
        });
        const sources = await liveSources(sourcesDir);
        const list = join(next.directory, "worker-ids.json");
        await publish(next, sources);
        const slotPath = join(next.directory, "pane.json");
        await reconcilePanes(next, slotPath, list, sources, completedIds);
      });
    },
    async stop(): Promise<void> {
      const previous = workspace;
      workspace = undefined;
      if (previous) await release(previous);
    },
  };
}
