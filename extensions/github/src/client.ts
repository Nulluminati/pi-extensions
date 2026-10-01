// GitHub data client for the `gh` CLI. All process execution goes through the
// pi.exec boundary passed to createGitHubClient, so callers stay testable and
// policy-compliant: argv arrays only (no shell), an explicit cwd, and a hard
// 30s timeout on every invocation.

import type { ExecOptions, ExecResult, ExtensionAPI } from "pi";

// --- Constants ---

export const GH_TIMEOUT_MS = 30_000;

const PR_LIST_FIELDS =
  "number,title,url,state,isDraft,author,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},body,headRefName,baseRefName`;
const PR_LIST_LIMIT = 100;

// --- Types ---

export interface GitHubRepository {
  nameWithOwner: string;
  url: string;
  host: string;
}

export interface Check {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: { login: string } | null;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: Check[] | null;
}

export interface GitHubSnapshot {
  repository: GitHubRepository;
  viewer: string;
  pullRequests: PullRequest[];
  limited: boolean;
}

export interface GitHubComment {
  author: string;
  body: string;
  url: string;
  createdAt: string;
  kind: "discussion" | "review" | "inline";
  path?: string;
  line?: number;
  state?: string;
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  headRefName: string;
  baseRefName: string;
  comments: GitHubComment[];
}

export interface GitHubClient {
  load(): Promise<GitHubSnapshot>;
  detail(repo: GitHubRepository, number: number): Promise<PullRequestDetail>;
}

// --- Errors and exec ---

function ghInstallHint(): string {
  return 'Make sure the GitHub CLI is installed and run "gh auth login".';
}

function failGh(what: string, result: ExecResult): never {
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
  if (result.killed) {
    throw new Error(
      `gh ${what} timed out after ${GH_TIMEOUT_MS}ms and was killed. ${ghInstallHint()}${detail ? ` gh said: ${detail}` : ""}`,
    );
  }
  throw new Error(
    `gh ${what} failed (exit ${result.code}). ${ghInstallHint()}${detail ? ` gh said: ${detail}` : ""}`,
  );
}

async function runGh(
  exec: ExtensionAPI["exec"],
  args: string[],
  cwd: string,
  what: string,
): Promise<string> {
  const options: ExecOptions = { cwd, timeout: GH_TIMEOUT_MS, env: { GH_REPO: "" } };
  let result: ExecResult;
  try {
    result = await exec("gh", args, options);
  } catch (error) {
    throw new Error(`Could not run "gh" (${what}). ${ghInstallHint()} (${String(error)})`);
  }
  if (result.killed || result.code !== 0) failGh(what, result);
  return result.stdout;
}

// --- JSON and shape validation ---

function parseJsonOutput(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`gh ${what} returned malformed JSON. ${ghInstallHint()} (${String(error)})`);
  }
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `gh ${what} returned an unexpected shape: expected a JSON object. ${ghInstallHint()}`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(
      `gh ${what} returned an unexpected shape: missing or invalid "${key}". ${ghInstallHint()}`,
    );
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function hostFromUrl(url: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gh ${what} returned a malformed repository URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`gh ${what} returned a non-HTTPS repository URL: ${url}`);
  }
  return parsed.host;
}

// --- Pull request parsing ---

function parseCheck(value: unknown, what: string): Check {
  const record = assertObject(value, what);
  const check: Check = {};
  if (typeof record.__typename === "string") check.__typename = record.__typename;
  if (typeof record.name === "string") check.name = record.name;
  if (typeof record.context === "string") check.context = record.context;
  if (typeof record.status === "string") check.status = record.status;
  if (typeof record.conclusion === "string") check.conclusion = record.conclusion;
  if (typeof record.state === "string") check.state = record.state;
  if (typeof record.detailsUrl === "string") check.detailsUrl = record.detailsUrl;
  if (typeof record.targetUrl === "string") check.targetUrl = record.targetUrl;
  return check;
}

function requirePullRequestNumber(record: Record<string, unknown>, what: string): number {
  const value = record.number;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `gh ${what} returned an unexpected shape: "number" must be an integer. ${ghInstallHint()}`,
    );
  }
  return value;
}

