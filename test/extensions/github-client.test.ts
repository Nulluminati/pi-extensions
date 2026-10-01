// Tests for the GitHub data client (extensions/github/src/client.ts) and the
// PR status logic (extensions/github/src/status.ts). All gh invocations are
// mocked at the pi.exec boundary: no network access and no gh binary needed.

import type { ExecOptions, ExecResult, ExtensionAPI } from "pi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Check,
  createGitHubClient,
  type GitHubRepository,
  type PullRequest,
} from "../../extensions/github/src/client.ts";
import { filterPullRequests, summarizePullRequest } from "../../extensions/github/src/status.ts";

// --- Fixtures ---

const CWD = "/repo/checkout/sub/dir";
const HOST = "github.com";
const SLUG = "octocat/hello-world";
const REPO_URL = "https://github.com/octocat/hello-world";
const PR_LIST_FIELDS =
  "number,title,url,state,isDraft,author,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},body,headRefName,baseRefName`;
const EXEC_TIMEOUT_MS = 30_000;

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function checkRun(overrides: Partial<Check> = {}): Check {
  return {
    __typename: "CheckRun",
    name: "ci",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    ...overrides,
  };
}

function prFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Add feature",
    url: `${REPO_URL}/pull/7`,
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat" },
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [checkRun()],
    ...overrides,
  };
}

function readyPullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "Add feature",
    url: `${REPO_URL}/pull/7`,
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat" },
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [checkRun()],
    ...overrides,
  };
}

const GHE_REPO: GitHubRepository = {
  nameWithOwner: SLUG,
  url: REPO_URL,
  host: HOST,
};

// --- pi.exec harness ---

interface ExecCall {
  command: string;
  args: string[];
  options: ExecOptions | undefined;
}

interface Route {
  match(args: string[]): boolean;
  respond(args: string[]): ExecResult;
}

function repoViewRoute(stdout: string, overrides: Partial<ExecResult> = {}): Route {
  return {
    match: (args) => args[0] === "repo" && args[1] === "view",
    respond: () => execResult({ stdout, ...overrides }),
  };
}

function userRoute(stdout: string, overrides: Partial<ExecResult> = {}): Route {
  return {
    match: (args) => args[0] === "api" && args[1] === "user",
    respond: () => execResult({ stdout, ...overrides }),
  };
}

function prListRoute(stdout: string, overrides: Partial<ExecResult> = {}): Route {
  return {
    match: (args) => args[0] === "pr" && args[1] === "list",
    respond: () => execResult({ stdout, ...overrides }),
  };
}

function prViewRoute(stdout: string, overrides: Partial<ExecResult> = {}): Route {
  return {
    match: (args) => args[0] === "pr" && args[1] === "view",
    respond: () => execResult({ stdout, ...overrides }),
  };
}

function apiRoute(endpoint: string, stdout: string, overrides: Partial<ExecResult> = {}): Route {
  return {
    match: (args) => args[0] === "api" && args[args.length - 1] === endpoint,
    respond: () => execResult({ stdout, ...overrides }),
  };
}

function baseRoutes(
  options: { prList?: unknown[]; repoView?: string; user?: string } = {},
): Route[] {
  return [
    repoViewRoute(options.repoView ?? JSON.stringify({ nameWithOwner: SLUG, url: REPO_URL })),
    userRoute(options.user ?? JSON.stringify({ login: "octocat" })),
    prListRoute(JSON.stringify(options.prList ?? [])),
  ];
}

