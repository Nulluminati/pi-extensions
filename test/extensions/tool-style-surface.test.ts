import { describe, expect, it } from "vitest";
import {
  darkenHex,
  parseWalSurface,
  toBackgroundAnsi,
} from "../../extensions/tool-style/src/surface.ts";

describe("tool-style surface", () => {
  it("darkens RGB channels by the configured proportion", () => {
    expect(darkenHex("#282A36", 0.25)).toBe("#1e2029");
    expect(darkenHex("#0A0E14", 0.25)).toBe("#080b0f");
  });

  it("rejects invalid colors and darkening proportions", () => {
    expect(darkenHex("#xyzxyz", 0.25)).toBeUndefined();
    expect(darkenHex("#282a36", -0.1)).toBeUndefined();
    expect(darkenHex("#282a36", 1.1)).toBeUndefined();
  });

  it("reads the terminal background from pywal JSON", () => {
    const json = JSON.stringify({ special: { background: "#282A36" } });

    expect(parseWalSurface(json, 0.25)).toBe("#1e2029");
  });

  it("returns undefined for malformed or incomplete pywal JSON", () => {
    expect(parseWalSurface("not json", 0.25)).toBeUndefined();
    expect(parseWalSurface(JSON.stringify({ special: {} }), 0.25)).toBeUndefined();
  });

  it("converts a computed surface to a truecolor background sequence", () => {
    expect(toBackgroundAnsi("#1e2029")).toBe("\u001b[48;2;30;32;41m");
    expect(toBackgroundAnsi("invalid")).toBeUndefined();
  });
});
