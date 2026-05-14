# Pi Extensions

Personal extensions for the [Pi AI CLI tool](https://github.com/earendil-works/pi).

## Structure

```
extensions/              # All pi extensions
  test-extension.ts    # Validation baseline — always present
  time-tool.ts        # Example: LLM-callable tool
  _template.ts        # Starter template for new extensions
test/
  validate.ts         # Validate a single extension
  validate-all.ts   # Validate all extensions
.claude/
  AGENTS.md         # Agent instructions for this repo
  settings.json     # Claude Code project config
CLAUDE.md           # Project documentation
package.json        # Bun project metadata
```

## Usage

### Option 1: Use this repo as your agent directory

```bash
PI_CODING_AGENT_DIR=$(pwd) pi
```

Treats the repo root as `~/.pi/agent/`. Pi auto-discovers all extensions from `extensions/`.

### Option 2: Load one extension for testing

```bash
pi -e extensions/<name>.ts
```

### Option 3: Symlink into your existing agent directory

```bash
ln -s $(pwd)/extensions ~/.pi/agent/extensions
```

## Development workflow

### Creating a new extension

1. Copy `extensions/_template.ts` to `extensions/<descriptive-name>.ts`
2. Implement your extension
3. Validate: `bun test/validate.ts extensions/<name>.ts`
4. Test live: `pi -e extensions/<name>.ts`
5. Use `/reload` inside pi to hot-reload changes without restarting
6. Commit

### Before committing

Run the full validation suite:

```bash
bun run validate
```

This checks all extensions for:
- Valid TypeScript syntax
- Required default export (async function)
- No undeclared npm imports
- At least one pi API call (`registerTool`, `registerCommand`, `on`, or `appendEntry`)

## Extensions

### test-extension.ts

Minimal validation extension. Registers a `/hello` slash command. Always present as a baseline.

### time-tool.ts

Example of an LLM-callable tool. Registers `getCurrentTime` with configurable timezone and format.

### _template.ts

Starter template for new extensions. Uncomment and fill in the relevant sections. Will fail validation until implemented (by design).

## Rules

- **No external npm dependencies** without explicit justification. Pi transpiles extensions directly.
- **Never commit `auth.json`, `settings.json`, or `sessions/`** — these are in `.gitignore`.
- **One responsibility per file.** A focused extension is easier to test and maintain.
- **Test interactively** with `pi -e` before committing.