function createExec(routes: Route[]): { exec: ExtensionAPI["exec"]; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = vi.fn((command: string, args: string[], options?: ExecOptions) => {
    calls.push({ command, args, options });
    for (const route of routes) {
      if (route.match(args)) return Promise.resolve(route.respond(args));
    }
    return Promise.reject(new Error(`unexpected gh invocation: gh ${args.join(" ")}`));
  });
  return { exec: exec as unknown as ExtensionAPI["exec"], calls };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// --- client.load() ---

describe("createGitHubClient().load()", () => {
  it("resolves the repository, viewer, and open pull requests", async () => {
    const prs = [prFixture(), prFixture({ number: 8, title: "Second", url: `${REPO_URL}/pull/8` })];
    const { exec } = createExec(baseRoutes({ prList: prs }));
    const snapshot = await createGitHubClient(exec, CWD).load();
    expect(snapshot).toEqual({
      repository: { nameWithOwner: SLUG, url: REPO_URL, host: HOST },
      viewer: "octocat",
      pullRequests: [
        {
          number: 7,
          title: "Add feature",
          url: `${REPO_URL}/pull/7`,
          state: "OPEN",
          isDraft: false,
          author: { login: "octocat" },
          reviewDecision: "APPROVED",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [checkRun()],
        },
        {
          number: 8,
          title: "Second",
          url: `${REPO_URL}/pull/8`,
          state: "OPEN",
          isDraft: false,
          author: { login: "octocat" },
          reviewDecision: "APPROVED",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [checkRun()],
        },
      ],
      limited: false,
    });
  });

  it("runs gh without a shell, with an explicit cwd and a 30s timeout", async () => {
    const { exec, calls } = createExec(baseRoutes());
    await createGitHubClient(exec, CWD).load();
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.command).toBe("gh");
      expect(call.options).toEqual({ cwd: CWD, timeout: EXEC_TIMEOUT_MS, env: { GH_REPO: "" } });
    }
  });

  it("resolves the repo from a subdirectory and pins the host/owner/repo slug for pr list", async () => {
    const { exec, calls } = createExec(baseRoutes({ prList: [] }));
    await createGitHubClient(exec, CWD).load();
    expect(calls[0].args).toEqual(["repo", "view", "--json", "nameWithOwner,url"]);
    expect(calls[1].args).toEqual(["api", "user", "--hostname", HOST]);
    expect(calls[2].args).toEqual([
      "pr",
      "list",
      "--repo",
      "github.com/octocat/hello-world",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      PR_LIST_FIELDS,
    ]);
  });

  it("derives the host from an HTTPS URL of a GitHub Enterprise host", async () => {
    const repoView = JSON.stringify({
      nameWithOwner: "acme/widgets",
      url: "https://ghe.example.com/acme/widgets",
    });
    const { exec, calls } = createExec([
      repoViewRoute(repoView),
      userRoute(JSON.stringify({ login: "acme-dev" })),
      prListRoute("[]"),
    ]);
    const snapshot = await createGitHubClient(exec, CWD).load();
    expect(snapshot.repository).toEqual({
      nameWithOwner: "acme/widgets",
      url: "https://ghe.example.com/acme/widgets",
      host: "ghe.example.com",
    });
    expect(calls[1].args).toEqual(["api", "user", "--hostname", "ghe.example.com"]);
    expect(calls[2].args).toContain("ghe.example.com/acme/widgets");
  });

  it("marks the snapshot limited when exactly 100 open PRs are returned", async () => {
    const prs = Array.from({ length: 100 }, (_unused, index) => prFixture({ number: index + 1 }));
    const { exec } = createExec(baseRoutes({ prList: prs }));
    const snapshot = await createGitHubClient(exec, CWD).load();
    expect(snapshot.pullRequests.length).toBe(100);
    expect(snapshot.limited).toBe(true);
  });

  it("maps CheckRun and StatusContext rollup entries onto the Check shape and drops unknown keys", async () => {
    const rollup = [
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.com/build",
        startedAt: "2024-01-01T00:00:00Z",
      },
      {
        __typename: "StatusContext",
        context: "ci/travis",
        state: "PENDING",
        targetUrl: "https://example.com/travis",
      },
    ];
    const { exec } = createExec(baseRoutes({ prList: [prFixture({ statusCheckRollup: rollup })] }));
    const snapshot = await createGitHubClient(exec, CWD).load();
    expect(snapshot.pullRequests[0]?.statusCheckRollup).toEqual([
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.com/build",
      },
      {
        __typename: "StatusContext",
        context: "ci/travis",
        state: "PENDING",
        targetUrl: "https://example.com/travis",
      },
    ]);
  });

  it("keeps a null author and a null rollup as null", async () => {
    const { exec } = createExec(
      baseRoutes({ prList: [prFixture({ author: null, statusCheckRollup: null })] }),
    );
    const snapshot = await createGitHubClient(exec, CWD).load();
    expect(snapshot.pullRequests[0]?.author).toBeNull();
    expect(snapshot.pullRequests[0]?.statusCheckRollup).toBeNull();
  });

  it("fails with an install/auth hint when gh exits non-zero", async () => {
    const { exec } = createExec([repoViewRoute("", { code: 1, stderr: "not logged in" })]);
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(
      /gh repo view failed \(exit 1\).*gh auth login.*not logged in/s,
    );
  });

  it("fails with a timeout message when gh is killed", async () => {
    const { exec } = createExec([repoViewRoute("", { code: 137, killed: true })]);
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(
      /gh repo view timed out after 30000ms/,
    );
  });

  it("fails with an install hint when gh cannot be spawned", async () => {
    const exec = vi.fn(() =>
      Promise.reject(new Error("spawn gh ENOENT")),
    ) as unknown as ExtensionAPI["exec"];
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(
      /Could not run "gh".*installed/s,
    );
  });

  it("fails on malformed JSON with a useful error", async () => {
    const { exec } = createExec([repoViewRoute("{not json")]);
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(
      /gh repo view returned malformed JSON/,
    );
  });

  it("ignores GH_REPO when resolving the current repository", async () => {
    vi.stubEnv("GH_REPO", "another/repo");
    try {
      const { exec, calls } = createExec(baseRoutes());
      await createGitHubClient(exec, CWD).load();
      expect(calls[0].options?.env).toEqual({ GH_REPO: "" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["isDraft", "statusCheckRollup"])(
    "rejects missing %s instead of assuming readiness",
    async (field) => {
      const { exec } = createExec(baseRoutes({ prList: [prFixture({ [field]: undefined })] }));
      await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(field);
    },
  );

  it("fails when the repo view response is missing fields", async () => {
    const { exec } = createExec([repoViewRoute(JSON.stringify({ nameWithOwner: SLUG }))]);
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(/gh repo view.*url/s);
  });

  it("rejects a non-https repository URL", async () => {
    const repoView = JSON.stringify({
      nameWithOwner: SLUG,
      url: "http://github.com/octocat/hello-world",
    });
    const { exec } = createExec([repoViewRoute(repoView)]);
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(/HTTPS/);
  });

  it("rejects repository names that can become shell instructions in an agent request", async () => {
    const { exec } = createExec(
      baseRoutes({
        repoView: JSON.stringify({ nameWithOwner: "owner/repo;echo-bad", url: REPO_URL }),
      }),
    );
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow("repository");
  });

  it("does not assume an absent review decision means reviews are unnecessary", async () => {
    const { exec } = createExec(baseRoutes({ prList: [prFixture({ reviewDecision: undefined })] }));
    const snapshot = await createGitHubClient(exec, CWD).load();
    const pr = snapshot.pullRequests[0];
    expect(pr).toBeDefined();
    if (pr) expect(summarizePullRequest(pr).ready).toBe(false);
  });

  it("fails when the viewer response has no login", async () => {
    const { exec } = createExec(baseRoutes({ user: JSON.stringify({ name: "Octocat" }) }));
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(/gh api user.*login/s);
  });

  it("fails when pr list does not return an array", async () => {
    const { exec } = createExec(
      baseRoutes({ prList: { unexpected: true } as unknown as unknown[] }),
    );
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(/gh pr list.*array/s);
  });

  it("fails when a pr list entry is missing a required field", async () => {
    const { exec } = createExec(baseRoutes({ prList: [prFixture({ title: undefined })] }));
    await expect(createGitHubClient(exec, CWD).load()).rejects.toThrow(/gh pr list.*title/s);
  });
});

// --- client.detail() ---

describe("createGitHubClient().detail()", () => {
  const DISCUSSION_PAGES = [
    [
      {
        user: { login: "alice" },
        body: "First",
        html_url: `${REPO_URL}/issues/7#issuecomment-1`,
        created_at: "2024-01-01T00:00:00Z",
      },
    ],
    [
      {
        user: { login: "bob" },
        body: "Second",
        html_url: `${REPO_URL}/issues/7#issuecomment-2`,
        created_at: "2024-01-02T00:00:00Z",
      },
    ],
  ];
  const REVIEWS = [
    {
      user: { login: "carol" },
      body: "Nice work",
      html_url: `${REPO_URL}/pull/7#pullrequestreview-1`,
      submitted_at: "2024-01-03T00:00:00Z",
      state: "APPROVED",
    },
  ];
  const INLINE = [
    {
      user: { login: "dave" },
      body: "Nit: rename this",
      html_url: `${REPO_URL}/pull/7#discussion_r1`,
      created_at: "2024-01-04T00:00:00Z",
      path: "src/a.ts",
      line: 12,
    },
  ];

  function detailRoutes(options: {
    prView?: Record<string, unknown>;
    discussion?: unknown;
    reviews?: unknown;
    inline?: unknown;
  }): { routes: Route[]; prView: Record<string, unknown> } {
    const prView = {
      ...prFixture(),
      body: "PR body",
      headRefName: "feature",
      baseRefName: "main",
      ...options.prView,
    };
    const routes: Route[] = [
      ...baseRoutes(),
      prViewRoute(JSON.stringify(prView)),
      apiRoute(
        `repos/${SLUG}/issues/7/comments`,
        JSON.stringify(options.discussion ?? DISCUSSION_PAGES),
      ),
      apiRoute(`repos/${SLUG}/pulls/7/reviews`, JSON.stringify(options.reviews ?? REVIEWS)),
      apiRoute(`repos/${SLUG}/pulls/7/comments`, JSON.stringify(options.inline ?? INLINE)),
    ];
    return { routes, prView };
  }

  it("returns PR fields plus flattened discussion, review, and inline comments", async () => {
    const { exec, calls } = createExec(detailRoutes({}).routes);
    const detail = await createGitHubClient(exec, CWD).detail(GHE_REPO, 7);

    expect(detail).toEqual({
      number: 7,
      title: "Add feature",
      url: `${REPO_URL}/pull/7`,
      state: "OPEN",
      isDraft: false,
      author: { login: "octocat" },
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [checkRun()],
      body: "PR body",
      headRefName: "feature",
      baseRefName: "main",
      comments: [
        {
          author: "alice",
          body: "First",
          url: `${REPO_URL}/issues/7#issuecomment-1`,
          createdAt: "2024-01-01T00:00:00Z",
          kind: "discussion",
        },
        {
          author: "bob",
          body: "Second",
          url: `${REPO_URL}/issues/7#issuecomment-2`,
          createdAt: "2024-01-02T00:00:00Z",
          kind: "discussion",
        },
        {
          author: "carol",
          body: "Nice work",
          url: `${REPO_URL}/pull/7#pullrequestreview-1`,
          createdAt: "2024-01-03T00:00:00Z",
          kind: "review",
          state: "APPROVED",
        },
        {
          author: "dave",
          body: "Nit: rename this",
          url: `${REPO_URL}/pull/7#discussion_r1`,
          createdAt: "2024-01-04T00:00:00Z",
          kind: "inline",
          path: "src/a.ts",
          line: 12,
        },
      ],
    });

    const apiCalls = calls.filter((call) => call.args[0] === "api");
    expect(apiCalls.map((call) => call.args)).toEqual([
      ["api", "--paginate", "--slurp", "--hostname", HOST, `repos/${SLUG}/issues/7/comments`],
      ["api", "--paginate", "--slurp", "--hostname", HOST, `repos/${SLUG}/pulls/7/reviews`],
      ["api", "--paginate", "--slurp", "--hostname", HOST, `repos/${SLUG}/pulls/7/comments`],
    ]);
    expect(calls.find((call) => call.args[0] === "pr" && call.args[1] === "view")?.args).toEqual([
      "pr",
      "view",
      "7",
      "--repo",
      "github.com/octocat/hello-world",
      "--json",
      PR_VIEW_FIELDS,
    ]);
  });

  it("targets the passed repository (base repo of a fork PR), not the cwd", async () => {
    const routes = detailRoutes({}).routes.map((route) => ({
      ...route,
      match: (args: string[]) => route.match(args.map((arg) => arg.replace("acme/widgets", SLUG))),
    }));
    const { exec, calls } = createExec(routes);
    await createGitHubClient(exec, CWD).detail(
      {
        nameWithOwner: "acme/widgets",
        url: "https://ghe.example.com/acme/widgets",
        host: "ghe.example.com",
      },
      7,
    );
    const joined = calls.map((call) => call.args.join(" "));
    expect(joined.some((entry) => entry.includes("--repo ghe.example.com/acme/widgets"))).toBe(
      true,
    );
    expect(joined.some((entry) => entry.includes("--hostname ghe.example.com"))).toBe(true);
    expect(joined.some((entry) => entry.includes(`repos/acme/widgets/issues/7/comments`))).toBe(
      true,
    );
  });

  it("returns an empty comment list when the paginated endpoints return empty pages", async () => {
    const { exec } = createExec(
      detailRoutes({ discussion: [[]], reviews: [[]], inline: [[]] }).routes,
    );
    const detail = await createGitHubClient(exec, CWD).detail(GHE_REPO, 7);
    expect(detail.comments).toEqual([]);
  });

  it("keeps comments from a deleted account", async () => {
    const { exec } = createExec(
      detailRoutes({
        inline: [
          {
            user: null,
            body: "Original comment",
            html_url: `${REPO_URL}/pull/7#discussion_r1`,
            created_at: "2024-01-04T00:00:00Z",
          },
        ],
      }).routes,
    );
    const detail = await createGitHubClient(exec, CWD).detail(GHE_REPO, 7);
    expect(detail.comments.find((comment) => comment.kind === "inline")?.author).toBe("deleted");
  });

  it("normalizes a null review body to an empty string", async () => {
    const reviews = [
      {
        user: { login: "carol" },
        body: null,
        html_url: `${REPO_URL}/pull/7#pullrequestreview-1`,
        submitted_at: "2024-01-03T00:00:00Z",
        state: "APPROVED",
      },
    ];
    const { exec } = createExec(detailRoutes({ reviews }).routes);
    const detail = await createGitHubClient(exec, CWD).detail(GHE_REPO, 7);
    expect(detail.comments.find((comment) => comment.kind === "review")?.body).toBe("");
  });

  it("rejects a non-positive or non-integer PR number without spawning gh", async () => {
    const { exec, calls } = createExec(detailRoutes({}).routes);
    const client = createGitHubClient(exec, CWD);
    await expect(client.detail(GHE_REPO, 0)).rejects.toThrow(/pull request number/);
    await expect(client.detail(GHE_REPO, 1.5)).rejects.toThrow(/pull request number/);
    await expect(client.detail(GHE_REPO, Number.NaN)).rejects.toThrow(/pull request number/);
    expect(calls).toEqual([]);
  });

  it("fails when a review comment has no author login", async () => {
    const inline = [
      {
        body: "orphan",
        html_url: `${REPO_URL}/pull/7#discussion_r9`,
        created_at: "2024-01-04T00:00:00Z",
      },
    ];
    const { exec } = createExec(detailRoutes({ inline }).routes);
    await expect(createGitHubClient(exec, CWD).detail(GHE_REPO, 7)).rejects.toThrow(
      /review comments.*login/s,
    );
  });

  it("fails with an install/auth hint when pr view exits non-zero", async () => {
    const { exec } = createExec([
      ...baseRoutes(),
      prViewRoute("", { code: 1, stderr: "GraphQL: Not found" }),
    ]);
    await expect(createGitHubClient(exec, CWD).detail(GHE_REPO, 7)).rejects.toThrow(
      /gh pr view failed \(exit 1\).*gh auth login/s,
    );
  });
});

// --- summarizePullRequest ---

describe("summarizePullRequest", () => {
  it("reports a green, clean, approved PR as ready with no reasons", () => {
    const status = summarizePullRequest(readyPullRequest());
    expect(status).toEqual({ review: "Approved", ci: "passed", ready: true, reasons: [] });
  });

  it("treats a missing rollup as no checks and still ready", () => {
    const status = summarizePullRequest(readyPullRequest({ statusCheckRollup: null }));
    expect(status.ci).toBe("none");
    expect(status.ready).toBe(true);
    const empty = summarizePullRequest(readyPullRequest({ statusCheckRollup: [] }));
    expect(empty.ci).toBe("none");
    expect(empty.ready).toBe(true);
  });

  it("shows reviews are unnecessary without treating that as a merge blocker", () => {
    const status = summarizePullRequest(readyPullRequest({ reviewDecision: "" }));
    expect(status.ready).toBe(true);
    expect(status.review).toBe("Reviews not required");
    expect(status.reasons).toEqual([]);
  });

  it("blocks on draft PRs", () => {
    const status = summarizePullRequest(readyPullRequest({ isDraft: true }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/draft/i);
  });

  it("blocks on merge conflicts", () => {
    const status = summarizePullRequest(readyPullRequest({ mergeable: "CONFLICTING" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/conflict/i);
  });

  it("blocks on an unknown mergeable state", () => {
    const status = summarizePullRequest(readyPullRequest({ mergeable: "UNKNOWN" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/mergeable/i);
  });

  it("blocks a BLOCKED PR despite green CI and approval", () => {
    const status = summarizePullRequest(readyPullRequest({ mergeStateStatus: "BLOCKED" }));
    expect(status.ci).toBe("passed");
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/blocked/i);
  });

  const mergeStateReasons: Array<[string, RegExp]> = [
    ["BEHIND", /behind/i],
    ["UNSTABLE", /unstable/i],
    ["HAS_HOOKS", /hooks/i],
    ["DIRTY", /conflict/i],
    ["DRAFT", /draft/i],
    ["FUTURE_STATE", /merge state/i],
  ];
  for (const [mergeState, pattern] of mergeStateReasons) {
    it(`blocks on mergeStateStatus ${mergeState}`, () => {
      const status = summarizePullRequest(readyPullRequest({ mergeStateStatus: mergeState }));
      expect(status.ready).toBe(false);
      expect(status.reasons.join("\n")).toMatch(pattern);
    });
  }

  it("blocks when the PR is not open", () => {
    const status = summarizePullRequest(readyPullRequest({ state: "MERGED" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/open/i);
  });

  const failedConclusions = [
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ];
  for (const conclusion of failedConclusions) {
    it(`reports CheckRun conclusion ${conclusion} as failed CI`, () => {
      const status = summarizePullRequest(
        readyPullRequest({ statusCheckRollup: [checkRun({ conclusion })] }),
      );
      expect(status.ci).toBe("failed");
      expect(status.ready).toBe(false);
      expect(status.reasons.join("\n")).toMatch(/checks failed/i);
    });
  }

  const pendingStatuses = ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"];
  for (const checkStatus of pendingStatuses) {
    it(`reports CheckRun status ${checkStatus} as pending CI`, () => {
      const status = summarizePullRequest(
        readyPullRequest({
          statusCheckRollup: [checkRun({ status: checkStatus, conclusion: "" })],
        }),
      );
      expect(status.ci).toBe("pending");
      expect(status.ready).toBe(false);
      expect(status.reasons.join("\n")).toMatch(/checks pending/i);
    });
  }

  const contextCases: Array<[string, "passed" | "failed" | "pending" | "unknown"]> = [
    ["SUCCESS", "passed"],
    ["NEUTRAL", "passed"],
    ["SKIPPED", "passed"],
    ["FAILURE", "failed"],
    ["ERROR", "failed"],
    ["EXPECTED", "pending"],
    ["PENDING", "pending"],
    ["MYSTERY", "unknown"],
  ];
  for (const [state, expected] of contextCases) {
    it(`reports StatusContext state ${state} as ${expected}`, () => {
      const status = summarizePullRequest(
        readyPullRequest({
          statusCheckRollup: [{ __typename: "StatusContext", context: "ci/travis", state }],
        }),
      );
      expect(status.ci).toBe(expected);
    });
  }

  it("reports an unknown CheckRun conclusion as unknown CI that is never ready", () => {
    const status = summarizePullRequest(
      readyPullRequest({ statusCheckRollup: [checkRun({ conclusion: "NOVEL" })] }),
    );
    expect(status.ci).toBe("unknown");
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/unknown/i);
  });

  it("does not accept success as a CheckRun status", () => {
    const status = summarizePullRequest(
      readyPullRequest({ statusCheckRollup: [checkRun({ status: "SUCCESS" })] }),
    );
    expect(status.ci).toBe("unknown");
    expect(status.ready).toBe(false);
  });

  it("fails the whole rollup when one check fails", () => {
    const status = summarizePullRequest(
      readyPullRequest({
        statusCheckRollup: [checkRun(), checkRun({ name: "lint", conclusion: "FAILURE" })],
      }),
    );
    expect(status.ci).toBe("failed");
    expect(status.ready).toBe(false);
  });

  it("reports unknown CI when any check is unknown, even alongside pending checks", () => {
    const status = summarizePullRequest(
      readyPullRequest({
        statusCheckRollup: [
          checkRun({ name: "queued-job", status: "QUEUED", conclusion: "" }),
          checkRun({ name: "odd-job", status: "COMPLETED", conclusion: "NOVEL" }),
        ],
      }),
    );
    expect(status.ci).toBe("unknown");
    expect(status.ready).toBe(false);
  });

  it("blocks on REVIEW_REQUIRED", () => {
    const status = summarizePullRequest(readyPullRequest({ reviewDecision: "REVIEW_REQUIRED" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/review required/i);
  });

  it("blocks on CHANGES_REQUESTED", () => {
    const status = summarizePullRequest(readyPullRequest({ reviewDecision: "CHANGES_REQUESTED" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/changes requested/i);
  });

  it("never marks an unrecognized review decision ready", () => {
    const status = summarizePullRequest(readyPullRequest({ reviewDecision: "MAGICAL" }));
    expect(status.ready).toBe(false);
    expect(status.reasons.join("\n")).toMatch(/review state/i);
  });
});

// --- filterPullRequests ---

describe("filterPullRequests", () => {
  const mineReady = readyPullRequest({ number: 1, author: { login: "octocat" } });
  const othersNeedsReview = readyPullRequest({
    number: 2,
    author: { login: "alice" },
    reviewDecision: "REVIEW_REQUIRED",
  });
  const othersFailedCi = readyPullRequest({
    number: 3,
    author: { login: "bob" },
    statusCheckRollup: [checkRun({ name: "ci", conclusion: "FAILURE" })],
  });
  const noReviewRequirement = readyPullRequest({
    number: 4,
    author: { login: "carol" },
    reviewDecision: "",
  });
  const prs = [mineReady, othersNeedsReview, othersFailedCi, noReviewRequirement];

  it("compares GitHub logins without case sensitivity", () => {
    expect(filterPullRequests(prs, "OctoCat", "mine", "all").map((pr) => pr.number)).toEqual([1]);
  });

  it("filters by author mine", () => {
    const result = filterPullRequests(prs, "octocat", "mine", "all");
    expect(result.map((pr) => pr.number)).toEqual([1]);
  });

  it("filters by author others and includes PRs with a null author", () => {
    const withNullAuthor = [...prs, readyPullRequest({ number: 5, author: null })];
    const result = filterPullRequests(withNullAuthor, "octocat", "others", "all");
    expect(result.map((pr) => pr.number)).toEqual([2, 3, 4, 5]);
  });

  it("keeps all PRs and their order for the all filters", () => {
    const result = filterPullRequests(prs, "octocat", "all", "all");
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3, 4]);
  });

  it("matches the approvals filter on REVIEW_REQUIRED only, not on an absent requirement", () => {
    const result = filterPullRequests(prs, "octocat", "all", "approvals");
    expect(result.map((pr) => pr.number)).toEqual([2]);
  });

  it("matches the failed-ci filter on failed checks only", () => {
    const pendingCi = readyPullRequest({
      number: 6,
      author: { login: "dave" },
      statusCheckRollup: [checkRun({ status: "IN_PROGRESS", conclusion: "" })],
    });
    const result = filterPullRequests([...prs, pendingCi], "octocat", "all", "failed-ci");
    expect(result.map((pr) => pr.number)).toEqual([3]);
  });

  it("matches the ready filter on summarizePullRequest().ready", () => {
    const result = filterPullRequests(prs, "octocat", "all", "ready");
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });

  it("combines the author and status filters", () => {
    const otherFailedMine = readyPullRequest({
      number: 7,
      author: { login: "octocat" },
      statusCheckRollup: [checkRun({ name: "ci", conclusion: "TIMED_OUT" })],
    });
    const result = filterPullRequests([...prs, otherFailedMine], "octocat", "others", "failed-ci");
    expect(result.map((pr) => pr.number)).toEqual([3]);
  });
});
