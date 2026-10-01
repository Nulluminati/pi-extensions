import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import githubExtension from "../../extensions/github/github.ts";
import { buildActionPrompt } from "../../extensions/github/src/actions.ts";
import { renderGitHubBody } from "../../extensions/github/src/body.ts";
import type { GitHubSnapshot, PullRequestDetail } from "../../extensions/github/src/client.ts";
import { createGitHubOverlay } from "../../extensions/github/src/overlay.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

const repository = {
  nameWithOwner: "team/repo",
  url: "https://github.com/team/repo",
  host: "github.com",
};
const pullRequest: PullRequestDetail = {
  number: 42,
  title: "Fix tests",
  url: "https://github.com/team/repo/pull/42",
  state: "OPEN",
  isDraft: false,
  author: { login: "me" },
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
  ],
  body: "Description",
  headRefName: "fix-tests",
  baseRefName: "main",
  comments: [
    {
      author: "reviewer",
      body: "Add a test",
      createdAt: "2026-01-01",
      url: "https://github.com/comment",
      kind: "inline",
      path: "test.ts",
      line: 5,
    },
  ],
};
const snapshot: GitHubSnapshot = {
  repository,
  viewer: "me",
  pullRequests: [pullRequest],
  limited: false,
  totalCount: 1,
  nextCursor: null,
};
const overlays: Array<{ dispose(): void }> = [];

function keybindings() {
  return {
    matches: (data: string, action: string) =>
      ({
        "tui.select.up": "\x1b[A",
        "tui.select.down": "\x1b[B",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\x1b",
        "tui.input.tab": "\t",
      })[action] === data,
  };
}

function setupOverlay(data = snapshot) {
  const ctx = createMockCommandContext();
  const client = {
    load: vi.fn().mockResolvedValue(data),
    detail: vi.fn().mockResolvedValue(pullRequest),
  };
  const done = vi.fn();
  const onError = vi.fn();
  const tui = { requestRender: vi.fn(), terminal: { rows: 32 } };
  const overlay = createGitHubOverlay({
    client,
    tui,
    theme: ctx.ui.theme,
    keybindings: keybindings(),
    done,
    onError,
  });
  overlays.push(overlay);
  return { overlay, client, done, tui, onError };
}

async function loaded() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  for (const overlay of overlays) overlay.dispose();
  overlays.length = 0;
  vi.useRealTimers();
});

describe("GitHub body rendering", () => {
  it("renders Dependabot release notes without HTML element tags", () => {
    const body =
      '<details>\n<summary>Release notes</summary>\n<p><em>Sourced from <a href="https://example.com/releases">release notes</a>.</em></p>\n<blockquote><h2>v6.30.4</h2><p>Fix routing &amp; navigation.</p></blockquote>\n</details>';
    const text = renderGitHubBody(body, 100).join("\n");
    expect(text).toContain("Release notes");
    expect(text).toContain("v6.30.4");
    expect(text).toContain("Fix routing & navigation.");
    expect(text).toContain("https://example.com/releases");
    expect(text).not.toMatch(/<\/?(?:details|summary|p|em|a|blockquote|h2)\b/);
    expect(text).not.toContain("&amp;");
  });

  it("renders Markdown formatting rather than showing emphasis and link syntax", () => {
    const text = renderGitHubBody(
      "**Important**: [release notes](https://example.com/releases)\n\n- Update `react-router`",
      100,
    ).join("\n");
    expect(text).toContain("Important");
    expect(text).toContain("release notes");
    expect(text).toContain("Update react-router");
    expect(text).not.toContain("**Important**");
    expect(text).not.toContain("[release notes](");
  });

  it("preserves literal HTML inside fenced and inline code", () => {
    const body =
      "Hide <details>wrappers</details>, but preserve `<details>` as code.\n\n```html\n<summary>literal</summary>\n<p>&amp;</p>\n```\n\n~~~html\n<div>literal</div>\n~~~";
    const text = renderGitHubBody(body, 100).join("\n");
    expect(text).toContain("Hide wrappers");
    expect(text).toContain("preserve <details> as code");
    expect(text).toContain("<summary>literal</summary>");
    expect(text).toContain("<p>&amp;</p>");
    expect(text).toContain("<div>literal</div>");
  });

  it("keeps adjacent indented code lines together", () => {
    const text = renderGitHubBody("Code:\n\n    <p>one</p>\n    <p>two</p>", 100)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(text).toContain("<p>one</p>\n  <p>two</p>");
  });

  it("preserves escaped tags, comparisons, and Markdown autolinks", () => {
    const text = renderGitHubBody(
      "&lt;Component&gt;: x < y and y > z.\n\n<https://example.com/docs>",
      100,
    ).join("\n");
    expect(text).toContain("<Component>");
    expect(text).toContain("x < y and y > z");
    expect(text).toContain("https://example.com/docs");
  });

  it("removes hidden HTML and terminal controls, including encoded controls", () => {
    const body =
      "<!-- private note --><script>alert(1)</script><style>p {color:red}</style><p>Visible &#27;[2J &#x1f600; &amp;lt;</p>";
    const text = renderGitHubBody(body, 100).join("\n");
    expect(text).toContain("Visible");
    expect(text).toContain("😀");
    expect(text).toContain("&lt;");
    expect(text).not.toContain("private note");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("\x1b");
  });
});

