import type { Mock } from "vitest";

/**
 * Deeply mock an interface: replace all function properties with Vitest Mock instances.
 *
 * - Function properties become `Mock` (preserving `.mock` access in tests)
 * - Constructable types (class instances like `Date`, `AbortSignal`, `Array`) are preserved
 *   to avoid mocking built-in methods that tests may need as real values
 * - `any` types are preserved to avoid infinite recursion
 * - Non-function, non-object primitives are preserved as-is
 * - Objects recurse (interfaces, plain objects)
 */
// Use `any` in the function constraint so the conditional matches functions
// with specific parameter/return types under TypeScript 6's strict variance
// checks. `unknown` would only match `(...args: unknown[]) => unknown`.
export type DeepMocked<T> = 0 extends 1 & T
  ? T
  : T extends new (
        // biome-ignore lint/suspicious/noExplicitAny: see comment above
        ...args: any[]
        // biome-ignore lint/suspicious/noExplicitAny: see comment above
      ) => any
    ? T
    : T extends (
          // biome-ignore lint/suspicious/noExplicitAny: see comment above
          ...args: any[]
          // biome-ignore lint/suspicious/noExplicitAny: see comment above
        ) => any
      ? Mock
      : T extends object
        ? { [K in keyof T]: DeepMocked<T[K]> }
        : T;
