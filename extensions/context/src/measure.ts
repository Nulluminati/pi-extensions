/**
 * Context measurement: estimates how the context window is split between the
 * system prompt (with its embedded context files and skills section), the
 * tool schemas sent as the API tools parameter, the conversation messages,
 * free space, and the compaction reserve.
 *
 * The headline "used" number comes from `ctx.getContextUsage()` — provider
 * usage from the last assistant response plus estimates for trailing
 * messages. The category rows use pi's chars/4 heuristic (`estimateTokens`):
 * the system prompt parent is measured from the assembled prompt, and its
 * sub-rows (base prompt, context files, skills) are measured so they sum to
 * the parent. Tool schemas are measured separately because pi sends them as
 * the API `tools` parameter, not inside the prompt text. Rows are estimates;
 * read them as relative sizes, not exact counts.
 */

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  // TypeScript 7.0.2 (native preview) fails to resolve the skills re-export
  // line in the shipped index.d.ts and drops every name from it; the runtime
  // export exists, so the suppression stays until the compiler resolves it.
  // @ts-expect-error unresolved re-export in pi-coding-agent's declarations
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { sumSessionUsage } from "../../../lib/session-usage.ts";
import { extractText } from "../../../lib/session-utils.ts";
import type { ContextFileInfo, MessageSizeInfo, SessionTotals } from "./types.ts";

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
  /** Prompt remainder after context files and skills: preamble, rules, docs, snippets. */
  basePromptTokens: number;
  contextFiles: ContextFileInfo[];
  /** Estimated tokens of the skills section exactly as pi embeds it. */
  skillsTokens: number;
  skillCount: number;
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

// --- Session usage ---

export { sumSessionUsage };

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

  // Skills: pi embeds a rendered skills section (name, description, and file
  // path per skill, inside <available_skills> markup) and only when a
  // file-read tool is active. Measure the section with pi's own formatter so
  // the row matches what the prompt actually carries.
  const rawSkills = Array.isArray(options.skills) ? options.skills : [];
  const skills = rawSkills.flatMap((skill) => {
    if (typeof skill !== "object" || skill === null) return [];
    const s = skill as {
      name?: unknown;
      description?: unknown;
      filePath?: unknown;
      disableModelInvocation?: unknown;
    };
    const name = typeof s.name === "string" ? s.name : "";
    if (!name) return [];
    return [
      {
        name,
        description: typeof s.description === "string" ? s.description : "",
        filePath: typeof s.filePath === "string" ? s.filePath : "",
        disableModelInvocation: s.disableModelInvocation === true,
      },
    ];
  });
  const selectedTools = options.selectedTools ?? ["read", "bash", "edit", "write"];
  const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool));
  let skillsTokens = 0;
  if (skillFileReadTool && skills.length > 0) {
    skillsTokens = estimateTextTokens(formatSkillsForPrompt(skills, skillFileReadTool).trim());
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
    // Remainder of the prompt after the measured embedded parts, so the
    // sub-rows sum to the parent. Clamped in case estimates overshoot.
    basePromptTokens: Math.max(
      0,
      systemPromptTokens - contextFiles.reduce((sum, file) => sum + file.tokens, 0) - skillsTokens,
    ),
    contextFiles,
    skillsTokens,
    skillCount: skills.length,
    toolsTokens,
    activeToolCount: activeTools.length,
    messageCount,
    messageTokens,
    largestMessages,
    session: sumSessionUsage(entries),
  };
}
