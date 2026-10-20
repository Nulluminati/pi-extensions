/**
 * Prefill a pi-tui `Input`.
 *
 * `Input.setValue` keeps the cursor where it was (clamped to the new length),
 * so a field prefilled right after construction has its cursor at the start
 * and typed text lands before the value. This helper also moves the cursor to
 * the end, the way a user expects to continue a prefilled query or draft.
 */

import type { Input } from "@earendil-works/pi-tui";

// pi-tui keeps the cursor private and has no public method to move it.
type InputWithCursor = { cursor: number };

export function setInputValue(input: Input, value: string): void {
  input.setValue(value);
  (input as unknown as InputWithCursor).cursor = value.length;
}
