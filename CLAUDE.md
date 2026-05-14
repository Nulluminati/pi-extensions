# Pi Extensions

A personal extension repository for the [Pi AI CLI tool](https://github.com/earendil-works/pi).

## WHY

Pi extensions are TypeScript modules that hook into pi's lifecycle to add custom tools, slash commands, and behaviors. This repo centralizes all extensions so they can be version-controlled, tested, and deployed consistently across machines.

## WHAT

```
extensions/                  # All pi extensions live here
  test-extension.ts        # Minimal validation extension
  _template.ts             # Starter template for new extensions
test/                      # Extension test infrastructure
  validate.ts              # TypeScript validation script
.claude/                   # Claude Code project configuration
  AGENTS.md                # Agent instructions for this repo
  skills/                  # Project-specific skills
```

## HOW

### Extension basics

Extensions are TypeScript files that export a default async function receiving a `pi` object:

```typescript
export default async function (pi: any) {
  // Register tools, commands, or hooks here
}
```

Pi auto-discovers extensions from `~/.pi/agent/extensions/` (or from `extensions/` in this repo when using `PI_CODING_AGENT_DIR`).

### Key APIs

| API | Purpose |
|-----|---------|
| `pi.registerTool(name, definition)` | Register an LLM-callable tool |
| `pi.registerCommand(name, definition)` | Register a `/slash` command |
| `pi.appendEntry(entry)` | Add a message to the conversation |
| `pi.on(event, handler)` | Hook into lifecycle events |

### Creating a new extension

1. Copy `_template.ts` to `extensions/my-extension.ts`
2. Implement your extension logic
3. Validate with `bun test/validate.ts extensions/my-extension.ts`
4. Test live with `pi -e extensions/my-extension.ts`
5. Commit when working

### Running extensions

**Option 1: Use this repo as your agent directory**

```bash
PI_CODING_AGENT_DIR=$(pwd) pi
```

**Option 2: Load one extension for testing**

```bash
pi -e extensions/my-extension.ts
```

**Option 3: Symlink into your existing agent directory**

```bash
ln -s $(pwd)/extensions ~/.pi/agent/extensions
```

### Validation

Before committing any extension, run the validator:

```bash
bun test/validate.ts extensions/<name>.ts
```

This checks:
- Valid TypeScript syntax
- Required default export
- No undeclared dependencies
- Pi API usage looks reasonable

### Rules

- **No external npm dependencies** without explicit justification. Pi runs extensions directly via tsx/esbuild — if you need deps, add a `package.json` in `extensions/` and document why.
- **Never commit `auth.json`, `settings.json`, or `sessions/`**. These are in `.gitignore`.
- **Keep extensions focused**: one responsibility per file. A tool that does one thing is easier to test and maintain.
- **Name files descriptively**: `git-commit-helper.ts`, not `ext3.ts`.
- **Test interactively** with `pi -e` before committing. The `/reload` command hot-reloads extensions without restarting pi.
