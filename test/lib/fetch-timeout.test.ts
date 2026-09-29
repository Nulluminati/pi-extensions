import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutController } from "../../lib/fetch-timeout.ts";

describe("createTimeoutController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the signal when the timeout elapses on a hanging request", async () => {
    const { signal, cleanup } = createTimeoutController({ timeoutMs: 15_000 });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(aborted).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort before the full timeout has elapsed", async () => {
    const { signal, cleanup } = createTimeoutController({ timeoutMs: 15_000 });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    cleanup();
  });

  it("keeps the signal open and clears the timer once cleanup runs", async () => {
    const { signal, cleanup } = createTimeoutController({ timeoutMs: 15_000 });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });

    cleanup();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toBe(false);
  });

  it("aborts the signal when the caller's signal aborts", () => {
    const caller = new AbortController();
    const { signal, cleanup } = createTimeoutController({
      timeoutMs: 60_000,
      signal: caller.signal,
    });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });

    caller.abort();
    expect(aborted).toBe(true);
    cleanup();
  });

  it("stops listening for caller aborts after cleanup", () => {
    const caller = new AbortController();
    const { signal, cleanup } = createTimeoutController({
      timeoutMs: 60_000,
      signal: caller.signal,
    });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });

    cleanup();
    caller.abort();
    expect(aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts immediately when the caller's signal is already aborted", () => {
    const caller = new AbortController();
    caller.abort();

    const { signal, cleanup } = createTimeoutController({
      timeoutMs: 60_000,
      signal: caller.signal,
    });

    expect(signal.aborted).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates cleanup called more than once", () => {
    const caller = new AbortController();
    const { cleanup } = createTimeoutController({ timeoutMs: 15_000, signal: caller.signal });

    expect(() => {
      cleanup();
      cleanup();
    }).not.toThrow();
  });

  it("works without a caller signal", async () => {
    const { signal, cleanup } = createTimeoutController({ timeoutMs: 15_000 });

    let aborted = false;
    signal.addEventListener("abort", () => {
      aborted = true;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(aborted).toBe(true);
    cleanup();
  });
});
