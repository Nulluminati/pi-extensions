# Approval Mode executable-helper coverage

- Status: open for further review
- First-pass work: [PR #33 merge-gate progress](pr-33-merge-gates-progress.md)

A low-risk Jev score can approve a command that delegates execution to another program through an option. The fixed first pass identifies the known `fd --exec`, `fd --exec-batch`, `find -exec`, `find -execdir`, `git -c core.pager`, and `git -c gpg.program` forms, alongside the earlier helper checks. Interactive Approval Mode requires confirmation for these forms; headless workers refuse them.

This is a targeted risk check, not a shell parser or an execution sandbox. Other wrappers, aliases, substitutions, and program-specific options may still launch commands. Keep synthetic regression cases for known forms. Investigate new forms before adding them to the gate, and do not treat a passing Jev calibration as a security guarantee.
