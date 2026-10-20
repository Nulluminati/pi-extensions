# Agent instructions for pi-extensions

This repository publishes standalone TypeScript extensions for Pi. It is not a Pi agent directory or a dotfiles repository.

## Repository rules

- Do not add external npm dependencies without asking first. Pi loads extensions without a build step.
- Keep one async default-exported entrypoint at `extensions/<name>/<name>.ts`. Put supporting TypeScript files under `src/`.
- Do not use non-null assertions. Import Pi types from the SDK packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`). Put derived types that no public entry exports in `lib/pi-types.ts`.
- Add or update tests in `test/extensions/<name>.test.ts` when extension behavior changes.
- Run `npm run format` before committing. Run `npm run check` for format, lint, typecheck, validation, and tests.

## Task guides

- [Extension development](.pi/skills/extension-development/SKILL.md): naming, state, errors, type declarations, and the create/change workflow.
- [Extension structure](.pi/skills/extension-structure/SKILL.md): entrypoint discovery and multi-file module boundaries.
- [Shared helpers](.pi/skills/shared-helpers/SKILL.md): use `lib/` for common UI, transcript, model, and filesystem patterns.
- [Write tests](.pi/skills/write-tests/SKILL.md): mocks, Pi handlers, tool results, and lifecycle tests.

Use `npm run validate:one -- extensions/<name>/<name>.ts` for a focused validation. Use `pi -e extensions/<name>/<name>.ts` to test an extension live.
