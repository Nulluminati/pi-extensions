/**
 * Provision command executor.
 *
 * Runs the config's `provision` command inside a throwaway Gondolin VM mounted
 * only to the worktree (the parent checkout is unreachable), with guest cache
 * homes redirected to a persistent host cache dir so worktree discard costs no
 * re-download. The platform matches the worker guests by construction.
 *
 * Design and review record: docs/issues/worktree-isolation-lacks-node-modules.md
 */

// --- Imports ---
import { mkdir } from "node:fs/promises";
import type { ExecOptions, RealFSProvider, VM } from "@earendil-works/gondolin";
import type { ProvisionRunOptions, ProvisionRunResult } from "./types.ts";

// --- Constants ---
const GUEST_WORKSPACE = "/workspace";
const GUEST_CACHE = "/cache";
const GUEST_NPM_CACHE = "/cache/npm";
const GUEST_XDG_CACHE = "/cache/xdg";
const GUEST_TMPDIR = "/cache/tmp";
/** ProvisionStatus.detail budget: tail of combined command output. */
const DETAIL_TAIL_CHARS = 400;

// --- Types ---

/** Minimal VM surface `runProvisionCommand` needs; fakes satisfy this. */
export interface VmLike {
  exec(
    command: string,
    options?: unknown,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

/** Factory for the provision VM; tests inject fakes through this. */
export type CreateVm = (opts: ProvisionRunOptions) => Promise<VmLike>;

/** Minimal `createHttpHooks` input used here. */
interface ProvisionHooksOptions {
  allowedHosts?: string[];
}

/** Minimal `createHttpHooks` result used here. */
interface ProvisionHooks {
  httpHooks: unknown;
  env: Record<string, string>;
}

/** Runtime shape of `@earendil-works/gondolin` used by this module. The
 *  ambient stubs in types/pi.d.ts predate `createHttpHooks`, so the dynamic
 *  import is cast to this interface. */
interface GondolinRuntime {
  VM: typeof VM;
  RealFSProvider: typeof RealFSProvider;
  createHttpHooks(options: ProvisionHooksOptions): ProvisionHooks;
}

// --- Helpers ---

/**
 * Boots the real provision VM: worktree-only project mount, persistent cache
 * mount, network allowlist, and cache homes redirected onto the cache mount.
 */
async function defaultCreateVm(opts: ProvisionRunOptions): Promise<VmLike> {
  const gondolin = (await import("@earendil-works/gondolin")) as unknown as GondolinRuntime;
  const { VM, RealFSProvider, createHttpHooks } = gondolin;
  const hooksOptions: ProvisionHooksOptions = {};
  if (opts.network !== undefined) hooksOptions.allowedHosts = opts.network;
  const hooks = createHttpHooks(hooksOptions);
  const vm: VM = await VM.create({
    httpHooks: hooks.httpHooks,
    env: {
      ...hooks.env,
      npm_config_cache: GUEST_NPM_CACHE,
      XDG_CACHE_HOME: GUEST_XDG_CACHE,
      TMPDIR: GUEST_TMPDIR,
    },
    vfs: {
      mounts: {
        [GUEST_WORKSPACE]: new RealFSProvider(opts.worktree),
        [GUEST_CACHE]: new RealFSProvider(opts.cacheDir),
      },
    },
  });
  return {
    exec: async (command, options) => {
      const result = await vm.exec(command, options as ExecOptions);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    close: () => vm.close(),
  };
}

/** Last ~400 chars of combined output, trimmed: keeps the failing line visible. */
function buildDetail(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.slice(-DETAIL_TAIL_CHARS).trim();
}

// --- Extension ---

/**
 * Runs the provision command in a throwaway VM and maps the outcome onto
 * `ProvisionRunResult`. Boots only happen here; callers decide whether a
 * command exists. The VM is always closed, and a close failure never masks
 * the command result.
 */
export async function runProvisionCommand(
  opts: ProvisionRunOptions,
  deps?: { createVm?: CreateVm },
): Promise<ProvisionRunResult> {
  const command = opts.command.trim();
  if (!command) {
    throw new Error("Provision command is empty: refusing to boot a throwaway provision VM.");
  }
  const createVm = deps?.createVm ?? defaultCreateVm;
  // The cache mount target must exist on the host before the guest boots;
  // RealFSProvider does not create missing host directories.
  await mkdir(opts.cacheDir, { recursive: true });
  const vm = await createVm(opts);
  const startedAt = Date.now();
  try {
    const result = await vm.exec(`cd ${GUEST_WORKSPACE} && ${command}`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    return {
      exitCode: result.exitCode,
      detail: buildDetail(result.stdout, result.stderr),
      ms: Date.now() - startedAt,
    };
  } finally {
    // Throwaway rule: the VM is torn down on every path. A close failure is
    // swallowed so it cannot mask the command's outcome.
    try {
      await vm.close();
    } catch {
      // Best-effort close; see comment above.
    }
  }
}
