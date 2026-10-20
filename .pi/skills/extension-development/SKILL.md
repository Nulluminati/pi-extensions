---
name: extension-development
description: Build or change a Pi extension in this repository. Use for new extensions and edits to existing tools, commands, providers, event handlers, state, or type declarations. Covers the local entrypoint conventions, error handling, persistence choices, and validation workflow; use extension-structure for multi-file architecture and write-tests for test design.
---

# Extension development

Pi discovers `extensions/*/*.ts` as entrypoints. Keep one root TypeScript file per extension and put implementation modules under `src/`. Read the [extension-structure skill](../extension-structure/SKILL.md) when choosing module boundaries or moving files.

## Workflow

For a new extension:

1. Create `extensions/<name>/<name>.ts` with an async default export. Put substantial implementation in `src/`.
2. Add `test/extensions/<name>.test.ts`. Follow the [write-tests skill](../write-tests/SKILL.md).
3. Add a row to the root `README.md` Extensions table and describe the extension in `extensions/<name>/README.md`.
4. Run `npm run validate:one -- extensions/<name>/<name>.ts` and test with `pi -e extensions/<name>/<name>.ts`.
5. Run `npm run check` before committing.

For a change, preserve the existing lifecycle and comments. Update tests if behavior changes, then run the focused validator, a live test when applicable, and `npm run check`.

## Root file conventions

Keep the root file easy to scan. Use the existing `// --- Name ---` section comments in this order where needed: imports, constants, types, helpers, extension. A small extension may need only `// --- Extension ---` before the default export. Register Pi APIs in the root file so the validator can see them.

Order imports as follows:

1. Runtime and Node.js modules
2. `import type` declarations from `pi`
3. Relative modules, with explicit `.ts` extensions

Use `UPPER_SNAKE_CASE` for constants, `PascalCase` for types, and `camelCase` for functions. Use kebab-case for file names, widget keys, and custom entry types. Namespace related slash commands with a colon, such as `/goal:pause`; keep an existing command's public name during maintenance.

## Errors and UI

- Check empty arguments, missing models, missing credentials, and unavailable UI before doing work.
- Guard TUI-only command handlers at the top with `if (!ctx.hasUI) return;`. Do not send fallback console output in `rpc`, `json`, or `print` mode. The `/context` command is an explicit exception: it sends a plain-text `context` message with `triggerTurn: false` outside TUI mode. Its hidden renderer prevents stale breakdowns on reload; keep its non-TUI tests.
- Show user-facing failures with `ctx.ui.notify(message, "error")`. Propagate lower-level failures instead of swallowing them.
- In an async `ui.custom` factory, pass a failure message to `done()` so the dialog does not hang.
- Do not use non-null assertions. Pass validated values to helpers or handle missing values explicitly.

## State and storage

Choose the shortest-lived state that satisfies the behavior:

- Keep state inside one command handler when possible.
- Use closure-scoped state in the async extension export for transient state shared across handlers. Clear it on session lifecycle events when required. Avoid module-level `let`, which leaks across Pi instances and tests.
- Use `pi.appendEntry` when state belongs to the session transcript. Restore it from `ctx.sessionManager.getBranch()` on `session_start`; consider branch switches and reloads.
- Use a disk file when state must outlive a session but does not belong in the transcript. Read the [shared-helpers skill](../shared-helpers/SKILL.md) for `lib/paths.ts`, atomic writes, locks, and git excludes. Never hardcode the agent directory or write data inside its `extensions/` discovery directory.

## Pi types

Import Pi types from the package that exports them: extension API types from `@earendil-works/pi-coding-agent`, model and message types from `@earendil-works/pi-ai`, `ThinkingLevel` from `@earendil-works/pi-agent-core`, and TUI types from `@earendil-works/pi-tui`. Import `completeSimple` and `stream` from `@earendil-works/pi-ai/compat`; the root `pi-ai` entry does not export them outside Pi.

When a type exists only inside a package (no public entry exports it), derive it from public types in `lib/pi-types.ts`. Do not import from deep `dist/` paths and do not copy SDK declarations.

Fix extension code to match the SDK types. Use a cast only where the SDK type is wrong for the runtime, and add a comment that says why. For tool `structuredContent`, pass plain data through `asStructuredContent` from `lib/structured-content.ts`.

## Validation

```bash
npm run validate:one -- extensions/<name>/<name>.ts
npm test -- --run test/extensions/<name>.test.ts
npm run check
```

`npm run check:ci` performs the same checks without write-mode formatting. Run `npm run format` before a commit. For a live extension check, start `pi -e extensions/<name>/<name>.ts` and use `/reload` after edits.
