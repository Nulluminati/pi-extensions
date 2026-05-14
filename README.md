# Pi Extensions

Personal extensions for the [Pi AI CLI tool](https://github.com/earendil-works/pi).

## Structure

```
extensions/          # Global extensions loaded by pi
  test-extension.ts  # Simple validation extension
```

## Installation

Symlink or copy this directory into `~/.pi/agent/`:

```bash
ln -s $(pwd)/extensions ~/.pi/agent/extensions
```

Or run pi pointing directly at this repo:

```bash
pi -e extensions/test-extension.ts
```

## Extensions

### test-extension.ts

A minimal extension that registers a `/hello` slash command for validating that pi loads extensions correctly.
