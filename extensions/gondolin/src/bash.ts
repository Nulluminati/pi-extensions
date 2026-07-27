import type { VM } from "@earendil-works/gondolin";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { toGuestPath } from "./paths.ts";

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(localCwd, cwd);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const envObj = sanitizeEnv(env);
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          ...(envObj && { env: envObj }),
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(chunk.data);
        const result = await proc;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
