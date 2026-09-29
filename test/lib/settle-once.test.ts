import { describe, expect, it, vi } from "vitest";
import { createSettleOnce } from "../../lib/settle-once.ts";

describe("settle-once dialog guard", () => {
  it("calls done exactly once when settle runs twice", () => {
    const done = vi.fn();
    const handle = createSettleOnce<string>(done, undefined, "aborted");

    handle.settle("first");
    handle.settle("second");

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("first");
  });

  it("settles with the abort value when the signal aborts", () => {
    const done = vi.fn();
    const controller = new AbortController();
    createSettleOnce(done, controller.signal, "aborted");

    controller.abort();

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("aborted");
  });

  it("ignores user selection after an abort", () => {
    const done = vi.fn();
    const controller = new AbortController();
    const handle = createSettleOnce<string>(done, controller.signal, "aborted");

    controller.abort();
    handle.settle("choice");

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("aborted");
  });

  it("ignores abort after the user settled the dialog", () => {
    const done = vi.fn();
    const controller = new AbortController();
    const handle = createSettleOnce<string>(done, controller.signal, "aborted");

    handle.settle("choice");
    controller.abort();

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("choice");
  });

  it("removes the abort listener before done runs", () => {
    const done = vi.fn();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const handle = createSettleOnce<string>(done, controller.signal, "aborted");

    handle.settle("choice");

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(removeSpy.mock.invocationCallOrder[0]).toBeLessThan(done.mock.invocationCallOrder[0]);
  });

  it("dispose removes the listener without settling", () => {
    const done = vi.fn();
    const controller = new AbortController();
    const handle = createSettleOnce(done, controller.signal, "aborted");

    handle.dispose();
    controller.abort();

    expect(done).not.toHaveBeenCalled();
  });

  it("works without a signal", () => {
    const done = vi.fn();
    const handle = createSettleOnce<string>(done, undefined, "aborted");

    expect(() => handle.dispose()).not.toThrow();
    handle.settle("choice");

    expect(done).toHaveBeenCalledWith("choice");
  });
});
