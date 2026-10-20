import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { type Mock, vi } from "vitest";

/**
 * Deeply mock an interface: replace all function properties with Vitest Mock instances.
 *
 * - Function properties become `Mock<T>` of the real signature, so a wrong
 *   argument, return value or replacement mock fails to compile. For a
 *   deliberately partial fake, use `vi.mocked(fn, { partial: true })`.
 * - Constructable types (class instances like `Date`, `AbortSignal`, `Array`) are preserved
 *   to avoid mocking built-in methods that tests may need as real values
 * - `any` types are preserved to avoid infinite recursion
 * - Primitives are preserved as-is, including branded strings such as `string & {}`
 * - Objects recurse (interfaces, plain objects)
 */
// Use `any` in the function constraint so the conditional matches functions
// with specific parameter/return types under TypeScript 6's strict variance
// checks. `unknown` would only match `(...args: unknown[]) => unknown`.
export type DeepMocked<T> = 0 extends 1 & T
  ? T
  : T extends Primitive
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
        ? Mock<T> & T
        : T extends PrivateFieldClass
          ? MockedSdk<T>
          : T extends object
            ? { [K in keyof T]: DeepMocked<T[K]> }
            : T;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * SDK classes with private fields. No object literal satisfies a private field
 * structurally, so a mock context with a plain mocked Theme or ModelRegistry
 * could not be passed where the SDK context type is expected.
 */
type PrivateFieldClass = Theme | ModelRegistry;

/** Mocked public members of a private-field class, also typed as the class. */
export type MockedSdk<T> = { [K in keyof T]: DeepMocked<T[K]> } & T;

/**
 * Type a mock of a private-field class. The literal is checked against the
 * class's public members (a missing or wrong member fails to compile), then
 * asserted as the class.
 */
export function asSdkMock<T extends PrivateFieldClass>(
  mock: {
    [K in keyof T]: DeepMocked<T[K]>;
  },
): MockedSdk<T> {
  return mock as MockedSdk<T>;
}

/**
 * A `vi.fn` typed as the real SDK function `T`, for overloaded or generic
 * methods such as `pi.on`, `registerTool` and `ui.custom`. TypeScript cannot
 * check one implementation against every overload or type parameter, so the
 * implementation is not checked; calls and `.mock` access keep the real type.
 * Prefer a plain `vi.fn` for every other method, which checks the signature.
 */
export function mockFn<T extends AnyFunction>(implementation?: AnyFunction): Mock<T> & T {
  return vi.fn(implementation) as unknown as Mock<T> & T;
}

// biome-ignore lint/suspicious/noExplicitAny: matches any function signature
type AnyFunction = (...args: any[]) => any;
