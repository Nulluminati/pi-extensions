# Plan-mode bash allowlist permits execution-capable flags

- Category: bug (security)
- Severity: high
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

The plan-mode read-only bash gate (`extensions/plan/src/enforcement.ts`) validates arguments per command, but several allowed forms run programs or write files:

- `sort --compress-program=./evil input` runs `./evil` as the compressor. The `sort` spec denies only output flags.
- `git ls-remote --upload-pack=./evil .` runs `./evil` as the pack helper. The generic git spec denies only `--output`.
- `fd -xnode payload` and `fd -Xtouch payload` treat their attached values as commands. The gate accepts them because both the regex and exact flag denial expect separate `-x` or `-X` tokens. In scratch tests, Node ran `payload.js` and `touch` changed a file's modification time.
- `sort -ooutput.txt input.txt` attaches a filename to `-o`. It passes the gate and writes `output.txt` in a scratch directory.

All forms return `true` from `isSafeBashCommand`. The first two program-execution forms were verified in the earlier review; the attached `fd` form was verified in this pass.

## Impact

Plan mode can execute repository scripts or write files despite its read-only contract. Both missing flag allowlists and attached short-option values contribute to the bypass.

## Resolution direction

Replace permissive flag specs with positive allowlists for commands that can execute programs or write files. Parse attached short-option values as their underlying flag before validation. Test each execution or output flag in both separated and attached forms.
