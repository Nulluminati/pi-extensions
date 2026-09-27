# Approval Mode

Approval Mode checks commands the agent sends through `bash`, `background`, and `monitor`. It does not intercept direct `!` commands typed by the user or subprocesses started internally by unrelated extensions.

The gate checks hard denies first. A small list of exact, reviewed read-only forms runs without a network call. Other commands go to TypeSafe Jev. An explicit rejection or uncertain answer opens a warning in the interactive main chat. **Approve once** runs that call only; **Block** or dismissal stops it. Without a user interface, these calls block. A missing key, service error, timeout, cancellation, oversized command, or invalid response also blocks without a prompt.

Hard denies include raw-device writes and formatting, broad recursive deletion of system or workspace roots, forced Git cleanup and hard reset, force updates to protected branches, privilege escalation, and clear transfers of credential files. These checks recognize clear forms, not every possible shell program. Jev evaluates other forms. An oversized command or a command with a recognized credential blocks before the Jev call.

Use `/approval-mode off` to skip Jev review for the rest of the main session. Hard denies still apply. The input bar shows **Approval Mode off** while Jev review is disabled. `/approval-mode on` restores review. New sessions start with review on. Workers cannot disable it.

## Read-only workers

`delegate` with `read_only: true` starts a report-only investigation worker in the current workspace. It has research tools, a read-only workspace sandbox, and the Jev command gate. A rejected or uncertain worker command blocks and appears in its report; workers cannot open approval dialogs. Writable workers keep their existing sandbox and the Jev command gate.

## Configuration

Set `TYPESAFE_API_KEY` in the environment that launches Pi. Approval Mode sends the command, current directory, and up to three recent user requests to TypeSafe. It redacts common credentials and limits request size. Redaction cannot identify every secret. Commands containing a recognized credential block rather than being sent with missing text. Jev uses `jev-latest` with a four-second request limit. This extension uses the TypeSafe HTTP API and adds no package dependency.
