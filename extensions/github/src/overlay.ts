import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SearchableSelect, type SearchableSelectOptions } from "../../../lib/searchable-select.ts";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { GITHUB_ACTIONS, type GitHubActionSelection } from "./actions.ts";
import { renderGitHubBody } from "./body.ts";
import type { GitHubClient, GitHubSnapshot, PullRequestDetail } from "./client.ts";
import {
  type AuthorFilter,
  filterPullRequests,
  type StatusFilter,
  summarizePullRequest,
} from "./status.ts";
import { sanitizeGitHubText } from "./text.ts";

interface OverlayOptions {
  client: GitHubClient;
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: SearchableSelectOptions["theme"];
  keybindings: SearchableSelectOptions["keybindings"];
  done(value: GitHubActionSelection | null): void;
  onError?(message: string): void;
}

type Screen = "list" | "filters" | "detail" | "actions";

const AUTHOR_LABELS: Record<AuthorFilter, string> = {
  all: "All authors",
  mine: "Mine",
  others: "Others",
};
const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All statuses",
  approvals: "Waiting on approvals",
  "failed-ci": "Failed CI",
  ready: "Ready to merge",
};
const FILTER_ITEMS = [
  { value: "author:all", label: "All authors" },
  { value: "author:mine", label: "Mine" },
  { value: "author:others", label: "Others" },
  { value: "status:all", label: "All statuses" },
  { value: "status:approvals", label: "Waiting on approvals" },
  { value: "status:failed-ci", label: "Failed CI" },
  { value: "status:ready", label: "Ready to merge" },
];

function singleLine(text: string): string {
  return sanitizeGitHubText(text).replace(/\n/g, " ");
}

