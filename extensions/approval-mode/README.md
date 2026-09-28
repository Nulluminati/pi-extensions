# Approval Mode

Approval Mode checks commands the agent sends through `bash`, `background`, and `monitor`. It does not intercept direct `!` commands typed by the user or subprocesses started internally by unrelated extensions.

The gate checks hard denies first. Exact `pwd`, limited `ls`, and plain `git status` forms run without a network call. Other commands go to TypeSafe Jev for a risk judgment, whether or not they match the recent conversation. Low-risk project work runs without a prompt. Jev escalates serious damage, secret exposure, and changes outside the project. Git may run helpers from local configuration; Approval Mode does not sandbox the main session. A rejection or uncertain answer opens a framed confirmation in the terminal. Page Up and Page Down reveal long commands; approval stays unavailable until the last line is visible. The default choice is **Block**. Remote procedure call (RPC) clients use Pi's native selector. **Approve once** runs that call only; **Block** or dismissal stops it. Without a user interface, these calls block. A missing key, service error, timeout, cancellation, oversized command, or invalid response also blocks without a prompt.

Hard denies include raw-device writes and formatting, broad recursive deletion of system or workspace roots, forced Git cleanup and hard reset, force updates to protected branches, privilege escalation, and clear transfers of credential files. These checks recognize clear forms, not every possible shell program. Jev evaluates other forms. When review is on, commands with recognized executable helper options require confirmation even when Jev reports low risk. An oversized command or a command with a recognized credential blocks before the Jev call.

Use `/approval-mode off` to skip Jev review for the rest of the main session. Hard denies still apply. The input bar shows **Approval Mode off** while Jev review is disabled. `/approval-mode on` restores review. New sessions start with review on. Workers cannot disable it.

## Read-only workers

`delegate` with `read_only: true` starts a report-only investigation worker in the current workspace. It has research tools, a read-only workspace sandbox, and the Jev command gate. A rejected or uncertain worker command blocks and appears in its report; workers cannot open approval dialogs. Writable workers keep their existing sandbox and the Jev command gate.

## Configuration

Set `TYPESAFEAI_API_KEY` in the environment that launches Pi. If the key is missing, Pi warns at session startup. Commands that need Jev still block; the warning does not disable the gate. Approval Mode sends the complete command and current directory to TypeSafe, but it does not send conversation text. It detects common credentials and limits request size. Detection cannot identify every secret. Commands containing a recognized credential block rather than being sent with missing text. Jev uses `jev-latest` with a four-second request limit. This extension uses the TypeSafe HTTP API and adds no package dependency.

## Live calibration

Run `node --import tsx scripts/evaluate-approval-mode.ts` from the repository root with `TYPESAFEAI_API_KEY` set. The script sends synthetic command strings to Jev and checks exact fast-path forms locally. Synthetic requests label cases but do not go to Jev. It never runs those commands. It fails if a routine command does not get approval or a risky command gets automatic approval. This opt-in check makes network requests and is not part of `npm run check`. Repeat it to look for score changes; one passing run does not prove safety.
