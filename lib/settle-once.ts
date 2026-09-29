/**
 * Settle-once guard for abortable `ctx.ui.custom` dialogs.
 *
 * A `ui.custom` dialog that can outlive its usefulness two ways — the user
 * picks an answer, or the session aborts while it is open — must resolve the
 * `done` callback exactly once. Both paths funnel through `settle`: the first
 * call wins, and the abort listener is removed before `done` runs so a late
 * abort can never re-enter. `dispose` removes the listener without settling;
 * call it from the dialog component's own dispose.
 *
 * The abort value stays at the call site (ask-user settles an aborted
 * questionnaire outcome; approval-mode settles "Block"), as does any
 * already-aborted check — the helper only owns the guard and listener
 * mechanics.
 */

export interface SettleOnceHandle<T> {
  /** Deliver the result to `done`; a no-op after the first call. */
  settle: (value: T) => void;
  /** Remove the abort listener without settling. Safe to call twice. */
  dispose: () => void;
}

export function createSettleOnce<T>(
  done: (value: T) => void,
  signal: AbortSignal | undefined,
  abortValue: T,
): SettleOnceHandle<T> {
  let settled = false;
  let onAbort = () => {};
  const settle = (value: T): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    done(value);
  };
  onAbort = () => settle(abortValue);
  signal?.addEventListener("abort", onAbort, { once: true });
  return { settle, dispose: () => signal?.removeEventListener("abort", onAbort) };
}
