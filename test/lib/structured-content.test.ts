import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { asStructuredContent } from "../../lib/structured-content.ts";

interface Row {
  id: number;
  label?: string;
}

describe("asStructuredContent", () => {
  it("returns the same plain data typed as JsonValue", () => {
    const rows: Row[] = [{ id: 1 }, { id: 2, label: "two" }];
    const data = { rows };

    const result = asStructuredContent(data);

    expect(result).toBe(data);
    expectTypeOf(result).toEqualTypeOf<JsonValue>();
  });
});
