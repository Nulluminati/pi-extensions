# Public repository review

Review date: 2026-10-30. Source baseline: `8969ced`.

The repository remains private. This review does not change GitHub settings or rewrite Git history.
No confirmed credential leak was found. Resolve or explicitly accept the dependency findings before publication.

## Changes in this branch

1. Limit Gitleaks exceptions to complete placeholder values and one synthetic commit identifier.
2. Scan README files and GitHub workflows without path exclusions.
3. Detect credentials even when a fixture commit identifier appears on the same line.
4. Test these exceptions in the secret-scan job without external JavaScript dependencies.
5. Disable Gitleaks review comments because fork pull requests use read-only tokens.
6. Ignore `.env.*` files and local virtual-model evaluation data in fresh clones.

Environment example files remain eligible for version control. Review their contents before commit.

## Evidence and limits

Gitleaks 8.30.0 scanned the locally available history with and without repository exceptions.
The scan covered all local references, including unpublished work branches.
The unfiltered scan reported three findings. All three were commit identifiers, not credentials.
Two occur in an unpublished tool-search report. One occurs in the code-search test fixture.

The separate scan of `origin` references examined 451 commits and reported only the fixture identifier without exceptions.
The scan with the corrected exceptions reported no findings.
The separate `origin/main` scan examined 446 commits and reported no findings.
These counts come from Gitleaks, which does not count every Git object as a scanned commit.

The remote advertised `main` and two Dependabot branches, with no tags during the review.
Re-run scans before publication if remote references change.
Secret detection cannot prove that a repository contains no sensitive information.

Tracked files contain no discovered credential files, private keys, session transcripts, or private service addresses.
The historical `settings.json` contains only a changelog version.
Provider authentication uses environment variables or local authentication storage.
The Codex authentication client identifier is a public OAuth client identifier, not a client secret.

Git history contains personal author details. The owner explicitly accepts their publication.
This branch does not remove those details or change existing commits.
Some test paths and evaluation reports also identify the maintainer.

The root MIT license matches `package.json`.
The TypeSafe skill retains its separate MIT copyright notice.
Voice models download from upstream releases; this repository does not distribute model weights.
Check each model's upstream license before redistributing weights. The root license does not replace upstream terms.
This review does not establish the provenance of every source line.

`AGENTS.md` already uses short repository rules and linked task guides. No instruction restructure is needed.

## Dependency findings

`npm ci` succeeded. `npm audit --json` reported five vulnerable packages: four high and one moderate.
The total includes parent packages affected by vulnerable dependencies. It does not mean five independent vulnerabilities.

| Package | Installed version | Finding | Required action |
| --- | --- | --- | --- |
| `node-forge` | 1.4.0 | High: signature verification weakness | Update the lockfile to a patched version permitted by sandbox-runtime's `^1.4.0` range. Run the full checks. |
| `undici` | 8.10.2 | High: certificate validation, redirect disclosure, and denial-of-service findings | Update the Pi packages together when they use Undici 8.12.2 or later. Test a scoped override if an upstream release is unavailable. |
| `zod` | 3.25.76 | High: oversized collection validation can exhaust memory | Request an upstream sandbox-runtime fix or a supported backport. Do not force Zod 4 into a dependency that requires Zod 3. |
| `@anthropic-ai/sandbox-runtime` | 0.0.79 | High through Zod | Follow the Zod action. This is a production dependency. |
| `@earendil-works/pi-coding-agent` | 1.3.0 | Moderate parent entry through Undici | Follow the Undici action. Pi also supplies runtime packages outside this repository's development install. |

Relevant advisories:

