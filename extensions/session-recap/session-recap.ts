/**
 * Session Recap Extension
 *
 * Shows a one-line recap above the editor when you refocus a Pi session
 * or after idle time, so you can re-enter flow without re-reading scrollback.
 *
 * Triggers:
 *   1. Terminal focus reporting (DECSET ?1004) — drafts a recap on focus-out,
 *      reveals it on focus-in after min duration.
 *   2. Idle fallback — generates a recap N seconds after turn_end.
 *   3. /resume or /fork — recap where the prior session left off.
 *
 * Flags:
 *   --recap-idle-seconds <n>      Idle time before recap (default 45)
 *   --recap-focus-min-seconds <n> Min focus-out duration (default 3)
 *   --recap-disable-focus         Disable focus reporting
 *   --recap-during-active         Allow recaps during active agent turn
 *   --recap-disable               Disable entirely
 *   --recap-model <p/id>          Override model for recap generation
 *
 * Command:
 *   /recap                        Force-generate a recap now
 */

import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { extractText, extractToolCallBlocks } from "../../lib/session-utils.ts";

// --- Constants ---

// Status-bar indicator: a Nerd Font history icon in a distinct hue with a
// greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf02da); // nf-md-history
export const ICON_COLOR = "success";
export const TEXT_COLOR = "muted";

const WIDGET_KEY = "session-recap";
const STATUS_KEY = "session-recap";
const DEFAULT_IDLE_SECONDS = 45;
const DEFAULT_FOCUS_MIN_SECONDS = 3;
const RESUME_RECAP_DELAY_MS = 300;
const AUTO_DISMISS_MS = 120_000;

// DECSET 1004 focus reporting sequences
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

// --- Types ---

type Entry = {
  id?: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
};

type RecapReason = "idle" | "manual" | "resume" | "focus";

type RecapState = {
  idleTimer: NodeJS.Timeout | undefined;
  activeController: AbortController | undefined;
  activeReason: RecapReason | undefined;
  agentActive: boolean;
  focusDraftAfterAgent: boolean;
  focusListener: ((chunk: Buffer) => void) | undefined;
  focusEnabled: boolean;
  focusedOutAt: number | undefined;
  pendingRecap: string | undefined;
  lastDraftedLeafId: string | undefined;
  autoDismissTimer: NodeJS.Timeout | undefined;
};

// --- State management (WeakMap for per-instance) ---

const stateMap = new WeakMap<ExtensionAPI, RecapState>();

function getState(pi: ExtensionAPI): RecapState {
  const existing = stateMap.get(pi);
  if (existing) return existing;
  const fresh: RecapState = {
    idleTimer: undefined,
    activeController: undefined,
    activeReason: undefined,
    agentActive: false,
    focusDraftAfterAgent: false,
    focusListener: undefined,
    focusEnabled: false,
    focusedOutAt: undefined,
    pendingRecap: undefined,
    lastDraftedLeafId: undefined,
    autoDismissTimer: undefined,
  };
  stateMap.set(pi, fresh);
  return fresh;
}

function resetState(state: RecapState) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  if (state.activeController) {
    state.activeController.abort();
    state.activeController = undefined;
    state.activeReason = undefined;
  }
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }
  state.agentActive = false;
  state.focusDraftAfterAgent = false;
  state.focusedOutAt = undefined;
  state.pendingRecap = undefined;
  state.lastDraftedLeafId = undefined;
}

// --- Utilities ---

