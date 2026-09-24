# Malformed mailbox lines are silently hidden

- Category: bug (data integrity)
- Severity: lower
- Found during: PR #33 second-round review, 2026-09-21
- Status: resolved — `readInbox` and `markRead` now move malformed lines byte-for-byte into a sibling `<mailbox>.quarantine` file under the mailbox lock, and `readInbox` returns `{ unread, quarantined }` so the count is visible to callers.

## Evidence

`readInbox` (`extensions/messenger/src/store.ts:243-250`) skips lines that fail `JSON.parse`:

```ts
} catch {
  // Skip malformed lines rather than failing the whole mailbox.
}
```

`markRead` preserves those same lines forever (`store.ts:277-278`), so the junk is never compacted away either.

## Impact

A corrupted line makes the mailbox file and the unread count disagree: delivery and counts silently omit the damaged entry, and the corruption is invisible until someone reads the raw file. This sits oddly next to the fail-closed policy the same module applies everywhere else (unreadable mailboxes, corrupt reservations, corrupt shards all throw).

## Resolution direction

Table row 19's open decision: quarantine malformed lines into a sibling file (delivery continues, corruption is visible), report them alongside valid messages, or fail closed. Quarantine best matches the module's existing policy.
