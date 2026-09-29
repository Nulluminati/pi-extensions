/**
 * Timeout-abort controller shared by network fetch sites: one AbortController
 * fired by a timer and chained from the caller's abort signal. Pass `signal`
 * to fetch() and call `cleanup()` in a `finally` block once the response body
 * has been consumed, so the timeout also covers body parsing.
 */

export interface CreateTimeoutControllerOptions {
  /** Milliseconds before the signal aborts itself. */
  timeoutMs: number;
  /** Caller signal; aborting it also aborts the returned signal. */
  signal?: AbortSignal | undefined;
}

export interface TimeoutController {
  /** Signal to hand to fetch(). */
  signal: AbortSignal;
  /** Clear the timer and detach the caller's abort listener. Safe to call twice. */
  cleanup: () => void;
}

/**
 * Build an AbortController that fires after the requested timeout and also aborts
 * when the caller's signal fires. Network call sites share this so
 * timeout/cancellation behavior stays identical across providers.
 */
export function createTimeoutController(
  options: CreateTimeoutControllerOptions,
): TimeoutController {
  const { timeoutMs, signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      onCallerAbort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
