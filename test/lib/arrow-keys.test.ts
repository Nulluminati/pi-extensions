import { describe, expect, it } from "vitest";
import { isArrowDown, isArrowLeft, isArrowRight, isArrowUp } from "../../lib/arrow-keys.ts";

describe("arrow-key byte matchers", () => {
  it("matches CSI arrow sequences", () => {
    expect(isArrowUp("\u001b[A")).toBe(true);
    expect(isArrowDown("\u001b[B")).toBe(true);
    expect(isArrowRight("\u001b[C")).toBe(true);
    expect(isArrowLeft("\u001b[D")).toBe(true);
  });

  it("matches application-cursor arrow sequences", () => {
    expect(isArrowUp("\u001bOA")).toBe(true);
    expect(isArrowDown("\u001bOB")).toBe(true);
    expect(isArrowRight("\u001bOC")).toBe(true);
    expect(isArrowLeft("\u001bOD")).toBe(true);
  });

  it("does not match navigation letters", () => {
    expect(isArrowUp("k")).toBe(false);
    expect(isArrowDown("j")).toBe(false);
    expect(isArrowLeft("h")).toBe(false);
    expect(isArrowRight("l")).toBe(false);
  });

  it("does not match bare escape or modified sequences", () => {
    for (const matches of [isArrowUp, isArrowDown, isArrowLeft, isArrowRight]) {
      expect(matches("\u001b")).toBe(false);
      expect(matches("\u001b[1;5A")).toBe(false);
      expect(matches("\u001b[Z")).toBe(false);
      expect(matches("")).toBe(false);
    }
  });
});
