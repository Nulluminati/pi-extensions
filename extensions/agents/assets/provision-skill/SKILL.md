---
name: provision
description: Author or repair the per-repo worktree provision config (.pi/provision.json). Route here when a delegate result carries a pointer line about a missing, stale, or failed provision config, or when a worker reports an environmental blocker (missing dependencies, wrong-platform binaries, dead tooling) instead of doing its task. Guides you to amend the config, re-delegate, and let the mechanism carry, share, and provision the worktree — workers never author config themselves.
metadata:
  provision-skill-version: 2
---

# Worktree Provisioning

## Purpose

Fresh git worktrees carry tracked files only; `node_modules`, `.env`, and every other gitignored path stay behind. A worker spawned into such a worktree burns its whole budget reinstalling, or fails on binaries built for the wrong libc. This skill tells you how to write the fix as policy in one committed config file, so the mechanism reproduces a working environment in every worktree without you running its steps.

## Config: `.pi/provision.json`

Write or amend this committed file. One repo, one config. Fields:

- `carry` — gitignored paths copied from the parent checkout into each new worktree, for example `[".env"]`.
- `detect` — paths that must exist for the config to apply, for example `{"any": ["package.json"]}`; omit for always applies.
- `provision` — command run inside the provision sandbox, for example `"npm install --no-audit --no-fund"`; omit for no command.
- `share` — how dependency trees reach the worktree: `hardlink-copy`, `install`, or `none`. Omitted: no share step runs — the provision command (if set) builds the environment, otherwise nothing does.
- `network` — hosts the sandbox may reach, for example `["registry.npmjs.org", "*.npmjs.org"]`; unlisted hosts get a policy 403.
- `timeoutSeconds` — command budget. Default: 120 — right for warm caches and fast links. Cold installs over slow sandbox links need 600–3600.
- `providesOwn` — set `true` when the command builds the whole environment; share defaults do not run.

## Mechanism order: carry → share → provision

The mechanism applies three primitives in this order after it creates a worktree:

1. **carry** copies each `carry` path from the parent checkout. Secret-shaped paths (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`) are refused by default.
2. **share** populates dependency directories host-side. `hardlink-copy` is the pure-JS fast path — seconds, near-zero added bytes. `install` runs the package manager host-side. `none` does nothing. Workers run in a musl-Linux guest; the host tree's native binaries are glibc. A pure-JS tree survives a hardlink copy, but native tooling (esbuild bindings, biome) only comes from running the install inside the provision VM, which is musl-correct by construction.
3. **provision** runs the command in a throwaway VM mounted only to the worktree. The parent's `node_modules` is unreachable, so the install is real. Cache homes redirect to a persistent host directory, so discarding a worktree costs no re-download.

## Reading a failure

A failed provision's pointer line carries the exit code, the output tail, and the exact log path. Provision command logs land under the persistent cache dir: for npm, `~/.cache/pi-provision/npm/_logs`. Read them before touching the config — the fix may be network, memory, or timeout, not config shape. An empty output tail with exit 137 means the sandbox ran out of memory.

## Rules

- You author the config. The mechanism executes it and commits your edits host-side with a path-limited commit, announced in the UI. Never run the provisioning steps yourself.
- The config is committed only after a successful provision; interim edits stay uncommitted until one lands.
- `carryUnsafe` belongs only in `.pi/provision.local.json` (git-excluded, machine-local). It is a named validation error in the committed config.
- Secret-shaped paths are never carried by default. The local override is the only opt-in.
- Workers never author config. A worker's blocker text is evidence for you, not a patch to paste.
- `detect` lists plain project-relative paths. No globs.
- Set `network` to only the hosts the command needs.
- `isolate: false` workers share the parent environment and skip provisioning — they can still hit the same platform walls. Prefer isolated delegates for implementation work.

## Examples

### npm (worked example)

```json
{
  "detect": { "any": ["package.json"] },
  "carry": [".npmrc"],
  "share": "hardlink-copy",
  "provision": "npm install --no-audit --no-fund",
  "network": ["registry.npmjs.org", "*.npmjs.org", "*.npmjs.com", "github.com"],
  "timeoutSeconds": 3600
}
```

Proven live: the hardlink copy keeps the reify delta small, the incremental install adds the musl-native binaries the copy cannot carry, and memory stays low. `github.com` in `network` covers postinstall downloads. Warning: a cold `npm ci` extraction has been SIGKILLed (exit 137, sandbox OOM) — prefer the incremental install.

### python (uv)

```json
{
  "detect": { "any": ["pyproject.toml", "uv.lock"] },
  "provision": "uv sync",
  "network": ["pypi.org", "files.pythonhosted.org"]
}
```

### rust (cargo)

```json
{
  "detect": { "any": ["Cargo.toml"] },
  "provision": "cargo fetch",
  "network": ["crates.io", "static.crates.io", "index.crates.io"]
}
```

`cargo fetch` fills the shared cache. `target/` stays per-worktree and rebuilds locally.

### elixir (mix)

```json
{
  "detect": { "any": ["mix.exs"] },
  "provision": "mix deps.get",
  "network": ["repo.hex.pm", "hex.pm"]
}
```

### monorepo script

```json
{
  "detect": { "any": ["scripts/setup-worktree.sh"] },
  "provision": "./scripts/setup-worktree.sh",
  "network": ["registry.npmjs.org"],
  "providesOwn": true
}
```

The repo owns its setup end to end. The mechanism runs only carry and the command.

## Recovery flow

1. A delegate response carries a pointer line that names the provision problem, or a worker wakes with an environmental blocker.
2. Read the blocker as evidence. Decide the config change: add a `detect` path, fix a command, widen `network`, add a `carry` path.
3. Edit `.pi/provision.json`. Use `.pi/provision.local.json` only for secret opt-ins.
4. Re-delegate. The mechanism provisions, commits your config edit, and returns a fresh pointer line.
5. Retry once. A second failure is loud: report the blocker and stop. Do not loop.
