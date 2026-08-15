/**
 * Context measurement: estimates how the context window is split between the
 * system prompt (with its embedded context files, skills, and tool schemas),
 * the conversation messages, free space, and the compaction reserve.
 *
 * The headline "used" number comes from `ctx.getContextUsage()` — provider
 * usage from the last assistant response plus estimates for trailing
 * messages. The per-category breakdown is estimated independently with
 * pi's own chars/4 heuristic (`estimateTokens`), so rows are labeled as
 * estimates and should be read as relative sizes, not exact counts.
 */

import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { extractText } from "../../../lib/session-utils.ts";
import type { ContextFileInfo, MessageSizeInfo, SessionTotals, SkillInfo } from "./types.ts";

// --- Types ---

export interface ContextBreakdown {
  modelLabel: string;
  /** Provider-reported context usage, or null before the first assistant response. */
  usedTokens: number | null;
  contextWindow: number;
  percent: number | null;
  freeTokens: number | null;
  /** Tokens pi reserves for the autocompact buffer. */
  reserveTokens: number;
  systemPromptTokens: number;
  contextFiles: ContextFileInfo[];
  skills: SkillInfo[];
  toolsTokens: number;
  activeToolCount: number;
  messageCount: number;
  messageTokens: number;
  largestMessages: MessageSizeInfo[];
  session: SessionTotals;
}

// --- Constants ---

const LARGEST_MESSAGES_LIMIT = 5;
const PREVIEW_LENGTH = 48;

// --- Helpers ---

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return estimateTokens({ role: "user", content: [{ type: "text", text }] });
}

/** Shorten a context file path for display: cwd-relative, then ~-relative. */
function summarizePath(path: string, cwd: string): string {
  const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  if (path.startsWith(cwdPrefix)) return `./${path.slice(cwdPrefix.length)}`;
  const home = typeof process.env.HOME === "string" ? process.env.HOME : "";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractCostTotal(cost: unknown): number {
  if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
  if (typeof cost === "string") {
    const n = Number(cost);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof cost === "object" && cost !== null) {
    return toNumber((cost as { total?: unknown }).total);
  }
  return 0;
}

// --- Session usage ---

/** Sum provider-reported usage across all assistant messages in the branch. */
export function sumSessionUsage(entries: unknown[]): SessionTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) continue;
    const msg = message as { role?: unknown; usage?: unknown };
    if (msg.role !== "assistant") continue;
    if (typeof msg.usage !== "object" || msg.usage === null) continue;
    const usage = msg.usage as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      cost?: unknown;
    };
    input += toNumber(usage.input);
    output += toNumber(usage.output);
    cacheRead += toNumber(usage.cacheRead);
    cacheWrite += toNumber(usage.cacheWrite);
    cost += extractCostTotal(usage.cost);
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost,
  };
}

// --- Breakdown ---

/** Measure every category of the current context. Runs synchronously. */
export function measureContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextBreakdown {
  const usage = ctx.getContextUsage();
  const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
  const usedTokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const freeTokens =
    usedTokens !== null && contextWindow > 0 ? Math.max(0, contextWindow - usedTokens) : null;

  // System prompt: the assembled string pi sends, which embeds context files,
  // skill descriptions, tool snippets, and guidelines.
  const systemPromptTokens = estimateTextTokens(ctx.getSystemPrompt());

  // Context files (AGENTS.md / CLAUDE.md): per-file estimate so a bloated file
  // is visible at a glance, mirroring Claude Code's "memory files" rows.
  const options = ctx.getSystemPromptOptions();
  const contextFiles: ContextFileInfo[] = [];
  for (const file of options.contextFiles ?? []) {
    if (typeof file !== "object" || file === null) continue;
    const path = typeof file.path === "string" ? file.path : "";
    const content = typeof file.content === "string" ? file.content : "";
    if (!path) continue;
    contextFiles.push({ path: summarizePath(path, ctx.cwd), tokens: estimateTextTokens(content) });
  }

  // Skills: only the descriptions load into the prompt, so measure those.
  const skills: SkillInfo[] = [];
  for (const skill of options.skills ?? []) {
    if (typeof skill !== "object" || skill === null) continue;
    const s = skill as { name?: unknown; description?: unknown };
    const name = typeof s.name === "string" ? s.name : "";
    const description = typeof s.description === "string" ? s.description : "";
    if (!name) continue;
    skills.push({ name, tokens: estimateTextTokens(description) });
  }

  // Tools: active tool definitions (name, description, parameter schema) are
  // serialized into the system prompt, so estimate them the same way.
  const activeTools = pi.getActiveTools();
  const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  let toolsTokens = 0;
  for (const name of activeTools) {
    const tool = toolsByName.get(name);
    const parameters = JSON.stringify(tool?.parameters ?? {});
    toolsTokens += estimateTextTokens(`${name}\n${tool?.description ?? ""}\n${parameters}`);
  }

  // Messages: every branch entry with a role, estimated with pi's heuristic
  // (handles text, images, tool calls, and tool results).
  const entries = ctx.sessionManager.getBranch();
  let messageCount = 0;
  let messageTokens = 0;
  const messageSizes: MessageSizeInfo[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; message?: unknown };
    if (e.type !== "message") continue;
    if (typeof e.message !== "object" || e.message === null) continue;
    const message = e.message as { role?: unknown; content?: unknown };
    if (typeof message.role !== "string") continue;
    messageCount += 1;
    const tokens = estimateTokens(message);
    messageTokens += tokens;
    const preview = extractText(message.content)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PREVIEW_LENGTH);
    messageSizes.push({ role: message.role, preview, tokens });
  }
  const largestMessages = messageSizes
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LARGEST_MESSAGES_LIMIT);

  return {
    modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)",
    usedTokens,
    contextWindow,
    percent,
    freeTokens,
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    systemPromptTokens,
    contextFiles,
    skills,
    toolsTokens,
    activeToolCount: activeTools.length,
    messageCount,
    messageTokens,
    largestMessages,
    session: sumSessionUsage(entries),
  };
}
