# Case-variant paths bypass messenger reservations

- Category: messenger coordination / platform safety
- Severity: moderate
- Status: open

## Evidence

`normalizePathPrefix` in `extensions/messenger/src/store.ts` normalizes separators but preserves case. Reservation overlap and edit blocking compare the resulting strings exactly. On a case-insensitive volume, `docs` and `Docs` refer to the same directory but become different reservation keys.

## Impact

Two sessions can reserve different spellings of one path and both edit the same files. Messenger reports no conflict, so its coordination guarantee fails on common macOS and Windows filesystems.

## Resolution

Normalize comparisons according to the actual filesystem's case behavior, not only the operating system. Compare existing stored keys through the same rule. Test case variants on a case-insensitive fixture or inject the filesystem policy into the matcher.