- [node-forge signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
- [Undici certificate validation](https://github.com/advisories/GHSA-2m5v-pch6-74hx)
- [Undici redirect disclosure](https://github.com/advisories/GHSA-4w7w-5xrc-9h26)
- [Zod memory exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)

The audit also lists other Undici denial-of-service findings. Re-run it for the complete, current list.
Do not run `npm audit fix --force`. Its proposed Pi downgrade does not preserve this repository's compatibility requirements.
This branch documents dependency actions instead of introducing untested overrides or package migrations.

## Verification status

The secret-scan regression test first failed against the original configuration. It passes with the corrected exceptions.
The ignore regression test uses a temporary Git repository without this checkout's local exclusions.

The successful commit hook ran `npm run check` without bypasses.
Formatting, lint, both type checks, and validation of all 32 extensions passed.
All 2,481 unit tests and all 103 runtime tests passed.

Earlier runs had intermittent failures. Two full unit runs and one isolated run failed the codemode signal-termination test.
The child command exceeded its seven-second timeout.
This branch changes neither that test nor `scripts/codemode-evaluation/runtime.ts`.

An earlier separate runtime run passed 97 tests and failed six tests across three files:

| Test file | Failures | Observed result |
| --- | --- | --- |
| `test/runtime/session-sandbox.test.ts` | 2 | The command-line session and allowed loopback request exceed their time limits. |
| `test/runtime/worker-model-recovery.test.ts` | 2 | Quota-recovery workers exceed the 20-second limit. |
| `test/runtime/worker-provider-chains.test.ts` | 2 | One worker exceeds 20 seconds; another does not produce `calls.jsonl`. |

This branch does not change runtime implementation or runtime tests.
These failures did not recur in the successful full check. Their causes remain unconfirmed.
Re-run the full checks before publication. Investigate any repeated timeout failures instead of disabling tests.
The publication file snapshot also passed Gitleaks with the corrected configuration.

## GitHub settings

The GitHub API reported these settings during the review:

| Setting | Observed state | Publication action |
| --- | --- | --- |
| Visibility | Private | Change only after the publication checks below. |
| Secret scanning | Disabled | Enable secret scanning and push protection when available. |
| Main branch protection and rulesets | API returned HTTP 403 under the current private plan | Configure protection after publication, or upgrade the plan first. |
| Workflow token | Read-only; cannot approve pull requests | Keep these limits. |
| Allowed Actions | All; commit pinning not required | Pin third-party Actions to reviewed commit identifiers. |
| Fork contributor approval | Unavailable while private | Require approval for all outside contributors when the setting becomes available. |
| Wiki and Pages | Disabled | No separate wiki or Pages content needs publication review. |

A workflow file does not make a status check mandatory.
The secret-scan job currently runs on pushes and pull requests; branch protection must require it explicitly.

## Publication procedure

1. Resolve or explicitly accept the dependency findings above.
2. Merge this branch through the normal review process.
3. Install Gitleaks locally.
4. Run `npm ci`.
5. Run `npm run check`.
6. Run `npm run test:secrets`.
7. Run `gitleaks git --log-opts='--all' --redact --config .gitleaks.toml .`.
8. Inspect every finding before changing an exception. Unpublished branches can contain harmless commit identifiers that the exceptions deliberately do not cover.
9. Review GitHub issues, pull request discussions, releases, and Actions logs and artifacts for private information.
10. Review repository and environment secrets, webhooks, installed applications, deploy keys, and collaborators.
11. Remove unnecessary credentials or access. Rotate any credential that has appeared in repository content or logs.
12. Confirm that existing author details and maintainer references may remain public.
13. Open the repository's Settings page and change visibility to public.
14. Enable secret scanning, push protection, and private vulnerability reporting where available.
15. Add a `SECURITY.md` file with the chosen private reporting route.
16. Require pull requests and the successful check and secret-scan jobs on `main`.
17. Block force pushes and branch deletion on `main`.
18. Require approval for all outside contributors before their Actions workflows run.
19. Confirm that fork workflows receive no repository secrets or write token.
20. Test installation from a separate account without repository access: `pi install git:github.com/Nulluminati/pi-extensions`.

Do not use `pull_request_target` to execute contributor code with privileged credentials.
GitHub-hosted discussions, logs, artifacts, access settings, and external services need an owner review.
The source audit does not certify those surfaces. A later visibility change cannot recall copies from public clones or forks.
