import { describe, expect, it } from "vitest";
import { formatTranscriptEntry, type TranscriptEntry } from "../../lib/transcript-prompt.ts";

function message(overrides: Partial<NonNullable<TranscriptEntry["message"]>>): TranscriptEntry {
  return { type: "message", message: { role: "user", ...overrides } };
}

describe("transcript-prompt", () => {
  describe("formatTranscriptEntry", () => {
    it("formats user messages with the User: prefix", () => {
      expect(formatTranscriptEntry(message({ role: "user", content: "hello" }))).toBe(
        "User: hello",
      );
    });

    it("formats assistant messages with the Assistant: prefix", () => {
      expect(formatTranscriptEntry(message({ role: "assistant", content: "hi there" }))).toBe(
        "Assistant: hi there",
      );
    });

    it("formats tool results with the tool name and Result() prefix", () => {
      expect(
        formatTranscriptEntry(
          message({ role: "toolResult", toolName: "read", content: "file body" }),
        ),
      ).toBe("Result(read): file body");
    });

    it("falls back to Result(tool) when the tool name is missing", () => {
      expect(formatTranscriptEntry(message({ role: "toolResult", content: "output" }))).toBe(
        "Result(tool): output",
      );
    });

    it("joins text blocks from array content", () => {
      const content = [
        { type: "text", text: "first part." },
        { type: "toolCall", name: "read" },
        { type: "text", text: "second part." },
      ];
      expect(formatTranscriptEntry(message({ role: "user", content }))).toBe(
        "User: first part.\nsecond part.",
      );
    });

    it("truncates user and assistant text at 1200 characters", () => {
      const text = "a".repeat(1201);
      expect(formatTranscriptEntry(message({ role: "user", content: text }))).toBe(
        `User: ${"a".repeat(1200)}`,
      );
      expect(formatTranscriptEntry(message({ role: "assistant", content: text }))).toBe(
        `Assistant: ${"a".repeat(1200)}`,
      );
    });

    it("truncates tool result text at 400 characters", () => {
      const text = "b".repeat(401);
      expect(
        formatTranscriptEntry(message({ role: "toolResult", toolName: "grep", content: text })),
      ).toBe(`Result(grep): ${"b".repeat(400)}`);
    });

    it("returns undefined for messages whose text is empty or whitespace", () => {
      expect(formatTranscriptEntry(message({ role: "assistant", content: "" }))).toBeUndefined();
      expect(formatTranscriptEntry(message({ role: "user", content: "   \n  " }))).toBeUndefined();
      expect(formatTranscriptEntry(message({ role: "toolResult", content: [] }))).toBeUndefined();
    });

    it("returns undefined for non-message entries and roleless messages", () => {
      expect(formatTranscriptEntry({ type: "custom" })).toBeUndefined();
      expect(
        formatTranscriptEntry({ type: "message", message: { content: "no role" } }),
      ).toBeUndefined();
      expect(formatTranscriptEntry({ type: "message" })).toBeUndefined();
    });
  });
});