function parsePullRequest(value: unknown, what: string): PullRequest {
  const record = assertObject(value, what);
  if (typeof record.isDraft !== "boolean") {
    throw new Error(`gh ${what} returned an invalid or missing "isDraft" field.`);
  }
  if (!("statusCheckRollup" in record)) {
    throw new Error(`gh ${what} returned a missing "statusCheckRollup" field.`);
  }
  const authorValue = record.author;
  let author: { login: string } | null = null;
  if (authorValue !== null && authorValue !== undefined) {
    const authorRecord = assertObject(authorValue, `${what} entry author`);
    author = { login: requiredString(authorRecord, "login", `${what} entry author`) };
  }
  const rollupValue = record.statusCheckRollup;
  let rollup: Check[] | null = null;
  if (rollupValue !== null && rollupValue !== undefined) {
    if (!Array.isArray(rollupValue)) {
      throw new Error(
        `gh ${what} returned an unexpected shape: "statusCheckRollup" must be null or an array. ${ghInstallHint()}`,
      );
    }
    rollup = rollupValue.map((entry) => parseCheck(entry, `${what} entry check`));
  }
  return {
    number: requirePullRequestNumber(record, what),
    title: requiredString(record, "title", what),
    url: requiredString(record, "url", what),
    state: requiredString(record, "state", what),
    isDraft: record.isDraft === true,
    author,
    reviewDecision: optionalString(record, "reviewDecision", "UNKNOWN"),
    mergeable: optionalString(record, "mergeable", ""),
    mergeStateStatus: optionalString(record, "mergeStateStatus", ""),
    statusCheckRollup: rollup,
  };
}

// --- Client ---

