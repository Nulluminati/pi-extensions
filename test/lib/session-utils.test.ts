import { describe, expect, it } from "vitest";
import {
  extractText,
  extractToolCallBlocks,
  extractToolResultBlocks,
  findNewestCustomEntry,
  parseContentBlocks,
} from "../../lib/session-utils.ts";

describe("session-utils", () => {
  describe("parseContentBlocks", () => {
    it("normalizes string content into text blocks", () => {
      const blocks = parseContentBlocks("hello world");
      expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
    });

    it("normalizes array content into blocks", () => {
      const blocks = parseContentBlocks([
        { type: "text", text: "hello" },
        { type: "toolCall", name: "readFile", arguments: { path: "test.ts" } },
      ]);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: "text", text: "hello" });
      expect(blocks[1]).toEqual({
        type: "toolCall",
        name: "readFile",
        arguments: { path: "test.ts" },
      });
    });

    it("returns empty array for null/undefined", () => {
      expect(parseContentBlocks(null)).toEqual([]);
      expect(parseContentBlocks(undefined)).toEqual([]);
      expect(parseContentBlocks(42)).toEqual([]);
    });

    it("filters out non-object entries from arrays", () => {
      const blocks = parseContentBlocks([null, 42, { type: "text", text: "ok" }]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ type: "text", text: "ok" });
    });
  });

  describe("extractText", () => {
    it("extracts text from string content", () => {
      expect(extractText("hello")).toBe("hello");
    });

    it("extracts and concatenates text blocks from array", () => {
      const content = [
        { type: "text", text: "line 1" },
        { type: "toolCall", name: "test" },
        { type: "text", text: "line 2" },
      ];
      expect(extractText(content)).toBe("line 1\nline 2");
    });

    it("returns empty string for empty content", () => {
      expect(extractText([])).toBe("");
      expect(extractText(null)).toBe("");
    });
  });

  describe("extractToolCallBlocks", () => {
    it("extracts tool call blocks from array", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "toolCall", name: "readFile", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "writeFile", arguments: { path: "b.ts" } },
      ];
      const calls = extractToolCallBlocks(content);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.name).toBe("readFile");
      expect(calls[1]?.name).toBe("writeFile");
    });

    it("filters out blocks without type toolCall", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "toolResult", name: "test" },
      ];
      expect(extractToolCallBlocks(content)).toHaveLength(0);
    });

    it("filters out toolCall blocks without a name", () => {
      const content = [{ type: "toolCall" }];
      expect(extractToolCallBlocks(content)).toHaveLength(0);
    });
  });

  describe("extractToolResultBlocks", () => {
    it("extracts tool result blocks from array", () => {
      const content = [
        { type: "toolResult", name: "readFile", result: "file content" },
        { type: "text", text: "done" },
      ];
      const results = extractToolResultBlocks(content);
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("readFile");
    });

    it("returns empty array for content without tool results", () => {
      expect(extractToolResultBlocks([{ type: "text", text: "hello" }])).toHaveLength(0);
    });
  });

  describe("findNewestCustomEntry", () => {
    it("returns the newest matching custom entry", () => {
      const branch = [
        { type: "custom", customType: "session-name", data: { name: "older" } },
        { type: "message" },
        { type: "custom", customType: "other-type", data: { name: "unrelated" } },
        { type: "custom", customType: "session-name", data: { name: "newest" } },
      ];

      expect(findNewestCustomEntry(branch, "session-name")?.data).toEqual({ name: "newest" });
    });

    it("keeps searching older entries when the caller rejects one", () => {
      const branch = [
        { type: "custom", customType: "session-name", data: { name: "older" } },
        { type: "custom", customType: "session-name", data: {} },
      ];

      const entry = findNewestCustomEntry(
        branch,
        "session-name",
        (data) =>
          typeof data === "object" && data !== null && Boolean((data as { name?: unknown }).name),
      );

      expect(entry?.data).toEqual({ name: "older" });
    });

    it("returns undefined for an empty, missing, or non-matching branch", () => {
      expect(findNewestCustomEntry([], "session-name")).toBeUndefined();
      expect(findNewestCustomEntry(undefined, "session-name")).toBeUndefined();
      expect(findNewestCustomEntry([{ type: "message" }], "session-name")).toBeUndefined();
    });

    it("leaves the branch order untouched", () => {
      const branch = [
        { type: "custom", customType: "session-name", data: { name: "first" } },
        { type: "custom", customType: "session-name", data: { name: "second" } },
      ];

      findNewestCustomEntry(branch, "session-name");

      expect(branch.map((entry) => (entry.data as { name: string }).name)).toEqual([
        "first",
        "second",
      ]);
    });
  });
});
