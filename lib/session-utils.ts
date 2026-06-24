/**
 * Shared session entry parsing utilities.
 *
 * Used by extensions that need to extract text, tool calls, and tool results
 * from Pi session branch entries.
 */

// --- Types ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "toolResult";
  name?: string;
  result?: unknown;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

// --- Helpers ---

/**
 * Normalize message content (string or array) into an array of content blocks.
 */
export function parseContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ContentBlock => part != null && typeof part === "object" && "type" in part,
  );
}

/**
 * Extract and concatenate all text blocks from message content.
 */
export function extractText(content: unknown): string {
  return parseContentBlocks(content)
    .filter((block): block is TextBlock => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Extract tool call blocks from message content.
 */
export function extractToolCallBlocks(content: unknown): ToolCallBlock[] {
  return parseContentBlocks(content).filter(
    (block): block is ToolCallBlock => block.type === "toolCall" && typeof block.name === "string",
  );
}

/**
 * Extract tool result blocks from message content.
 */
export function extractToolResultBlocks(content: unknown): ToolResultBlock[] {
  return parseContentBlocks(content).filter(
    (block): block is ToolResultBlock => block.type === "toolResult",
  );
}
