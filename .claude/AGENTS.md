# Agent Instructions for pi-extensions

## Context

This repo contains TypeScript extensions for the Pi AI CLI tool. Extensions hook into pi's lifecycle to add custom tools, slash commands, and behaviors.

## When working in this repo

### Creating a new extension

1. Copy `extensions/_template.ts` to `extensions/<descriptive-name>.ts`
2. Fill in the implementation
3. Run the validator: `bun test/validate.ts extensions/<name>.ts`
4. Test live: `pi -e extensions/<name>.ts`
5. Add a section to `CLAUDE.md` describing what the extension does
6. Commit

### Modifying an existing extension

1. Edit the `.ts` file
2. Run the validator
3. Test live with `pi -e`
4. Commit

### Rules

- Do not add external npm dependencies without asking first
- Never remove the test-extension.ts (it's the validation baseline)
- Keep extensions stateless where possible; use `pi.appendEntry()` for persistence if needed
- Extensions must export a default async function

## Testing workflow

The preferred way to test extensions as you code them:

```bash
# In one terminal: run pi with the extension
pi -e extensions/<name>.ts

# In another terminal: edit the file
# Use /reload inside pi to hot-reload changes
```

For automated validation before committing:

```bash
bun test/validate.ts extensions/<name>.ts
```

## Pi API reference

Common patterns:

**Register a tool** (callable by the LLM):
```typescript
pi.registerTool("myTool", {
  description: "What this tool does",
  parameters: { /* JSON schema */ },
  async run(params) {
    // Do work
    return { result: "..." };
  },
});
```

**Register a slash command** (user-triggered via `/command`):
```typescript
pi.registerCommand("myCommand", {
  description: "What this command does",
  async run() {
    pi.appendEntry({
      role: "assistant",
      content: "Response here",
    });
  },
});
```

**Hook lifecycle events**:
```typescript
pi.on("beforeToolCall", async (toolCall) => {
  // Intercept or modify tool calls
});
```