function splitModel(spec: string): { provider: string; id: string } | undefined {
  const idx = spec.indexOf("/");
  if (idx <= 0) return undefined;
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

function formatToolCallSummary(content: unknown): string[] {
  const blocks = extractToolCallBlocks(content);
  return blocks.map((b) => {
    const summary = JSON.stringify(b.arguments ?? {}).slice(0, 280);
    return `- ${b.name}(${summary})`;
  });
}

function buildRecentTranscript(entries: Entry[], fromLastUser = true): string {
  let slice = entries;
  if (fromLastUser) {
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e) continue;
      if (e.type === "message" && e.message?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) slice = entries.slice(lastUserIdx);
  }

  const lines: string[] = [];
  for (const e of slice) {
    if (e.type !== "message" || !e.message?.role) continue;
    const role = e.message.role;
    if (role === "user") {
      const t = extractText(e.message.content).trim();
      if (t) lines.push(`User: ${t.slice(0, 1200)}`);
    } else if (role === "assistant") {
      const t = extractText(e.message.content).trim();
      if (t) lines.push(`Assistant: ${t.slice(0, 1200)}`);
      const calls = formatToolCallSummary(e.message.content);
      if (calls.length) lines.push(...calls);
    } else if (role === "toolResult") {
      const t = extractText(e.message.content).trim();
      const name = e.message.toolName ?? "tool";
      if (t) lines.push(`Result(${name}): ${t.slice(0, 400)}`);
    }
  }
  return lines.join("\n");
}

function hasMeaningfulActivity(entries: Entry[]): boolean {
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === "message" && e.message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const tail = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
  let assistantWords = 0;
  let toolCalls = 0;
  for (const e of tail) {
    if (e.type !== "message") continue;
    if (e.message?.role === "assistant") {
      const t = extractText(e.message.content);
      assistantWords += t.split(/\s+/).filter(Boolean).length;
      toolCalls += formatToolCallSummary(e.message.content).length;
    }
  }
  return toolCalls > 0 || assistantWords >= 50;
}

async function generateRecap(
  transcript: string,
  ctx: ExtensionContext,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let model = ctx.model;
  if (modelOverride) {
    const parsed = splitModel(modelOverride);
    if (!parsed) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Invalid --recap-model format: ${modelOverride}. Expected provider/model-id.`,
          "warning",
        );
      }
      return undefined;
    }
    const found = getModel(parsed.provider, parsed.id);
    if (found) {
      model = found;
    } else {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `--recap-model not found: ${modelOverride}. Falling back to active model.`,
          "warning",
        );
      }
    }
  }
  if (!model) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return undefined;

  const prompt = `You produce a single-line recap of what the coding agent just did, so the user can re-enter flow after switching focus back to this session.

Rules:
- Output ONE line, no preamble, no markdown.
- Format: \`recap: <what happened, past tense, concrete>. Next: <one-line next step>.\`
- If there is no meaningful next step, omit the \`Next:\` clause.
- If the transcript shows the turn was aborted or errored, say so explicitly.
- Use file/function names where relevant. Be concrete, not vague.
- Max ~220 characters.

<transcript>
${transcript.slice(0, 12000)}
</transcript>`;

  const options: {
    apiKey: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    cacheRetention: string;
    maxTokens: number;
  } = {
    apiKey: auth.apiKey,
    cacheRetention: "none",
    maxTokens: 256,
  };
  if (auth.headers) {
    options.headers = auth.headers;
  }
  if (signal) {
    options.signal = signal;
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: "You write terse, concrete session recaps for a coding agent UI.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    options,
  );

  if (!response.content) return undefined;
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text ? text.split(/\r?\n/, 1)[0]?.trim() : undefined;
}

function showRecap(pi: ExtensionAPI, ctx: ExtensionContext, recap: string) {
  if (!ctx.hasUI) return;
  const state = getState(pi);

  // Clear any existing auto-dismiss timer
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }

  ctx.ui.setWidget(
    WIDGET_KEY,
    (
      _tui: unknown,
      theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
    ) => {
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;
      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const header = theme.fg("accent", theme.bold("✦ recap"));
          const textLines = wrapTextWithAnsi(theme.fg("dim", recap), width);
          cachedLines = [header, ...textLines];
          cachedWidth = width;
          return cachedLines;
        },
        invalidate(): void {
          cachedWidth = undefined;
          cachedLines = undefined;
        },
      };
    },
    { placement: "aboveEditor" },
  );

  // Auto-dismiss after timeout
  state.autoDismissTimer = setTimeout(() => {
    state.autoDismissTimer = undefined;
    clearRecap(pi, ctx);
  }, AUTO_DISMISS_MS);
}

function clearRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  const state = getState(pi);
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

// --- Focus reporting helpers ---

function attachFocusReporting(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (state.focusEnabled || pi.getFlag("recap-disable-focus") || !ctx.hasUI) return;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  try {
    process.stdout.write(FOCUS_ENABLE);
  } catch {
    return;
  }

  const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
  let buf = "";

  const listener = (chunk: Buffer) => {
    try {
      buf += chunk.toString("binary");
      let i = 0;
      while (i + MAX_SEQ <= buf.length) {
        if (buf.startsWith(FOCUS_IN_SEQ, i)) {
          handleFocusIn(pi, ctx);
          i += FOCUS_IN_SEQ.length;
        } else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
          handleFocusOut(pi, ctx);
          i += FOCUS_OUT_SEQ.length;
        } else {
          i++;
        }
      }
      buf = buf.slice(i);
      if (buf.length > 64) buf = buf.slice(-(MAX_SEQ - 1));
    } catch {
      /* best-effort */
    }
  };

  process.stdin.on("data", listener);
  state.focusListener = listener;
  state.focusEnabled = true;
}

function detachFocusReporting(pi: ExtensionAPI) {
  const state = getState(pi);
  if (state.focusListener) {
    try {
      process.stdin.off("data", state.focusListener);
    } catch {
      /* noop */
    }
    state.focusListener = undefined;
  }
  if (state.focusEnabled) {
    try {
      process.stdout.write(FOCUS_DISABLE);
    } catch {
      /* noop */
    }
    state.focusEnabled = false;
  }
  state.focusedOutAt = undefined;
  state.focusDraftAfterAgent = false;
  state.pendingRecap = undefined;
}

function handleFocusOut(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  state.focusedOutAt = Date.now();
  if (pi.getFlag("recap-disable") || state.activeController) return;

  if (state.agentActive && !pi.getFlag("recap-during-active")) {
    state.focusDraftAfterAgent = true;
    return;
  }

  const leaf = ctx.sessionManager.getLeafId();
  if (state.lastDraftedLeafId && leaf === state.lastDraftedLeafId) return;

  const entries = ctx.sessionManager.getBranch() as Entry[];
  if (!hasMeaningfulActivity(entries)) return;
  void generateAndShow(pi, ctx, { reason: "focus" });
}

function handleFocusIn(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  const outAt = state.focusedOutAt;
  state.focusedOutAt = undefined;
  state.focusDraftAfterAgent = false;
  if (outAt === undefined) return;

  const duration = Date.now() - outAt;
  const minMs = Number(pi.getFlag("recap-focus-min-seconds") ?? DEFAULT_FOCUS_MIN_SECONDS) * 1000;
  if (duration < minMs) {
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    if (state.activeReason === "focus") {
      if (state.activeController) {
        state.activeController.abort();
        state.activeController = undefined;
        state.activeReason = undefined;
      }
    }
    return;
  }

  if (state.pendingRecap) {
    const recap = state.pendingRecap;
    state.pendingRecap = undefined;
    showRecap(pi, ctx, recap);
  }
}

function maybeGenerateDeferredFocusRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (!state.focusDraftAfterAgent) return;
  if (state.focusedOutAt === undefined) return;
  if (state.agentActive) return;
  state.focusDraftAfterAgent = false;
  void generateAndShow(pi, ctx, { reason: "focus" });
}

// --- Core recap generation ---

