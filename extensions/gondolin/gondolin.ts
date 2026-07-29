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
import { formatStatusLine } from "../../lib/ui-format.ts";
import { createGondolinBashOps } from "./src/bash.ts";
import {
  GUEST_WORKSPACE,
  ICON_COLOR,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
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
  let shellPath = "/bin/sh";

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    // Lazy-load the native addon so the ~36 MB krun runner only maps into the
    // process when a VM is actually started, not at extension import.
    const { VM, RealFSProvider } = await import("@earendil-works/gondolin");
    ctx?.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(ctx.ui.theme, {
        icon: STATUS_ICON,
        prefix: "Gondolin",
        text: `starting ${GUEST_WORKSPACE}`,
        iconColor: ICON_COLOR,
        textColor: TEXT_COLOR,
      }),
    );
    const created = await VM.create({
      sessionLabel: `pi ${path.basename(localCwd)}`,
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
        },
      },
    });
    const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";
    vm = created;
    ctx?.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(ctx.ui.theme, {
        icon: STATUS_ICON,
        prefix: "Gondolin",
        text: `${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`,
        iconColor: ICON_COLOR,
        textColor: TEXT_COLOR,
      }),
    );
    ctx?.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
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
    if (!activeVm) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(ctx.ui.theme, {
        icon: STATUS_ICON,
        prefix: "Gondolin",
        text: "stopping",
        iconColor: ICON_COLOR,
        textColor: TEXT_COLOR,
      }),
    );
    try {
      await activeVm.close();
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
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
