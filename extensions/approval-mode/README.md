# Approval Mode

Approval Mode checks commands the agent sends through `bash`, `background`, and `monitor`. It does not intercept direct `!` commands typed by the user or subprocesses started internally by unrelated extensions.

The gate checks hard denies first. Exact `pwd`, limited `ls`, and plain `git status` forms run without a network call. Other commands go to TypeSafe Jev for a risk judgment, whether or not they match the recent conversation. Low-risk project work runs without a prompt; this includes pushing commits, opening or commenting on pull requests, publishing releases, writing to temporary, scratch, or cache locations such as `/tmp`, running local scripts, reading named environment variables that are not credentials, and workflow tools that update their own state, such as herdboard cards or herdr sessions, panes, and plugins. Jev escalates serious damage, secret exposure, and persistent writes outside the project on this machine, such as home dotfiles, `~/.ssh`, system directories, or web roots. Git may run helpers from local configuration; Approval Mode does not sandbox the main session. A rejection or uncertain answer opens a framed confirmation in the terminal. Page Up and Page Down reveal long commands; approval stays unavailable until the last line is visible. The default choice is **Block**. The dialog uses a selection list instead of `confirmModal` so Enter cannot approve by default. Remote procedure call (RPC) clients use Pi's native selector. **Approve once** runs that call only; **Block** or dismissal stops it. Without a user interface in the owning parent session, these calls block. A missing key, service error, timeout, cancellation, oversized command, or invalid response also blocks without a prompt.

Hard denies include raw-device writes and formatting, broad recursive deletion of system or workspace roots, forced Git cleanup and hard reset, force updates to protected branches, privilege escalation, and clear transfers of credential files. These checks recognize clear forms, not every possible shell program. Jev evaluates other forms. When review is on, commands with recognized executable helper options require confirmation even when Jev reports low risk. An oversized command or a command with a recognized credential blocks before the Jev call.

Use `/approval-mode off` to skip Jev review for this session and its workers. Changes affect running workers before their next reviewed command. Hard denies, read-only restrictions, and filesystem sandbox limits remain active. The input bar shows **Approval Mode off** while Jev review is disabled. `/approval-mode on` restores review for the parent and workers. New sessions start with review on. Workers cannot change the mode themselves.

## Worker approvals

Workers use a dedicated communication pipe to request the parent's current mode and send flagged commands for approval. The runner keeps task output in its existing files. Approval requests do not enter the main model's conversation.

The parent shows the existing dialog with the worker name, identifier, working directory, tool, command, and Jev reason. Parent and worker requests share one dialog queue. **Approve once** releases only the pending worker call. The command still runs inside its worker sandbox. **Block** or dismissal returns a blocked tool result to the worker.

A cancelled request, lost connection, or approval wait longer than five minutes blocks the call. The worker's hard timeout still applies. Turning review off closes active dialogs and skips their Jev approval requirement, unless the request was cancelled. Hard denies and classifier failures never offer approval.

Workers without a parent channel keep local review on and block flagged commands. A disconnected channel blocks commands that need review, even if the worker last saw review off. A resumed session can watch an orphan worker, but it cannot reconnect the original approval pipe. Start another worker if that worker needs approvals.

## Read-only workers

`spawn_worker` with `read_only: true` starts a report-only investigation worker in the current workspace. It has research tools, a read-only workspace sandbox, and the shared approval mode. Rejected or uncertain commands request approval through the parent. Workers never open local approval dialogs. Turning review off does not permit edit tools or detached commands. Writable workers keep their existing sandbox and follow the same parent approval mode.

The worker runner passes `--worker-readonly` to Pi for read-only workers. Approval Mode reads this boolean flag at session start (or `PI_WORKER_READONLY=1`) only when `PI_WORKER=1`. It limits active tools to the research allowlist, blocks other tool calls, and blocks detached `background` and `monitor` commands. The flag does not create the read-only sandbox; `worker-sandbox` enforces filesystem restrictions separately. The flag has no effect in a main session.

## Configuration

The judge runs a Jev classifier through Pi's model registry. Set `TYPESAFE_API_KEY` in the environment that launches Pi, or use an inherited Jev entry on another provider (`OPENROUTER_API_KEY`, `CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_API_KEY`, or `OPENCODE_API_KEY`). Pi picks the first classifier with working credentials: hosted Jev first, in a fixed provider order, then any other available classifier. If no classifier is available, Pi warns at session startup and commands that need review block; the warning does not disable the gate. Approval Mode sends the complete command and current directory to the classifier, but it does not send conversation text. It detects common credentials and limits request size. Detection cannot identify every secret. Commands containing a recognized credential block rather than being sent with missing text. Each classifier attempt uses a four-second request limit with two retries. This extension adds no package dependency.

## Live calibration

Run `node --import tsx scripts/evaluate-approval-mode.ts` from the repository root with `TYPESAFE_API_KEY` set. The script sends synthetic command strings to Jev and checks exact fast-path forms locally. Synthetic requests label cases but do not go to Jev. It never runs those commands. It fails if a routine command does not get approval or a risky command gets automatic approval. This opt-in check makes network requests and is not part of `npm run check`. Repeat it to look for score changes; one passing run does not prove safety.