export function createGitHubClient(exec: ExtensionAPI["exec"], cwd: string): GitHubClient {
  function assertSlug(nameWithOwner: string): string {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(nameWithOwner)) {
      throw new Error(
        `Invalid repository nameWithOwner: "${nameWithOwner}" (expected "owner/repo").`,
      );
    }
    return nameWithOwner;
  }

  async function run(args: string[], what: string): Promise<string> {
    return runGh(exec, args, cwd, what);
  }

  /** Run a gh api endpoint with --paginate --slurp and flatten the page
   *  arrays. Empty output (no pages) yields an empty list; nothing is
   *  silently truncated. */
  async function paginate(
    host: string,
    endpoint: string,
    what: string,
  ): Promise<Record<string, unknown>[]> {
    const stdout = await run(["api", "--paginate", "--slurp", "--hostname", host, endpoint], what);
    const trimmed = stdout.trim();
    if (trimmed === "") return [];
    const parsed = parseJsonOutput(trimmed, what);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `gh ${what} returned an unexpected shape: expected a JSON array of pages. ${ghInstallHint()}`,
      );
    }
    const items: Record<string, unknown>[] = [];
    for (const page of parsed) {
      if (Array.isArray(page)) {
        for (const item of page) items.push(assertObject(item, `${what} entry`));
      } else {
        items.push(assertObject(page, `${what} entry`));
      }
    }
    return items;
  }

  function commentIdentity(
    record: Record<string, unknown>,
    what: string,
  ): { author: string; url: string } {
    const user =
      record.user === null || record.user === undefined
        ? undefined
        : assertObject(record.user, what);
    const author = record.user === null ? "deleted" : user?.login;
    if (typeof author !== "string") {
      throw new Error(
        `gh ${what} returned an unexpected shape: missing or invalid "user.login". ${ghInstallHint()}`,
      );
    }
    const url = record.html_url;
    if (typeof url !== "string") {
      throw new Error(
        `gh ${what} returned an unexpected shape: missing or invalid "html_url". ${ghInstallHint()}`,
      );
    }
    return { author, url };
  }

  function mapDiscussionComment(record: Record<string, unknown>): GitHubComment {
    const { author, url } = commentIdentity(record, "issue comments");
    return {
      author,
      body: optionalString(record, "body", ""),
      url,
      createdAt: requiredString(record, "created_at", "issue comments"),
      kind: "discussion",
    };
  }

  function mapReview(record: Record<string, unknown>): GitHubComment {
    const { author, url } = commentIdentity(record, "reviews");
    const comment: GitHubComment = {
      author,
      body: optionalString(record, "body", ""),
      url,
      createdAt: optionalString(record, "submitted_at", ""),
      kind: "review",
    };
    const state = record.state;
    if (typeof state === "string") comment.state = state;
    return comment;
  }

  function mapInlineComment(record: Record<string, unknown>): GitHubComment {
    const { author, url } = commentIdentity(record, "review comments");
    const comment: GitHubComment = {
      author,
      body: optionalString(record, "body", ""),
      url,
      createdAt: requiredString(record, "created_at", "review comments"),
      kind: "inline",
    };
    const path = record.path;
    if (typeof path === "string") comment.path = path;
    const line = record.line;
    if (typeof line === "number") comment.line = line;
    const state = record.state;
    if (typeof state === "string") comment.state = state;
    return comment;
  }

  return {
    async load(): Promise<GitHubSnapshot> {
      const repoOut = await run(["repo", "view", "--json", "nameWithOwner,url"], "repo view");
      const repoRecord = assertObject(parseJsonOutput(repoOut, "repo view"), "repo view");
      const nameWithOwner = assertSlug(requiredString(repoRecord, "nameWithOwner", "repo view"));
      const url = requiredString(repoRecord, "url", "repo view");
      const host = hostFromUrl(url, "repo view");
      const repository: GitHubRepository = { nameWithOwner, url, host };

      const slug = `${host}/${nameWithOwner}`;
      const [userOut, listOut] = await Promise.all([
        run(["api", "user", "--hostname", host], "api user"),
        run(
          [
            "pr",
            "list",
            "--repo",
            slug,
            "--state",
            "open",
            "--limit",
            String(PR_LIST_LIMIT),
            "--json",
            PR_LIST_FIELDS,
          ],
          "pr list",
        ),
      ]);

      const userRecord = assertObject(parseJsonOutput(userOut, "api user"), "api user");
      const viewer = requiredString(userRecord, "login", "api user");

      const listParsed = parseJsonOutput(listOut, "pr list");
      if (!Array.isArray(listParsed)) {
        throw new Error(
          `gh pr list returned an unexpected shape: expected a JSON array. ${ghInstallHint()}`,
        );
      }
      const pullRequests = listParsed.map((entry) => parsePullRequest(entry, "pr list"));

      return { repository, viewer, pullRequests, limited: pullRequests.length >= PR_LIST_LIMIT };
    },

    async detail(repo: GitHubRepository, number: number): Promise<PullRequestDetail> {
      const nameWithOwner = assertSlug(repo.nameWithOwner);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`Invalid pull request number: ${String(number)}.`);
      }
      const slug = `${repo.host}/${nameWithOwner}`;
      const viewOut = await run(
        ["pr", "view", String(number), "--repo", slug, "--json", PR_VIEW_FIELDS],
        "pr view",
      );
      const viewRecord = assertObject(parseJsonOutput(viewOut, "pr view"), "pr view");
      const base = parsePullRequest(viewRecord, "pr view");

      const issuesEndpoint = `repos/${nameWithOwner}/issues/${base.number}/comments`;
      const reviewsEndpoint = `repos/${nameWithOwner}/pulls/${base.number}/reviews`;
      const inlineEndpoint = `repos/${nameWithOwner}/pulls/${base.number}/comments`;
      const [discussion, reviews, inline] = await Promise.all([
        paginate(repo.host, issuesEndpoint, "issue comments"),
        paginate(repo.host, reviewsEndpoint, "reviews"),
        paginate(repo.host, inlineEndpoint, "review comments"),
      ]);

      const comments: GitHubComment[] = [
        ...discussion.map(mapDiscussionComment),
        ...reviews.map(mapReview),
        ...inline.map(mapInlineComment),
      ];

      return {
        ...base,
        body: optionalString(viewRecord, "body", ""),
        headRefName: requiredString(viewRecord, "headRefName", "pr view"),
        baseRefName: requiredString(viewRecord, "baseRefName", "pr view"),
        comments,
      };
    },
  };
}