async function generateAndShow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { reason: RecapReason },
) {
  const state = getState(pi);
  const entries = ctx.sessionManager.getBranch() as Entry[];
  if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

  const transcript = buildRecentTranscript(entries, opts.reason !== "resume");
  if (!transcript.trim()) return;

  const startLeaf = ctx.sessionManager.getLeafId();

  // Cancel any prior request
  if (state.activeController) {
    state.activeController.abort();
    state.activeController = undefined;
    state.activeReason = undefined;
  }

  const controller = new AbortController();
  state.activeController = controller;
  state.activeReason = opts.reason;

  const showStatus = opts.reason !== "resume" && opts.reason !== "focus";
  if (showStatus && ctx.hasUI) {
    ctx.ui.setStatus(
      STATUS_KEY,
      `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "drafting recap…")}`,
    );
  }

  try {
    const override = (pi.getFlag("recap-model") as string | undefined)?.trim() || undefined;
    const recap = await generateRecap(transcript, ctx, override, controller.signal);
    if (!recap || controller.signal.aborted) return;
    if (ctx.sessionManager.getLeafId() !== startLeaf) return;

    state.lastDraftedLeafId = startLeaf;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }

    if (opts.reason === "focus") {
      if (state.focusedOutAt === undefined) showRecap(pi, ctx, recap);
      else state.pendingRecap = recap;
    } else {
      showRecap(pi, ctx, recap);
    }
  } catch (err) {
    if (!controller.signal.aborted) console.error("[session-recap] failed:", err);
  } finally {
    if (state.activeController === controller) {
      state.activeController = undefined;
      state.activeReason = undefined;
      if (showStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

function scheduleIdleRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  if (pi.getFlag("recap-disable") || !ctx.hasUI) return;

  const seconds = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
  const ms = Math.max(5, Number.isFinite(seconds) ? seconds : DEFAULT_IDLE_SECONDS) * 1000;

  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    void generateAndShow(pi, ctx, { reason: "idle" });
  }, ms);
}

// --- Default export ---

export default async function sessionRecapExtension(pi: ExtensionAPI) {
  pi.registerFlag("recap-idle-seconds", {
    description: "Seconds after turn_end before the session recap is generated",
    type: "string",
    default: String(DEFAULT_IDLE_SECONDS),
  });
  pi.registerFlag("recap-focus-min-seconds", {
    description: "Minimum focus-out duration (seconds) before showing a recap on refocus",
    type: "string",
    default: String(DEFAULT_FOCUS_MIN_SECONDS),
  });
  pi.registerFlag("recap-disable-focus", {
    description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-during-active", {
    description: "Allow focus-triggered recaps while an agent turn is still running",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-disable", {
    description: "Disable the automatic session recap",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-model", {
    description: "Override the default (active) model, e.g. anthropic/claude-sonnet-4-6",
    type: "string",
    default: "",
  });

  // --- Event handlers ---

  pi.on("turn_end", async (_event, ctx) => {
    const state = getState(pi);
    state.lastDraftedLeafId = undefined;
    scheduleIdleRecap(pi, ctx);
    maybeGenerateDeferredFocusRecap(pi, ctx);
  });

  pi.on("turn_start", async () => {
    const state = getState(pi);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
  });

  pi.on("input", async (_event, ctx) => {
    const state = getState(pi);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.focusDraftAfterAgent = false;
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    clearRecap(pi, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = true;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    clearRecap(pi, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = false;
    maybeGenerateDeferredFocusRecap(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = false;
    state.focusDraftAfterAgent = false;
    resetState(state);
    detachFocusReporting(pi);
    clearRecap(pi, ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const state = getState(pi);
    resetState(state);
    attachFocusReporting(pi, ctx);
    if (pi.getFlag("recap-disable") || !ctx.hasUI) return;
    if (event.reason === "resume" || event.reason === "fork") {
      setTimeout(() => {
        void generateAndShow(pi, ctx, { reason: "resume" });
      }, RESUME_RECAP_DELAY_MS);
    }
  });

  // --- Manual command ---

  pi.registerCommand("recap", {
    description: "Generate a one-line recap of recent session activity",
    handler: async (_args, ctx) => {
      await generateAndShow(pi, ctx, { reason: "manual" });
    },
  });
}
