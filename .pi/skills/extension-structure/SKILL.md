---
name: extension-structure
description: Design, create, or refactor Pi extensions in this repository into a consistent multi-file structure. Use whenever an extension is becoming large, a user asks to split or reorganize an extension, files are being added under extensions/, or extension architecture and file placement are under discussion. Keeps one discoverable root entrypoint while placing implementation modules under src/, preserves Pi lifecycle behavior, and validates the migration without changing unrelated extensions.
---

# Extension Structure

Organize Pi extensions so their platform wiring is easy to audit, their implementation has clear ownership, and helper modules are not mistaken for standalone extensions.

## Repository constraint

The package manifest discovers `extensions/*/*.ts`. Every TypeScript file directly inside an extension directory is therefore treated as an extension entrypoint. `findExtensionEntrypoints()` in `lib/validate-extension.ts` mirrors this one-level discovery rule, so `npm run validate` checks entrypoints without treating `src/` modules as extensions.

Keep exactly one root TypeScript file:

```text
extensions/<name>/
├── <name>.ts
├── README.md
└── src/
    ├── <capability>.ts
    └── <other-capability>.ts
```

Do not place helper `.ts` files beside `<name>.ts`. Put them in `src/`. Do not rename the root entrypoint to `index.ts` unless the package manifest, validator workflow, tests, and all consumers are deliberately migrated together.

## Composition root

Use `extensions/<name>/<name>.ts` as the composition root. It should:

1. Export the required default async factory.
2. Create per-instance state.
3. Define only small closure helpers that coordinate that state.
4. Register Pi events, commands, tools, shortcuts, providers, or renderers.
5. Delegate substantial behavior to named modules in `src/`.

Keep Pi registration calls in the composition root instead of hiding all wiring behind a `registerEverything()` helper. This makes the extension's platform surface visible and satisfies the repository validator, which scans the root file for direct Pi API use.

The root entrypoint should answer these questions at a glance:

- What state exists for one Pi instance?
- Which Pi APIs does the extension register?
- Which module handles each capability?
- What happens during startup and shutdown?

## Module boundaries

Split by responsibility and reason to change, not by syntax category or an arbitrary line count.

Prefer capability names such as:

- `state.ts` or a domain name such as `thread.ts` for persistence, reconstruction, validation, and state transitions
- `commands.ts` when command parsing or command behavior is substantial
- `tools.ts` or `<tool-name>.ts` for tool execution and result construction
- `client.ts` or `<service>.ts` for remote API access
- `overlay.ts`, `widget.ts`, or `renderer.ts` for TUI components and rendering
- `agent.ts` or a more specific domain name for direct model loops
- `handoff.ts`, `catalog.ts`, `audio.ts`, and similar names for distinct product capabilities
- `types.ts` only for types shared by multiple modules
- `constants.ts` only for constants shared by multiple modules

Check `lib/` before creating a new `src/` helper — modal frames, key hints, status lines, tool renderers, fuzzy pickers, transcript parsing, small-model resolution, and editor layering already exist there (see the `shared-helpers` skill). Extension `src/` modules import from `lib/`; they never duplicate it. Only patterns reused by two or more extensions belong in `lib/` itself.

Keep a type, constant, and helper in its owning capability module when no other module needs it. Avoid turning `types.ts`, `constants.ts`, or `utils.ts` into dumping grounds.

A module should have one primary reason to change. Split it when it contains multiple independently changing capabilities. Do not split a cohesive implementation merely to make files short.

## Internal module format

Use the same predictable order in each `src/` module:

1. A short module comment when its purpose or constraints are not obvious from the file name.
2. Imports in repository order.
3. Module-owned constants.
4. Module-owned types.
5. Private helpers.
6. Named exports that form the module's public contract.

Keep exports narrow. A reader should find the module's public operations quickly without exposing every helper. Preserve existing comments during a refactor; move them with the behavior they explain.

## Dependency direction

Keep dependencies moving in one direction:

```text
<name>.ts → capability modules → shared domain types and focused pure helpers
```

Follow these rules:

