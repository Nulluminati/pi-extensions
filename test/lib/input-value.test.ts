import { Input } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { setInputValue } from "../../lib/input-value.ts";

describe("setInputValue", () => {
  it("places the cursor after the new value so typing appends", () => {
    const input = new Input();

    setInputValue(input, "body");
    input.handleInput("x");

    expect(input.getValue()).toBe("bodyx");
  });

  it("keeps the cursor inside a shorter replacement value", () => {
    const input = new Input();
    setInputValue(input, "a long draft");

    setInputValue(input, "ab");
    input.handleInput("c");

    expect(input.getValue()).toBe("abc");
  });
});