describe("GitHub overlay", () => {
  it("loads inside a centered overlay and shows review and CI status", async () => {
    const { overlay, client } = setupOverlay();
    expect(overlay.render(100).join("\n")).toContain("Loading");
    await loaded();
    expect(client.load).toHaveBeenCalledWith({ author: "all", status: "all", search: "" });
    const text = overlay.render(100).join("\n");
    expect(text).toContain("team/repo");
    expect(text).toContain("#42 Fix tests");
    expect(text).toContain("Approvals");
    expect(text).toContain("failed");
  });

  it("combines author and status filters and preserves them after refresh", async () => {
    const { overlay, client } = setupOverlay({
      ...snapshot,
      pullRequests: [
        pullRequest,
        { ...pullRequest, number: 43, title: "Other PR", author: { login: "other" } },
      ],
    });
    await loaded();
    overlay.handleInput("\x06"); // Ctrl+F
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r"); // Mine
    await loaded();
    expect(client.load).toHaveBeenLastCalledWith({ author: "mine", status: "all", search: "" });
    expect(overlay.render(100).join("\n")).toContain("Mine");
    expect(overlay.render(100).join("\n")).not.toContain("Other PR");
    overlay.handleInput("\x06");
    for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
    overlay.handleInput("\r"); // Failed CI
    await loaded();
    expect(client.load).toHaveBeenLastCalledWith({
      author: "mine",
      status: "failed-ci",
      search: "",
    });
    expect(overlay.render(100).join("\n")).toContain("Failed CI");
    overlay.handleInput("\x12");
    await loaded();
    expect(client.load).toHaveBeenCalledTimes(4);
    expect(overlay.render(100).join("\n")).toContain("Mine");
    expect(overlay.render(100).join("\n")).toContain("Failed CI");
  });

  it("opens comments and returns the selected action", async () => {
    const { overlay, client, done } = setupOverlay();
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    expect(client.detail).toHaveBeenCalledWith(repository, 42);
    expect(overlay.render(100).join("\n")).toContain("Description");
    expect(overlay.render(100).join("\n")).not.toContain("Add a test");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).toContain("Add a test");
    expect(overlay.render(100).join("\n")).toContain("test.ts:5");
    overlay.handleInput("\x01"); // Ctrl+A
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ action: "ci", repository, pullRequest });
  });

  it("formats both descriptions and comments without changing the agent snapshot", async () => {
    const { overlay, client, done } = setupOverlay();
    const detail = {
      ...pullRequest,
      body: "<details><summary>Description</summary><p>Readable body</p></details>",
      comments: [
        {
          ...pullRequest.comments[0],
          author: "reviewer",
          body: "<p>Readable <strong>comment</strong></p>",
          createdAt: "now",
          url: "https://github.com/comment",
          kind: "discussion" as const,
        },
      ],
    };
    client.detail.mockResolvedValue(detail);
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    const text = overlay.render(100).join("\n");
    expect(text).toContain("Readable body");
    expect(text).not.toContain("Readable comment");
    expect(text).not.toContain("<details>");
    overlay.handleInput("\t");
    const comments = overlay.render(100).join("\n");
    expect(comments).toContain("Readable comment");
    expect(comments).not.toContain("Readable body");
    expect(comments).not.toContain("<strong>");
    overlay.handleInput("\x01");
    overlay.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ action: "review", repository, pullRequest: detail });
    expect(buildActionPrompt({ action: "review", repository, pullRequest: detail })).toContain(
      "<details>",
    );
  });

  it("cancels loading without rendering or selecting after late results", async () => {
    const { overlay, client, done, tui } = setupOverlay();
    let resolveDetail: (value: PullRequestDetail) => void = () => {};
    client.detail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    await loaded();
    overlay.handleInput("\r");
    overlay.handleInput("\x1b"); // Back to list
    expect(overlay.render(100).join("\n")).toContain("#42 Fix tests");
    overlay.handleInput("\x1b"); // Close
    expect(done).toHaveBeenCalledWith(null);
    tui.requestRender.mockClear();
    resolveDetail(pullRequest);
    await loaded();
    expect(tui.requestRender).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("reports failures inside the overlay and retries", async () => {
    const { overlay, client, onError } = setupOverlay();
    await loaded();
    client.detail.mockRejectedValueOnce(new Error("Permission denied"));
    overlay.handleInput("\r");
    await loaded();
    expect(overlay.render(80).join("\n")).toContain("Permission denied");
    expect(onError).toHaveBeenCalledWith("Permission denied");
    overlay.handleInput("\x12");
    await loaded();
    expect(overlay.render(80).join("\n")).toContain("Description");
  });

  it("shows action-specific empty search text", async () => {
    const { overlay } = setupOverlay();
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    overlay.handleInput("\x01");
    for (const letter of "not-an-action") overlay.handleInput(letter);
    expect(overlay.render(100).join("\n")).toContain("No matching actions");
  });

  it("ignores responses after disposal and supports invalidation", async () => {
    const { overlay, done, tui } = setupOverlay();
    overlay.dispose();
    tui.requestRender.mockClear();
    await loaded();
    overlay.handleInput("\r");
    expect(tui.requestRender).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    const other = setupOverlay();
    await loaded();
    expect(() => other.overlay.invalidate()).not.toThrow();
  });

  it("scrolls comments with arrow and page keys and returns from actions", async () => {
    const { overlay, client, done } = setupOverlay();
    client.detail.mockResolvedValue({
      ...pullRequest,
      body: Array.from({ length: 60 }, (_, i) => `Description line ${i + 1}`).join("\n"),
    });
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    expect(overlay.render(100).join("\n")).toContain("Lines 1-");
    overlay.handleInput("\x1b[B");
    expect(overlay.render(100).join("\n")).toContain("Lines 2-");
    overlay.handleInput("\x1b[6~");
    expect(overlay.render(100).join("\n")).not.toContain("Lines 2-");
    overlay.handleInput("\x1b[5~");
    expect(overlay.render(100).join("\n")).toContain("Lines 2-");
    overlay.handleInput("\x1b[A");
    expect(overlay.render(100).join("\n")).toContain("Lines 1-");
    overlay.handleInput("\x01");
    overlay.handleInput("\x1b");
    expect(overlay.render(100).join("\n")).toContain("Lines 1-");
    expect(done).not.toHaveBeenCalled();
  });

  it("shows empty results and GitHub's search limit", async () => {
    const { overlay } = setupOverlay({
      ...snapshot,
      pullRequests: [],
      limited: true,
      totalCount: 5000,
    });
    await loaded();
    expect(overlay.render(100).join("\n")).toContain("No matching open pull requests");
    expect(overlay.render(100).join("\n")).toContain("1,000");
    expect(overlay.render(100).join("\n")).toContain("Narrow");
  });

  it("loads the next server page and reuses previous pages", async () => {
    const { overlay, client } = setupOverlay({
      ...snapshot,
      totalCount: 60,
      nextCursor: "cursor-1",
    });
    await loaded();
    const second = {
      ...snapshot,
      pullRequests: [{ ...pullRequest, number: 43, title: "Page two" }],
      totalCount: 60,
      nextCursor: "cursor-2",
    };
    client.load.mockResolvedValueOnce(second);
    overlay.handleInput("\x1b[6~");
    await loaded();
    expect(client.load).toHaveBeenLastCalledWith({
      author: "all",
      status: "all",
      search: "",
      after: "cursor-1",
    });
    expect(overlay.render(100).join("\n")).toContain("Page 2");
    expect(overlay.render(100).join("\n")).toContain("Page two");
    expect(overlay.render(100).join("\n")).not.toContain("#42 Fix tests");
    overlay.handleInput("\x1b[5~");
    expect(overlay.render(100).join("\n")).toContain("Page 1");
    overlay.handleInput("\x1b[6~");
    expect(overlay.render(100).join("\n")).toContain("Page two");
    expect(client.load).toHaveBeenCalledTimes(2);
    overlay.handleInput("\x12");
    await loaded();
    expect(overlay.render(100).join("\n")).toContain("Page 1");
    expect(client.load).toHaveBeenLastCalledWith({ author: "all", status: "all", search: "" });
  });

  it("distinguishes ready candidates from locally verified matches and continues across empty pages", async () => {
    const { overlay, client } = setupOverlay();
    await loaded();
    client.load.mockResolvedValueOnce({ ...snapshot, totalCount: 60, nextCursor: "candidate-1" });
    overlay.handleInput("\x06");
    for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    await loaded();
    const empty = overlay.render(100).join("\n");
    expect(empty).toContain("GitHub candidates");
    expect(empty).toContain("No ready pull requests on this page");
    client.load.mockResolvedValueOnce({
      ...snapshot,
      pullRequests: [
        {
          ...pullRequest,
          number: 43,
          title: "Ready candidate",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      ],
      totalCount: 60,
    });
    overlay.handleInput("\x1b[6~");
    await loaded();
    expect(client.load).toHaveBeenLastCalledWith({
      author: "all",
      status: "ready",
      search: "",
      after: "candidate-1",
    });
    expect(overlay.render(100).join("\n")).toContain("#43 Ready candidate");
  });

  it("stops pagination at GitHub's 1,000-result limit even if another cursor remains", async () => {
    const page = (index: number): GitHubSnapshot => ({
      ...snapshot,
      totalCount: 1001,
      limited: true,
      nextCursor: `cursor-${index + 1}`,
      pullRequests: Array.from({ length: 25 }, (_, offset) => ({
        ...pullRequest,
        number: index * 25 + offset + 1,
      })),
    });
    const { overlay, client } = setupOverlay(page(0));
    await loaded();
    for (let index = 1; index < 40; index++) {
      client.load.mockResolvedValueOnce(page(index));
      overlay.handleInput("\x1b[6~");
      await loaded();
    }
    expect(overlay.render(100).join("\n")).toContain("Page 40");
    expect(client.load).toHaveBeenCalledTimes(40);
    overlay.handleInput("\x1b[6~");
    expect(client.load).toHaveBeenCalledTimes(40);
    overlay.handleInput("\x1b[5~");
    overlay.handleInput("\x1b[6~");
    expect(overlay.render(100).join("\n")).toContain("Page 40");
    expect(client.load).toHaveBeenCalledTimes(40);
  });

  it("does not fetch outside the first or last page", async () => {
    const { overlay, client } = setupOverlay();
    await loaded();
    overlay.handleInput("\x1b[5~");
    overlay.handleInput("\x1b[6~");
    expect(client.load).toHaveBeenCalledTimes(1);
  });

  it("retries a failed next page with the same cursor", async () => {
    const { overlay, client, onError } = setupOverlay({
      ...snapshot,
      nextCursor: "cursor-1",
      totalCount: 60,
    });
    await loaded();
    client.load.mockRejectedValueOnce(new Error("Page unavailable"));
    overlay.handleInput("\x1b[6~");
    await loaded();
    expect(onError).toHaveBeenCalledWith("Page unavailable");
    expect(overlay.render(100).join("\n")).toContain("Page unavailable");
    overlay.handleInput("\x12");
    await loaded();
    expect(client.load).toHaveBeenLastCalledWith({
      author: "all",
      status: "all",
      search: "",
      after: "cursor-1",
    });
    expect(overlay.render(100).join("\n")).toContain("Page 2");
  });

  it("debounces search against GitHub and displays matches outside the old page", async () => {
    vi.useFakeTimers();
    const { overlay, client, done } = setupOverlay();
    await loaded();
    client.load.mockResolvedValueOnce({
      ...snapshot,
      pullRequests: [{ ...pullRequest, number: 900, title: "Outside old page" }],
    });
    for (const letter of "remote body") overlay.handleInput(letter);
    overlay.handleInput("\r");
    expect(client.detail).not.toHaveBeenCalled();
    expect(client.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.load).toHaveBeenLastCalledWith({
      author: "all",
      status: "all",
      search: "remote body",
    });
    const text = overlay.render(100).join("\n");
    expect(text).toContain("remote body");
    expect(text).toContain("#900 Outside old page");
    expect(text).not.toContain("#42 Fix tests");
    expect(done).not.toHaveBeenCalled();
  });

  it("ignores an old search response while a newer query is pending", async () => {
    vi.useFakeTimers();
    const { overlay, client } = setupOverlay();
    await loaded();
    let resolveOld: (value: GitHubSnapshot) => void = () => {};
    client.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    overlay.handleInput("a");
    await vi.advanceTimersByTimeAsync(300);
    client.load.mockResolvedValueOnce({
      ...snapshot,
      pullRequests: [{ ...pullRequest, number: 901, title: "Latest result" }],
    });
    overlay.handleInput("b");
    resolveOld({ ...snapshot, pullRequests: [{ ...pullRequest, title: "Stale result" }] });
    await loaded();
    expect(overlay.render(100).join("\n")).not.toContain("Stale result");
    await vi.advanceTimersByTimeAsync(300);
    expect(client.load).toHaveBeenLastCalledWith({ author: "all", status: "all", search: "ab" });
    expect(overlay.render(100).join("\n")).toContain("Latest result");
  });

  it("clears pending searches when the overlay closes", async () => {
    vi.useFakeTimers();
    const { overlay, client, done } = setupOverlay();
    await loaded();
    overlay.handleInput("x");
    overlay.handleInput("\x1b");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.load).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(null);
  });

  it("keeps comments, checks, and the description on separate tabs", async () => {
    const { overlay, client } = setupOverlay();
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    expect(overlay.render(100).join("\n")).not.toContain("Add a test");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).toContain("Add a test");
    overlay.handleInput("\t");
    const checks = overlay.render(100).join("\n");
    expect(checks).toContain("FAILURE");
    expect(checks).not.toContain("Add a test");
    expect(client.detail).toHaveBeenCalledTimes(1);
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).not.toContain("FAILURE");
    overlay.handleInput("\x1b[Z");
    expect(overlay.render(100).join("\n")).toContain("FAILURE");
    client.detail.mockResolvedValueOnce({
      ...pullRequest,
      statusCheckRollup: [{ name: "new check", state: "SUCCESS" }],
    });
    overlay.handleInput("\x12");
    await loaded();
    expect(overlay.render(100).join("\n")).toContain("new check");
    expect(overlay.render(100).join("\n")).not.toContain("FAILURE");
  });

  it("preserves each tab's scroll position and handles empty comments and checks", async () => {
    const { overlay, client } = setupOverlay();
    client.detail.mockResolvedValue({
      ...pullRequest,
      body: Array.from({ length: 60 }, (_, i) => `Body ${i}`).join("\n"),
      comments: [],
      statusCheckRollup: null,
    });
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    overlay.render(100);
    overlay.handleInput("\x1b[B");
    expect(overlay.render(100).join("\n")).toContain("Lines 2-");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).toContain("No comments.");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).toContain("No checks.");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\n")).toContain("Lines 2-");
  });

  it("removes terminal control sequences from GitHub text and fits small terminals", async () => {
    const { overlay, client } = setupOverlay();
    client.detail.mockResolvedValue({
      ...pullRequest,
      body: "Hello\x1b[2J\x1b]52;c;payload\x07\rWorld",
    });
    await loaded();
    overlay.handleInput("\r");
    await loaded();
    expect(overlay.render(80).join("\n")).not.toContain("\x1b");
    expect(overlay.render(80).join("\n")).not.toContain("payload");
    for (const width of [0, 1, 3, 20, 80]) {
      const lines = overlay.render(width);
      expect(lines.length).toBeLessThanOrEqual(25);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe("GitHub action requests", () => {
  it.each(["review", "ci", "comments"] as const)(
    "builds a bounded %s request with explicit safety limits",
    (action) => {
      const prompt = buildActionPrompt({ action, repository, pullRequest });
      expect(prompt).toContain("https://github.com/team/repo/pull/42");
      expect(prompt).toContain("untrusted");
      expect(prompt).toContain("Ask before");
      expect(prompt).toContain("branch");
      expect(prompt).toContain("gh");
      expect(prompt.length).toBeLessThan(20000);
      if (action === "review") expect(prompt).toContain("Do not edit");
      else expect(prompt).toContain("local fixes");
    },
  );

  it("treats comment bodies as data and limits large snapshots", () => {
    const prompt = buildActionPrompt({
      action: "comments",
      repository,
      pullRequest: {
        ...pullRequest,
        body: "x".repeat(50000),
        comments: [
          {
            ...pullRequest.comments[0],
            author: "reviewer",
            body: "z".repeat(50000),
            createdAt: "now",
            url: "url",
            kind: "discussion",
          },
        ],
      },
    });
    expect(prompt.length).toBeLessThan(20000);
    expect(prompt).toContain("truncated");
  });
});

describe("/github command", () => {
  it.each(["rpc", "print", "json"] as const)(
    "does not open an overlay in %s mode",
    async (mode) => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.mode = mode;
      await githubExtension(pi);
      await pi.registerCommand.mock.calls[0][1].handler("", ctx);
      expect(pi.exec).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    },
  );

  it("does not open without UI", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.hasUI = false;
    await githubExtension(pi);
    await pi.registerCommand.mock.calls[0][1].handler("", ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it.each([true, false])("sends a selected action when idle=%s", async (idle) => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.isIdle.mockReturnValue(idle);
    ctx.ui.custom.mockResolvedValue({ action: "ci", repository, pullRequest });
    await githubExtension(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ description: expect.any(String) }),
    );
    await pi.registerCommand.mock.calls[0][1].handler("", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlay: true }),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      buildActionPrompt({ action: "ci", repository, pullRequest }),
      { deliverAs: "followUp" },
    );
  });

  it("notifies the user when repository loading fails inside the overlay", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "not logged in", code: 1, killed: false });
    const notified = new Promise<void>((resolve) => {
      ctx.ui.notify.mockImplementation(() => resolve());
    });
    ctx.ui.custom.mockImplementation(async (factory) => {
      const component = await factory(
        { requestRender: vi.fn(), terminal: { rows: 30 } },
        ctx.ui.theme,
        keybindings(),
        vi.fn(),
      );
      await notified;
      component.dispose?.();
      return null;
    });
    await githubExtension(pi);
    await pi.registerCommand.mock.calls[0][1].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gh auth login"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("requires a model to start an agent action", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.model = undefined;
    ctx.ui.custom.mockResolvedValue({ action: "review", repository, pullRequest });
    await githubExtension(pi);
    await pi.registerCommand.mock.calls[0][1].handler("", ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "GitHub: Select a model before starting an agent action.",
      "error",
    );
  });

  it("does not send a cancelled selection and reports overlay failures", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await githubExtension(pi);
    const handler = pi.registerCommand.mock.calls[0][1].handler;
    ctx.ui.custom.mockResolvedValue(null);
    await handler("", ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    ctx.ui.custom.mockRejectedValueOnce(new Error("Overlay failure"));
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("GitHub: Overlay failure", "error");
  });

  it("prevents duplicate overlays and releases the guard after errors", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await githubExtension(pi);
    const handler = pi.registerCommand.mock.calls[0][1].handler;
    let finish: (value: null) => void = () => {};
    ctx.ui.custom.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = handler("", ctx);
    await handler("", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    finish(null);
    await first;
    ctx.ui.custom.mockResolvedValue(null);
    await handler("", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
  });
});
