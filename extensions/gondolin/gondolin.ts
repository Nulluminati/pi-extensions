/**
 * Gondolin Sandbox Extension
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 */

import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { resolveGuestImagePath } from "../../lib/guest-image.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { createGondolinBashOps } from "./src/bash.ts";
import {
  GUEST_WORKSPACE,
  ICON_COLOR,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
  VM_EVENT,
} from "./src/constants.ts";
import {
  createGondolinEditOps,
  createGondolinLsOps,
  createGondolinReadOps,
  createGondolinWriteOps,
} from "./src/file-operations.ts";
import { executeGondolinGrep } from "./src/grep.ts";
import { createGondolinFindOps } from "./src/traversal.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR };

// --- Prerequisites ---

/** Loud prerequisite check: workers must fail visibly, never silently fall back to the host. */
export function assertGondolinPrereqs(nodeVersion = process.versions.node): void {
  const [major, minor] = nodeVersion.split(".").map(Number);
  const ok = (major ?? 0) > 23 || ((major ?? 0) === 23 && (minor ?? 0) >= 6);
  if (!ok) {
    throw new Error(
      `Gondolin requires Node.js >= 23.6.0 (found ${nodeVersion}). Upgrade Node or unset --gondolin.`,
    );
  }
}

// --- Extension ---

export default async function gondolinExtension(pi: ExtensionAPI) {
  pi.registerFlag("gondolin", {
    description: "Enable Gondolin sandbox VM for isolated file operations",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;
  let vmStartError: string | undefined;
  let shellPath = "/bin/sh";

  /** Headless-safe status update: json/rpc modes have no UI surface. */
  function setVmStatus(ctx: ExtensionContext | undefined, text: string): void {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(ctx.ui.theme, {
        icon: STATUS_ICON,
        prefix: "Gondolin",
        text,
        iconColor: ICON_COLOR,
        textColor: TEXT_COLOR,
      }),
    );
  }

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    assertGondolinPrereqs();
    // Lazy-load the native addon so the ~36 MB krun runner only maps into the
    // process when a VM is actually started, not at extension import.
    const { VM, RealFSProvider } = await import("@earendil-works/gondolin");
    pi.events.emit(VM_EVENT, { state: "starting" });
    setVmStatus(ctx, `starting ${GUEST_WORKSPACE}`);
    let created: VM;
    try {
      // Custom guest image is optional; without one the SDK boots its default
      // registry image (alpine-base, no git).
      const imagePath = resolveGuestImagePath();
      created = await VM.create({
        sessionLabel: `pi ${path.basename(localCwd)}`,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
        ...(imagePath && { sandbox: { imagePath } }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vmStartError = `Gondolin VM failed to start: ${message}. Check that QEMU is installed and on PATH (e.g. sudo dnf install qemu-system-x86).`;
      vmStarting = undefined;
      throw new Error(vmStartError);
    }
    // Create plus shell probe is one initialization transaction: any failure
    // after create closes the created VM so a retry cannot leak it, records
    // the persistent startup error, and fails exactly like create does.
    try {
      const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
      shellPath = bashProbe.stdout.trim() || "/bin/sh";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await created.close();
      } catch {
        // Best-effort: a failed close must not mask the probe error below.
      }
      vmStartError = `Gondolin VM failed to start: ${message}.`;
      vmStarting = undefined;
      throw new Error(vmStartError);
    }
    vm = created;
    pi.events.emit(VM_EVENT, { state: "ready", vmId: created.id });
    setVmStatus(ctx, `${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`);
    if (ctx?.hasUI) {
      ctx.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
    }
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    // A recorded startup failure makes every subsequent tool call fail loudly:
    // silently running on the host would defeat the sandbox the user asked for.
    if (vmStartError) throw new Error(vmStartError);
    if (!vmStarting) {
      vmStarting = startVm(ctx).finally(() => {
        vmStarting = undefined;
      });
    }
    return vmStarting;
  }

  async function getVmIfEnabled(ctx?: ExtensionContext): Promise<VM | undefined> {
    if (pi.getFlag("gondolin")) {
      return ensureVm(ctx);
    }
    return undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    await getVmIfEnabled(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeVm = vm;
    vm = undefined;
    vmStarting = undefined;
    vmStartError = undefined;
    if (!activeVm) return;
    pi.events.emit(VM_EVENT, { state: "stopping" });
    setVmStatus(ctx, "stopping");
    try {
      await activeVm.close();
    } finally {
      pi.events.emit(VM_EVENT, { state: "stopped" });
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.registerCommand("gondolin", {
    description: "Show Gondolin VM status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const activeVm = vm;
      if (!activeVm) {
        ctx.ui.notify("Gondolin is not running. Enable it with the --gondolin flag.", "info");
        return;
      }
      ctx.ui.notify(
        [
          `Gondolin VM: ${activeVm.id}`,
          `Host workspace: ${localCwd}`,
          `Guest workspace: ${GUEST_WORKSPACE}`,
          `Shell: ${shellPath}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createReadTool(GUEST_WORKSPACE, {
          operations: createGondolinReadOps(activeVm, localCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localRead.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createWriteTool(GUEST_WORKSPACE, {
          operations: createGondolinWriteOps(activeVm, localCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localWrite.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createEditTool(GUEST_WORKSPACE, {
          operations: createGondolinEditOps(activeVm, localCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localEdit.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createBashTool(GUEST_WORKSPACE, {
          operations: createGondolinBashOps(activeVm, localCwd, shellPath),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createLsTool(GUEST_WORKSPACE, {
          operations: createGondolinLsOps(activeVm, localCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localLs.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        const tool = createFindTool(GUEST_WORKSPACE, {
          operations: createGondolinFindOps(activeVm, localCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localFind.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await getVmIfEnabled(ctx);
      if (activeVm) {
        return executeGondolinGrep(activeVm, localCwd, params, signal);
      }
      return localGrep.execute(_id, params, signal, _onUpdate);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await getVmIfEnabled(ctx);
    if (activeVm) {
      return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const activeVm = await getVmIfEnabled(ctx);
    if (activeVm) {
      const localLine = `Current working directory: ${localCwd}`;
      const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
      const systemPrompt = event.systemPrompt.includes(localLine)
        ? event.systemPrompt.replace(localLine, guestLine)
        : `${event.systemPrompt}\n\n${guestLine}`;
      return { systemPrompt };
    }
  });
}
