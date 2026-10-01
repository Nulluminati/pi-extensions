# GitHub

`/github` opens a centered overlay for the current repository's open pull requests (PRs).
It uses the GitHub Command Line Interface (CLI), `gh`, and your existing login.
The extension adds no npm dependencies.

## Setup

1. Install `gh` from your operating system's package manager.
2. Run `gh auth login`.
3. Open Pi inside a GitHub repository.
4. Run `/github`.

For a direct development session, run `pi -e extensions/github/github.ts` from this repository.

## Pull requests and filters

The list shows review approval status and Continuous Integration (CI) status.
It also shows whether GitHub reports that the PR is ready to merge.
Drafts, conflicts, missing approvals, requested changes, failed checks, and pending checks prevent a ready status.
Unknown states also prevent a ready status.

`Ready to merge` requires an open, non-draft PR, a mergeable head, and GitHub's `CLEAN` merge state.
Reviews must be approved or not required.
Checks must pass, or GitHub must report no checks.
This status is a snapshot, not a guarantee that a later merge will succeed.
The extension does not merge PRs.

1. Press `Ctrl+F` to open filters.
2. Select all authors, your own PRs, or other authors' PRs.
3. Open filters again to select a status filter.

Status filters include all statuses, waiting on approvals, failed CI, and ready to merge.
Author and status filters work together.
GitHub applies author, approval, and failed CI filters before the extension loads a page.
The approvals filter uses `review:required` and verifies GitHub's `REVIEW_REQUIRED` decision.
The failed CI filter uses GitHub's `status:failure` search qualifier.
The ready filter searches non-draft candidates and applies the conservative readiness check to each page.
A candidate page can contain no ready PRs. Continue to the next page to check more candidates.
The count shows GitHub's search matches, not the number of locally verified ready PRs.

Type text to search GitHub across the repository, not only the loaded page.
GitHub search syntax works, including `label:bug` and `created:>=2025-01-01`.
The extension waits 300 milliseconds after input before it requests results.
Search and filter changes return to the first page.
Press `Ctrl+R` to refresh the list from the first page without changing the search or filters.

The extension loads 25 PRs per page.
Press `Page Down` to load the next page.
Press `Page Up` to return to the previous page.
The extension keeps visited pages until you change the search, filters, or refresh the list.

[GitHub limits each search to 1,000 results](https://docs.github.com/en/enterprise-cloud@latest/graphql/reference/search).
The overlay shows a warning when more results match.
Narrow the search to reach requests outside this limit.

## Comments and actions

Select a PR with `Enter` to open the Description tab.
Press `Tab` or `Shift+Tab` to switch between Description, Comments, and Checks.
The Comments tab includes discussion comments, reviews, and inline review comments.
The Checks tab shows check names, results, and links.
The extension loads all comment pages that your login can access.
Comments show author, date, link, and file position when available.
The detail view formats descriptions and comments as Markdown.
It hides Hypertext Markup Language (HTML) wrapper tags.
Code examples keep their literal tags.

Use arrow keys or `Page Up` and `Page Down` to scroll the current tab.
Each tab keeps its own scroll position.
Press `Ctrl+R` to refresh the selected PR without changing tabs.
Press `Escape` to return to the list.

Press `Ctrl+A` in the detail view to choose an agent action.
AI means artificial intelligence.

| Action | Agent request |
| --- | --- |
| AI-assisted review | Inspect the diff and tests. Report defects without editing files or publishing a review. |
| Investigate CI failures | Read current failed checks and job logs. Make focused local fixes with regression tests when safe. |
| Follow up on comments | Check comments and unresolved review threads. Make focused local fixes and draft replies when safe. |

Selecting an action closes the overlay and sends a request to the main Pi agent.
The agent starts immediately when idle.
When busy, the agent receives the request after its current turn.

Each request includes the PR link and a bounded snapshot of its description, checks, and comments.
The request tells the agent to fetch fresh data and check the local branch before editing files.
It treats GitHub content as untrusted data, not instructions.

The request tells the agent to ask before branch changes, commits, pushes, or remote writes.
Remote writes include comments, reviews, merges, workflow retries, and thread resolution.
These limits are prompt instructions, not a permission enforcement system.
Your other Pi permission extensions still apply.

## Configuration

The extension uses no configuration file or persistent state.
`gh` supplies authentication and repository access.
The extension ignores `GH_REPO` when it resolves the current repository.
It pins subsequent requests to that repository and GitHub host.
GitHub Enterprise hosts use their existing `gh` login.

Each CLI request has a 30-second timeout.
Failures appear inside the overlay with refresh and back controls.
`/github` only opens in interactive terminal mode.