/** One interaction owns its requests. Late responses cannot change a closed or replaced screen. */
export function createGitHubOverlay(options: OverlayOptions) {
  const { client, tui, theme, keybindings, done } = options;
  let screen: Screen = "list";
  let snapshot: GitHubSnapshot | undefined;
  let detail: PullRequestDetail | undefined;
  let selectedNumber: number | undefined;
  let author: AuthorFilter = "all";
  let status: StatusFilter = "all";
  let selector: SearchableSelect | undefined;
  let selectorRows = 0;
  let focused = false;
  let loading = "";
  let error = "";
  let generation = 0;
  let disposed = false;
  let scroll = 0;
  let maxScroll = 0;
  let detailLines: string[] = [];
  let detailWidth = -1;

  function requestRender() {
    if (!disposed) tui.requestRender();
  }

  function finish(value: GitHubActionSelection | null) {
    if (disposed) return;
    disposed = true;
    generation++;
    done(value);
  }

  function panelRows() {
    return Math.max(3, Math.floor((tui.terminal?.rows ?? 30) * 0.8) - 2);
  }

  function buildSelector() {
    selectorRows = panelRows();
    const maxVisible = Math.max(1, Math.min(10, selectorRows - 8));
    let items: SearchableSelectOptions["items"] = [];
    let onSelect: (value: string) => void = () => {};
    if (screen === "list" && snapshot) {
      items = filterPullRequests(snapshot.pullRequests, snapshot.viewer, author, status).map(
        (pr) => {
          const summary = summarizePullRequest(pr);
          const state = summary.ready ? "Ready to merge" : summary.reasons.join(", ");
          return {
            value: String(pr.number),
            label: `#${pr.number} ${singleLine(pr.title)}`,
            description: `${summary.review} | CI ${summary.ci} | ${state} | @${singleLine(pr.author?.login ?? "deleted")}`,
          };
        },
      );
      onSelect = (value) => {
        selectedNumber = Number(value);
        screen = "detail";
        detail = undefined;
        scroll = 0;
        void loadDetail();
      };
    } else if (screen === "filters") {
      items = FILTER_ITEMS;
      onSelect = (value) => {
        const [kind, filter] = value.split(":");
        if (kind === "author" && (filter === "all" || filter === "mine" || filter === "others"))
          author = filter;
        if (
          kind === "status" &&
          (filter === "all" ||
            filter === "approvals" ||
            filter === "failed-ci" ||
            filter === "ready")
        )
          status = filter;
        screen = "list";
        buildSelector();
      };
    } else if (screen === "actions") {
      items = GITHUB_ACTIONS.map((action) => ({ ...action }));
      onSelect = (value) => {
        const action = GITHUB_ACTIONS.find((candidate) => candidate.value === value);
        if (action && snapshot && detail)
          finish({ action: action.value, repository: snapshot.repository, pullRequest: detail });
      };
    }
    selector = new SearchableSelect(
      {
        tui,
        theme,
        keybindings,
        items,
        title: "GitHub",
        maxVisible,
        noMatchText:
          screen === "actions"
            ? "No matching actions"
            : screen === "filters"
              ? "No matching filters"
              : "No matching open pull requests",
        hint: formatStyledKeyHints(theme, [
          ["type", "search"],
          ["↑↓", "select"],
          ["enter", "open"],
          ["esc", "back"],
        ]),
        onSelect,
        onCancel: back,
      },
      false,
    );
    selector.focused = focused;
  }

  function back() {
    generation++;
    loading = "";
    error = "";
    if (screen === "list") {
      finish(null);
      return;
    }
    screen = screen === "actions" ? "detail" : "list";
    buildSelector();
    requestRender();
  }

  async function loadList() {
    const request = ++generation;
    loading = "Loading open pull requests...";
    error = "";
    requestRender();
    try {
      const result = await client.load();
      if (disposed || request !== generation) return;
      snapshot = result;
      buildSelector();
    } catch (failure) {
      if (disposed || request !== generation) return;
      error = singleLine(failure instanceof Error ? failure.message : String(failure));
      options.onError?.(error);
    } finally {
      if (!disposed && request === generation) {
        loading = "";
        requestRender();
      }
    }
  }

  async function loadDetail() {
    if (!snapshot || selectedNumber === undefined) return;
    const request = ++generation;
    loading = `Loading pull request #${selectedNumber}...`;
    error = "";
    requestRender();
    try {
      const result = await client.detail(snapshot.repository, selectedNumber);
      if (disposed || request !== generation) return;
      detail = result;
      detailWidth = -1;
      scroll = 0;
    } catch (failure) {
      if (disposed || request !== generation) return;
      error = singleLine(failure instanceof Error ? failure.message : String(failure));
      options.onError?.(error);
    } finally {
      if (!disposed && request === generation) {
        loading = "";
        requestRender();
      }
    }
  }

  function renderDetail(width: number, rows: number): string[] {
    if (!detail) return [];
    if (detailWidth !== width) {
      const summary = summarizePullRequest(detail);
      const wrap = (text: string) =>
        text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
      detailLines = [
        `#${detail.number} ${singleLine(detail.title)}`,
        singleLine(detail.url),
        `@${singleLine(detail.author?.login ?? "deleted")} | ${singleLine(detail.headRefName)} → ${singleLine(detail.baseRefName)}`,
        `${summary.review} | CI ${summary.ci}`,
        summary.ready ? "Ready to merge" : `Waiting: ${summary.reasons.join(", ")}`,
        "",
      ].flatMap(wrap);
      detailLines.push(
        ...renderGitHubBody(detail.body, width),
        "",
        `Comments (${detail.comments.length})`,
      );
      if (detail.comments.length === 0) detailLines.push("No comments.");
      for (const comment of detail.comments) {
        detailLines.push(
          "",
          ...wrap(
            `${comment.kind} | @${singleLine(comment.author)} | ${singleLine(comment.createdAt)}${comment.state ? ` | ${singleLine(comment.state)}` : ""}`,
          ),
        );
        if (comment.path)
          detailLines.push(
            ...wrap(`${singleLine(comment.path)}${comment.line ? `:${comment.line}` : ""}`),
          );
        detailLines.push(
          ...renderGitHubBody(comment.body, width),
          ...wrap(singleLine(comment.url)),
        );
      }
      detailWidth = width;
    }
    const visible = Math.max(1, rows - 2);
    maxScroll = Math.max(0, detailLines.length - visible);
    scroll = Math.min(scroll, maxScroll);
    return [
      ...detailLines.slice(scroll, scroll + visible),
      theme.fg(
        "dim",
        `Lines ${scroll + 1}-${Math.min(scroll + visible, detailLines.length)} of ${detailLines.length}`,
      ),
      formatStyledKeyHints(theme, [
        ["↑↓/pgup/pgdn", "scroll"],
        ["ctrl+a", "actions"],
        ["ctrl+r", "refresh"],
        ["esc", "back"],
      ]),
    ];
  }

  void loadList();

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      if (selector) selector.focused = value;
    },
    render(width: number): string[] {
      if (width <= 0) return [];
      const bodyRows = panelRows() - 2;
      const contentWidth = modalContentWidth(width);
      let lines: string[];
      if (loading || error) {
        lines = [
          theme.fg(error ? "error" : "muted", error || loading),
          formatStyledKeyHints(theme, [
            ["ctrl+r", "retry"],
            ["esc", "back"],
          ]),
        ];
      } else if (screen === "detail") {
        lines = renderDetail(contentWidth, bodyRows);
      } else {
        if (!selector || selectorRows !== panelRows()) buildSelector();
        const header =
          screen === "filters"
            ? "Choose an author or status filter."
            : screen === "actions"
              ? "Start an agent action. Local fixes are permitted; remote writes require approval."
              : `${AUTHOR_LABELS[author]} | ${STATUS_LABELS[status]}`;
        lines = [header];
        if (screen === "list" && snapshot?.limited)
          lines.push(
            theme.fg("warning", "First 100 open pull requests only. Filters apply to this list."),
          );
        lines.push(...(selector?.render(contentWidth) ?? []));
        if (screen === "list")
          lines.push(
            formatStyledKeyHints(theme, [
              ["ctrl+f", "filters"],
              ["ctrl+r", "refresh"],
            ]),
          );
      }
      return renderModalFrame(theme, width, lines.slice(0, bodyRows), {
        title: `GitHub${snapshot ? `: ${singleLine(snapshot.repository.nameWithOwner)}` : ""}`,
        paddingY: 0,
      });
    },
    invalidate() {
      selector?.invalidate();
      detailWidth = -1;
    },
    handleInput(data: string) {
      if (disposed) return;
      if (keybindings.matches(data, "tui.select.cancel")) {
        back();
        return;
      }
      if (data === "\x12" || matchesKey(data, "ctrl+r")) {
        if (loading) return;
        if (screen === "detail") void loadDetail();
        else if (screen === "list") void loadList();
        return;
      }
      if (loading || error) return;
      if (screen === "list" && (data === "\x06" || matchesKey(data, "ctrl+f"))) {
        screen = "filters";
        buildSelector();
      } else if (screen === "detail" && (data === "\x01" || matchesKey(data, "ctrl+a"))) {
        screen = "actions";
        buildSelector();
      } else if (screen === "detail") {
        if (keybindings.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
        else if (keybindings.matches(data, "tui.select.down"))
          scroll = Math.min(maxScroll, scroll + 1);
        else if (matchesKey(data, Key.pageUp))
          scroll = Math.max(0, scroll - Math.max(1, panelRows() - 6));
        else if (matchesKey(data, Key.pageDown))
          scroll = Math.min(maxScroll, scroll + Math.max(1, panelRows() - 6));
      } else selector?.handleInput(data);
      requestRender();
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
