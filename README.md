# Pi Extensions

Personal extensions and configuration for the [Pi AI CLI tool](https://github.com/earendil-works/pi).

## Structure

```
extensions/          # Global extensions loaded by pi
  test-extension.ts  # Simple validation extension
```

## Usage

### Option 1: Use this repo as your agent directory

Point pi at this repository so it loads extensions, skills, and config from here:

```bash
PI_CODING_AGENT_DIR=$(pwd) pi
```

This treats the repo root as `~/.pi/agent/`. Pi will auto-discover extensions from the `extensions/` directory.

### Option 2: Load a specific extension one-off

```bash
pi -e extensions/test-extension.ts
```

### Option 3: Symlink into your existing agent directory

```bash
ln -s $(pwd)/extensions ~/.pi/agent/extensions
```

## Extensions

### test-extension.ts

A minimal extension that registers a `/hello` slash command for validating that pi loads extensions correctly.

Run `/hello` inside pi to see it respond.
