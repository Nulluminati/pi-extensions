/**
 * Shared error predicates.
 *
 * Node syscall errors are plain `Error` instances that carry a `code`. Every
 * module that branches on `ENOENT` versus a real failure uses this guard so
 * the semantics stay identical across the codebase.
 */

/** True when `error` is an Error carrying a syscall `code` (ENOENT, EACCES…). */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