- Internal modules must not import the composition root.
- Avoid barrel files unless they remove real repetition without hiding ownership.
- Avoid circular imports. Move genuinely shared contracts to `types.ts`, or pass callbacks and validated values across the boundary.
- Pass `ExtensionAPI`, contexts, state, and callbacks explicitly rather than storing process-wide mutable state.
- Keep state closure-scoped in the composition root when practical. If several modules operate on it, define the shared shape in `types.ts` and keep mutation paths explicit.
- Keep persistence ownership clear: one capability should define validation, reconstruction, cloning, and persistence for a given state record.
- Keep user-visible errors at the boundary that has `ctx.ui`; lower-level helpers should throw or return typed failures rather than silently swallowing errors.

## Imports and exports

Use explicit `.ts` extensions for relative imports. Order imports according to repository conventions:

1. External runtime or Node.js modules
2. `import type` declarations from `pi`
3. Relative repository and extension modules

Export only symbols needed across a module boundary. Keep implementation details private. Prefer named exports from internal modules so call sites reveal intent.

## Testing strategy

Preserve behavior while changing structure.

1. Run the extension's existing tests before moving code.
2. Add a failing regression test first if behavior is changing or a bug is being fixed.
3. For a structure-only refactor, use the existing behavioral suite as the safety net and add a narrow structure check when the discovery boundary itself matters.
4. Move one cohesive responsibility at a time.
5. Run the focused test after each meaningful move.
6. Keep the public test import pointed at `extensions/<name>/<name>.ts`; this verifies the real composition root.
7. Unit-test an internal module directly only when it has a meaningful standalone contract. Do not export internals solely to make tests convenient.

Keep tests at `test/extensions/<name>.test.ts` by default, matching this repository. Split a very large suite only when the test configuration and conventions are deliberately updated.

## Migration workflow

1. Read `AGENTS.md`, the full target extension, its tests, its README, and every relative dependency it imports.
2. Inspect `package.json`, `lib/validate-extension.ts`, and TypeScript/Biome configuration before choosing paths.
3. Check `git status` and the target diff. Preserve uncommitted work exactly; do not reconstruct from `HEAD`.
4. Inventory responsibilities, state ownership, Pi registrations, lifecycle hooks, and dependency edges.
5. Propose a file map where every file has a clear purpose.
6. Confirm the focused tests and validator pass before the move, or record existing failures.
7. Create `src/` modules from the current working-tree implementation.
8. Reduce the root file to state creation and Pi wiring while keeping direct registration calls visible.
9. Format only the target extension and its tests. Do not run write-mode formatting over unrelated files in a dirty tree.
10. Run focused tests, isolated typechecking when the wider tree has unrelated failures, the single-extension validator, and a package-discovery check.
11. Review `git diff -- <target paths>` to confirm the refactor did not alter behavior or overwrite prior work.

## Validation

Run the checks that apply to the target:

```bash
npm test -- --run test/extensions/<name>.test.ts
npm run validate:one -- extensions/<name>/<name>.ts
npm run validate
npx biome check extensions/<name> test/extensions/<name>.test.ts
```

Also verify that only the entrypoint is matched at the extension root:

```bash
find extensions/<name> -maxdepth 1 -name '*.ts' -print
```

The output should contain only `extensions/<name>/<name>.ts`.

Run `npm run check` when the working tree permits it. If unrelated in-progress work breaks the repository-wide check, do not edit that work. Run the narrowest reliable checks for the target and report the exact external blocker.

## Review checklist

- [ ] One root `.ts` entrypoint matches the package discovery glob.
- [ ] The root default export remains async.
- [ ] Direct Pi registration calls remain visible in the root.
- [ ] Internal implementation files live under `src/`.
- [ ] Each module owns a cohesive capability.
- [ ] Shared files contain only genuinely shared contracts.
- [ ] No module imports the composition root.
- [ ] No circular dependencies were introduced.
- [ ] Per-instance state did not become process-global state.
- [ ] Persistence and lifecycle behavior are unchanged.
- [ ] Existing public imports and command/tool names are unchanged unless requested.
- [ ] Focused tests, formatting, typechecking, and validation pass.
- [ ] No unrelated extension was modified.
