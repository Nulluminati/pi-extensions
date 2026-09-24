# Plan-mode bash allowlist permits execution-capable flags on sort and git ls-remote

- Category: bug (security)
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

The plan-mode read-only bash gate (`extensions/plan/src/enforcement.ts`) validates arguments per command, but two allowed forms execute arbitrary programs:

- `sort` denies only `-o`/`--output` (line 602). `sort --compress-program=./evil input` runs `./evil` as the compressor. Verified: a scratch script passed the gate and created its marker file.
- `git ls-remote` is on the read-only subcommand list (line 288) and the generic git spec denies only `--output` (lines 238-242). `git ls-remote --upload-pack=./evil .` runs `./evil` as the pack helper. Verified the same way.

Both return `true` from `isSafeBashCommand`.

## Impact

Arbitrary command execution from inside plan mode — the mode whose contract is "read-only." The same deny-flags-not-allow-flags shape may hide more cases in other permitted commands; these two are the verified instances.

## Resolution direction

For any command with an execution-capable flag, replace denylist entries with a positive allowlist of safe flags, or drop the command from the plan-mode set. A test enumerating execution-capable flags per permitted command would keep this class closed.
