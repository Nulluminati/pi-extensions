# bash-allow

Enforce a static command allow list for the `bash`, `background`, and `monitor` tools.
This extension uses no model, prompt judgment, dialog, or network request.
A blocked call returns a reason to the model. It never asks for approval.

## Configuration

1. Load the extension, either through the installed package or with `-e`.
2. Set `--bash-allow` or `PI_BASH_ALLOW` to a comma-separated list.

```bash
pi -e extensions/bash-allow/bash-allow.ts --bash-allow 'pwd:*,gh pr view:*'
PI_BASH_ALLOW='pwd:*,gh pr view:*' pi -e extensions/bash-allow/bash-allow.ts
```

The flag takes priority over the environment variable.
Pi applies flags after extension loading, so this extension reads configuration at `session_start`.

An unset list leaves all commands unrestricted.
An explicitly empty list or malformed list blocks every shell call.
An interactive session also shows an error notification for a malformed list.

## Shell requirements

With an allow list, Pi must use its default shell or a `shellPath` named `bash` or `sh`.
Windows names `bash.exe` and `sh.exe` also work.
The configured path must point to a trusted, genuine Bash or compatible sh interpreter, not a wrapper or another shell.
The scanner does not support fish or zsh quoting rules.

An unsupported `shellPath` blocks all three shell tools and produces an error notification when a user interface is available.
The extension checks settings at session start and before each shell call.
After a startup shell error, configure a supported shell and restart Pi.
Without an allow list, the extension leaves shell selection unrestricted.

## Patterns

Both forms work:

```text
hunk session:*,gh pr view:*
Bash(hunk session:*),Bash(gh pr view:*)
```

A trailing `*`, with or without the preceding colon, allows additional arguments.
Without `*`, a rule requires exactly the listed argument tokens.
A middle `*` is an error. A bare `*` is not a valid command prefix.
Commas inside quotes belong to the argument, not the list separator.

Matching uses complete tokens, not a raw text prefix.
For example, `gh pr view:*` allows `gh pr view 7 --repo a/b`, but refuses `gh pr viewx`.
Quoted and escaped literal tokens match their shell values.

## Command checks

The scanner splits unquoted `;`, newlines, `&&`, `||`, and `|` into command segments.
Every segment must match a rule. Quoted or escaped separators remain literal arguments.
For example, `hunk session:*` does not allow `hunk session list; rm -rf ~`.

Before matching, the extension refuses these forms:

- Subshells and command groups: `( … )` and `{ …; }`.
- Background execution: `&`.
- Command substitution: `$( … )` and backticks.
- Unquoted or double-quoted `$` expansion, including `$VAR` and `${VAR}`.
- All redirection: `>`, `>>`, `<`, `<<`, `<<<`, `2>`, `&>`, and related forms.
- Shell comments (`#` at an unquoted token boundary), which can hide quotes and change newline interpretation.
- Unclosed quotes, incomplete escapes, and NUL characters.

Single quotes protect literal expansion characters. Escapes can also protect literal characters.
Operators inside quotes do not act as shell operators.

The interface accepts Claude Code's `Bash(prefix:*)` pattern form, but not its complete permission language.
There is no approval path, similar to the intended unattended use of Claude Code's `--permission-mode dontAsk`.
This extension refuses all redirection, including input redirection and output to `/dev/null`.

## Background inputs

With an allow list, `background` must use the inherited environment and the session working directory.
The extension blocks every non-empty `env` override and every explicit `cwd` override, including `cwd: "."`.
An empty `env: {}` is allowed because it changes no environment variables.
These checks run before command matching.

Environment overrides can change executable lookup or make an allowed command launch another program.
For example, `GH_BROWSER` can make `gh pr view --web` execute an unlisted program.
Directory overrides can change executable lookup and command configuration.
Without an allow list, these inputs stay unrestricted.

The launcher must provide a trusted inherited environment and working directory.
The extension does not remove inherited variables or validate installed executables and command configuration.

## Herdboard reviewer example

```bash
pi -e extensions/bash-allow/bash-allow.ts \
  --tools read,grep,find,ls,bash \
  --bash-allow 'Bash(hunk session:*),Bash(hunk skill path:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*)'
```

The reviewer can run `gh pr diff 7 | gh pr view 7` because both segments match.
It cannot run `gh pr diff 7 | cat` because `cat` is absent from the list.
Herdboard integration belongs to card `t6wd`; this extension does not change its launcher.

## Scope and limitations

This extension handles `tool_call` events only. User commands entered with `!` stay unrestricted.
It gates `background` and `monitor` only when those tools exist.
It does not change worker extension lists. Workers keep their existing approval and sandbox controls.

This is a text matcher, not a complete shell parser or an operating-system sandbox.
Unsupported forms can be refused even when they would be safe.
It provides no shell-language support for environment prefixes, heredocs, or glob expansion semantics.
An allow rule for an interpreter, `xargs`, or another command launcher can permit arbitrary execution through its arguments.
Only allow commands whose arguments you trust.

The allow list limits command names and argument prefixes, not command capabilities.
For example, `gh pr view` can access private repositories with the session's credentials.
This extension does not limit files, network access, other tool names, or code executed directly by another extension.
Use `--tools` to limit exposed tools and `worker-sandbox` for filesystem and network isolation.

`approval-mode` remains independent. A call that passes this list can still reach its model check or approval dialog.
Handler load order does not guarantee that this extension runs first.
An unattended reviewer must exclude `approval-mode` if its approval dialog could wait for input.

If this extension is missing, Pi rejects `--bash-allow` as an unknown option before the session starts.
Callers that require enforcement must pass the flag; an environment variable alone cannot detect a missing extension.

## Live check

1. Run `PI_BASH_ALLOW='pwd:*' pi -e extensions/bash-allow/bash-allow.ts`.
2. Ask the model to run `pwd`.
3. Ask the model to run `ls` and confirm that the tool returns a blocked reason.
4. Enter `!ls` and confirm that the user command still runs.
5. Start without the flag or variable and confirm that model shell calls are unrestricted.
6. Set `PI_BASH_ALLOW='a:*'` with `--bash-allow 'b:*'` and confirm that only `b` matches.
