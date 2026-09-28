import { describe, expect, it } from "vitest";

describe("worker session env isolation", () => {
  it("strips worker variables before any test runs", () => {
    // The setup file runs before this; a worker shell exports all three.
    expect(process.env.PI_WORKER).toBeUndefined();
    expect(process.env.PI_MESSENGER_NAME).toBeUndefined();
    expect(process.env.PI_WORKER_STREAM).toBeUndefined();
  });
});
