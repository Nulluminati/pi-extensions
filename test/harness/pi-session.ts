/**
 * In-memory Pi session for extension lifecycle tests.
 *
 * Builds a real `AgentSession` with the SDK: an in-memory session manager and
 * settings, a resource loader that loads only the given extensions, and the
 * pi-ai faux provider as the model. Scripted faux responses answer every model
 * request, so a session needs no credentials and makes no network requests.
 *
 * All Pi state lives in a temporary directory that is also the session cwd
 * and `PI_CODING_AGENT_DIR`; `dispose` removes it. Nothing reads or writes
 * `~/.pi` or the repository's `.pi` config.
 *
 * Use it from the runtime suite (`test/runtime/`). The default suite stubs
 * `@earendil-works/pi-coding-agent` in `test/setup/`, so a real session cannot
 * start there.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export interface PiSessionOptions {
  /** Extension factories to load, such as an extension's default export. */
  extensions?: ExtensionFactory[];
  /** Extension entry files to load through Pi's own extension loader. */
  extensionPaths?: string[];
  /** Model replies, in request order. */
  responses?: FauxResponseStep[];
  /** Settings merged over the harness defaults (no compaction, no retry). */
  settings?: Settings;
  /** Prepare the session before extensions bind, such as appending persisted entries. */
  setup?: (sessionManager: SessionManager) => void;
}

export interface PiSession {
  session: AgentSession;
  sessionManager: SessionManager;
  faux: FauxProviderHandle;
  /** A copy of the context the model received, one per request. */
  requests: TranscriptContext[];
  /** Temporary directory that holds all Pi state for this session. */
  cwd: string;
  dispose(): void;
}

export async function createPiSession(options: PiSessionOptions = {}): Promise<PiSession> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const restore = () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  };

  try {
    const requests: TranscriptContext[] = [];
    const faux = fauxProvider();
    faux.setResponses(
      (options.responses ?? []).map((step) => (context, streamOptions, state, model) => {
        requests.push(structuredClone(context));
        return typeof step === "function" ? step(context, streamOptions, state, model) : step;
      }),
    );

    const modelRuntime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "models-store"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const sessionManager = SessionManager.inMemory(cwd);
    options.setup?.(sessionManager);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...options.settings,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      additionalExtensionPaths: (options.extensionPaths ?? []).map((path) => resolve(path)),
      extensionFactories: options.extensions ?? [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: faux.getModel(),
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "builtin",
    });
    await session.bindExtensions({});

    return {
      session,
      sessionManager,
      faux,
      requests,
      cwd,
      dispose: () => {
        session.dispose();
        restore();
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}
