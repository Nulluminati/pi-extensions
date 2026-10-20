/** Name interactive Pi sessions from their first user message. */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractText, findNewestCustomEntry } from "../../lib/session-utils.ts";
import { cleanName, generateTitle } from "./src/title.ts";

// --- Constants ---

const ENTRY = "session-name:state";

// --- Types ---

interface NameState {
  sessionId: string;
  name: string;
  phase: "temporary" | "generated" | "failed";
}

// --- Helpers ---

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNameState(value: unknown): value is NameState {
  return (
    object(value) &&
    typeof value.sessionId === "string" &&
    typeof value.name === "string" &&
    typeof value.phase === "string" &&
    ["temporary", "generated", "failed"].includes(value.phase)
  );
}

function userPrompt(message: unknown): string | undefined {
  if (!object(message) || message.role !== "user") return undefined;
  const text = extractText(message.content).trim();
  if (text) return text;
  if (
    Array.isArray(message.content) &&
    message.content.some((part) => object(part) && part.type === "image")
  )
    return "The user submitted an image without accompanying text.";
  return undefined;
}

function firstPrompt(branch: unknown[]): string | undefined {
  for (const entry of branch) {
    if (
      !object(entry) ||
      entry.type !== "message" ||
      !object(entry.message) ||
      entry.message.role !== "user"
    )
      continue;
    return userPrompt(entry.message);
  }
  return undefined;
}

function temporaryName(ctx: ExtensionContext, sessionId: string): string {
  const project = [...cleanName(basename(ctx.cwd) || "root")].slice(0, 32).join("");
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8);
  return `Pi · ${project || "project"} · ${shortId}`;
}

// --- Extension ---

export default async function sessionNameExtension(pi: ExtensionAPI) {
  if (process.env.PI_WORKER === "1") return;
  pi.registerFlag("session-name-disable", {
    description: "Disable automatic session names",
    type: "boolean",
    default: false,
  });

  let state: NameState | undefined;
  let controller: AbortController | undefined;
  let attempted = false;

  function reset(): void {
    controller?.abort();
    controller = undefined;
    state = undefined;
    attempted = false;
  }

  function eligible(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && ctx.hasUI && !pi.getFlag("session-name-disable");
  }

  function current(expected: NameState, ctx: ExtensionContext, request: AbortController): boolean {
    if (
      state !== expected ||
      controller !== request ||
      request.signal.aborted ||
      pi.getSessionName() !== expected.name
    )
      return false;
    try {
      return ctx.sessionManager.getSessionId() === expected.sessionId;
    } catch {
      return false;
    }
  }

  function startTitle(prompt: string | undefined, ctx: ExtensionContext): void {
    if (!prompt || !eligible(ctx) || !state || state.phase !== "temporary" || attempted) return;
    if (pi.getSessionName() !== state.name || ctx.sessionManager.getSessionId() !== state.sessionId)
      return;
    attempted = true;
    const expected = state;
    const request = new AbortController();
    controller = request;
    // A title request runs beside the main turn and never enters model context.
    void generateTitle(prompt, ctx, request.signal)
      .then((name) => {
        if (!current(expected, ctx, request)) return;
        state = { sessionId: expected.sessionId, name, phase: "generated" };
        pi.appendEntry(ENTRY, state);
        pi.setSessionName(name);
      })
      .catch((error) => {
        if (!current(expected, ctx, request)) return;
        state = { ...expected, phase: "failed" };
        pi.appendEntry(ENTRY, state);
        ctx.ui.notify(
          `Session naming failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      })
      .finally(() => {
        if (controller === request) controller = undefined;
      });
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    if (!eligible(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const existing = pi.getSessionName();
    const saved = findNewestCustomEntry(branch, ENTRY, isNameState)?.data;
    if (existing) {
      // Only a matching transcript marker establishes ownership of a temporary name.
      if (
        !isNameState(saved) ||
        saved.sessionId !== sessionId ||
        saved.name !== existing ||
        saved.phase !== "temporary"
      )
        return;
      state = { ...saved };
    } else {
      state = { sessionId, name: temporaryName(ctx, sessionId), phase: "temporary" };
      pi.appendEntry(ENTRY, state);
      pi.setSessionName(state.name);
    }
    startTitle(firstPrompt(branch), ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (state) startTitle(userPrompt(event.message), ctx);
  });

  pi.on("session_info_changed", (event) => {
    if (state?.phase === "temporary" && event.name !== state.name) reset();
  });

  pi.on("session_shutdown", () => {
    reset();
  });
}
