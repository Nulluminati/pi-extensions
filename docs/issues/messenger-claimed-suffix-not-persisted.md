# Claimed messenger suffix is lost on session resume

- Category: messenger identity / mail durability
- Severity: moderate
- Status: open

## Evidence

`resolveSessionIdentity` in `extensions/messenger/src/session-identity.ts` reads a transcript name or environment override. During `session_start`, `claimIdentity` can add a suffix when another live session holds that name. `extensions/messenger/messenger.ts` uses the suffixed name but never appends it to the session transcript.

For example, a fork resumes with a persisted name `w1` while the original session holds `w1`. The fork claims `w1-2`. After both exit, the fork resumes again. Its transcript still says `w1`, so it claims `w1` if free and stops reading mail and claims under `w1-2`.

## Impact

Unread mail can remain in the old mailbox, and path reservations can expire under the abandoned identity.

## Resolution

Persist the name returned by `claimIdentity` when it differs from the resolved name. On resume, prefer the last claimed name for that session. Test a collision, shutdown, and resume with the original name free.
