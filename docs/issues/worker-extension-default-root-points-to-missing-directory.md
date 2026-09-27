# Default worker extension root points to a missing directory

- Category: worker code quality
- Severity: low
- Status: open

## Evidence

`defaultExtensionsRoot()` in `extensions/agents/src/worker-extensions.ts` resolves `../extensions/` from `extensions/agents/src/`. That path is `extensions/agents/extensions/`, which does not exist. `resolveWorkerExtensions()` fails to find even mandatory extensions when a caller omits `extensionsRoot`.

The current delegate passes an explicit root, so normal worker launches still work. The exported helper's default does not.

## Resolution

Resolve the repository's `extensions/` directory from this module, or require callers to supply a root. Add a test that calls `resolveWorkerExtensions()` without options and checks its entrypoint paths.
