import { describe, expect, it } from "vitest";
import { isNodeError } from "../../lib/errors.ts";

describe("isNodeError", () => {
  it("accepts an Error that carries a syscall code", () => {
    const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(isNodeError(error)).toBe(true);
  });

  it("rejects an Error without a code", () => {
    expect(isNodeError(new Error("plain failure"))).toBe(false);
  });

  it("rejects non-Error values, including code-shaped objects", () => {
    expect(isNodeError(undefined)).toBe(false);
    expect(isNodeError(null)).toBe(false);
    expect(isNodeError("ENOENT")).toBe(false);
    expect(isNodeError({ code: "ENOENT" })).toBe(false);
    expect(isNodeError(new TypeError("no code"))).toBe(false);
  });

  it("narrows to NodeJS.ErrnoException for callers", () => {
    const error: unknown = Object.assign(new Error("permission denied"), { code: "EACCES" });
    if (!isNodeError(error)) throw new Error("expected a Node error");
    expect(error.code).toBe("EACCES");
  });
});
