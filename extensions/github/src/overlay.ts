import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SearchableSelect, type SearchableSelectOptions } from "../../../lib/searchable-select.ts";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { GITHUB_ACTIONS, type GitHubActionSelection } from "./actions.ts";
import { renderGitHubBody } from "./body.ts";
import {
  type GitHubClient,
  type GitHubListOptions,
  type GitHubSnapshot,
  PR_PAGE_SIZE,
  PR_SEARCH_LIMIT,
  type PullRequestDetail,
} from "./client.ts";
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
type DetailTab = "description" | "comments" | "checks";
interface ListRequest {
  index: number;
  after?: string;
}
const DETAIL_TABS: DetailTab[] = ["description", "comments", "checks"];
const SEARCH_DELAY_MS = 300;

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
  let tab: DetailTab = "description";
  let tabScroll: Record<DetailTab, number> = { description: 0, comments: 0, checks: 0 };
  let visibleDetailRows = 1;
  let search = "";
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pages: GitHubSnapshot[] = [];
  let pageIndex = 0;
  let retryList: ListRequest = { index: 0 };

  function clearSearchTimer() {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
  }

  function queueSearch(query: string) {
    search = query;
    pages = [];
    pageIndex = 0;
    retryList = { index: 0 };
    generation++;
    clearSearchTimer();
    loading = "Searching GitHub...";
    error = "";
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      void loadList();
    }, SEARCH_DELAY_MS);
    requestRender();
  }

  function requestRender() {
    if (!disposed) tui.requestRender();
  }

  function finish(value: GitHubActionSelection | null) {
    if (disposed) return;
    disposed = true;
    generation++;
    clearSearchTimer();
    done(value);
  }

  function panelRows() {
    return Math.max(3, Math.floor((tui.terminal?.rows ?? 30) * 0.8) - 2);
  }

  function buildSelector() {
    selectorRows = panelRows();
    const maxVisible = Math.max(1, Math.min(10, selectorRows - 10));
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
        if (loading || error) return;
        selectedNumber = Number(value);
        screen = "detail";
        detail = undefined;
        tab = "description";
        tabScroll = { description: 0, comments: 0, checks: 0 };
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
        pages = [];
        pageIndex = 0;
        buildSelector();
        void loadList();
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
        ...(screen === "list" ? { initialQuery: search, onSearchChange: queueSearch } : {}),
        maxVisible,
        noMatchText:
          screen === "actions"
            ? "No matching actions"
            : screen === "filters"
              ? "No matching filters"
              : status === "ready"
                ? "No ready pull requests on this page"
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
    clearSearchTimer();
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

  async function loadList(target: ListRequest = { index: 0 }) {
    clearSearchTimer();
    retryList = target;
    const query: GitHubListOptions = {
      author,
      status,
      search,
      ...(target.after ? { after: target.after } : {}),
    };
    const request = ++generation;
    loading = `Loading pull requests: page ${target.index + 1}...`;
    error = "";
    requestRender();
    try {
      const result = await client.load(query);
      if (disposed || request !== generation) return;
      pages = target.index === 0 ? [result] : [...pages.slice(0, target.index), result];
      pageIndex = target.index;
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

  function changePage(direction: -1 | 1) {
    const index = pageIndex + direction;
    if (index < 0) return;
    const cached = pages[index];
    if (cached) {
      pageIndex = index;
      snapshot = cached;
      buildSelector();
    } else if (direction === 1 && snapshot?.nextCursor && index * PR_PAGE_SIZE < PR_SEARCH_LIMIT) {
      void loadList({ index, after: snapshot.nextCursor });
    }
  }

  function changeTab(direction: -1 | 1) {
    tabScroll[tab] = scroll;
    const index = (DETAIL_TABS.indexOf(tab) + direction + DETAIL_TABS.length) % DETAIL_TABS.length;
    tab = DETAIL_TABS[index] ?? "description";
    scroll = tabScroll[tab];
    detailWidth = -1;
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
      tabScroll = { description: 0, comments: 0, checks: 0 };
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
      detailLines = [];
      if (tab === "description") {
        detailLines = [
          singleLine(detail.url),
          `@${singleLine(detail.author?.login ?? "deleted")} | ${singleLine(detail.headRefName)} → ${singleLine(detail.baseRefName)}`,
          summary.ready ? "Ready to merge" : `Waiting: ${summary.reasons.join(", ")}`,
          "",
        ].flatMap(wrap);
        detailLines.push(...renderGitHubBody(detail.body, width));
      } else if (tab === "comments") {
        if (detail.comments.length === 0) detailLines.push("No comments.");
        for (const comment of detail.comments) {
          detailLines.push(
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
            "",
          );
        }
      } else {
        const checks = detail.statusCheckRollup ?? [];
        if (checks.length === 0) detailLines.push("No checks.");
        for (const check of checks) {
          detailLines.push(
            ...wrap(
              `${singleLine(check.name ?? check.context ?? "Unnamed check")} | ${singleLine(check.conclusion || check.state || check.status || "UNKNOWN")}`,
            ),
          );
          const url = check.detailsUrl || check.targetUrl;
          if (url) detailLines.push(...wrap(singleLine(url)));
          detailLines.push("");
        }
      }
      detailWidth = width;
    }
    const summary = summarizePullRequest(detail);
    const labels: Record<DetailTab, string> = {
      description: "Description",
      comments: `Comments (${detail.comments.length})`,
      checks: `Checks (${detail.statusCheckRollup?.length ?? 0})`,
    };
    const tabs = DETAIL_TABS.map((candidate) =>
      candidate === tab
        ? theme.fg("accent", theme.bold(labels[candidate]))
        : theme.fg("dim", labels[candidate]),
    ).join(" | ");
    const header = [
      truncateToWidth(`#${detail.number} ${singleLine(detail.title)}`, width, ""),
      truncateToWidth(`${summary.review} | CI ${summary.ci}`, width, ""),
      visibleWidth(tabs) <= width
        ? tabs
        : truncateToWidth(
            theme.fg("accent", theme.bold(`${labels[tab]} (${DETAIL_TABS.indexOf(tab) + 1}/3)`)),
            width,
            "",
          ),
    ];
    const visible = Math.max(1, rows - header.length - 2);
    visibleDetailRows = visible;
    maxScroll = Math.max(0, detailLines.length - visible);
    scroll = Math.min(scroll, maxScroll);
    return [
      ...header,
      ...detailLines.slice(scroll, scroll + visible),
      theme.fg(
        "dim",
        `Lines ${scroll + 1}-${Math.min(scroll + visible, detailLines.length)} of ${detailLines.length}`,
      ),
      formatStyledKeyHints(theme, [
        ["tab/shift+tab", "tabs"],
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
      if ((loading || error) && !(screen === "list" && selector)) {
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
        if (screen === "list" && snapshot) {
          lines.push(
            `Page ${pageIndex + 1} | ${snapshot.totalCount} GitHub ${status === "ready" ? "candidates" : "matches"}`,
          );
          if (snapshot.limited)
            lines.push(
              theme.fg(
                "warning",
                `GitHub returns at most ${PR_SEARCH_LIMIT.toLocaleString("en-US")} matches. Narrow the search.`,
              ),
            );
          if (loading || error) lines.push(theme.fg(error ? "error" : "muted", error || loading));
        }
        lines.push(...(selector?.render(contentWidth) ?? []));
        if (screen === "list")
          lines.push(
            formatStyledKeyHints(theme, [
              ["pgup/pgdn", "pages"],
              ["ctrl+f", "filters"],
              ["ctrl+r", error ? "retry" : "refresh"],
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
        else if (screen === "list") void loadList(error ? retryList : { index: 0 });
        return;
      }
      if (loading || error) {
        if (screen === "list" && selector) selector.handleInput(data);
        return;
      }
      if (screen === "list" && (data === "\x06" || matchesKey(data, "ctrl+f"))) {
        screen = "filters";
        buildSelector();
      } else if (screen === "detail" && (data === "\x01" || matchesKey(data, "ctrl+a"))) {
        screen = "actions";
        buildSelector();
      } else if (screen === "list" && matchesKey(data, Key.pageUp)) {
        changePage(-1);
      } else if (screen === "list" && matchesKey(data, Key.pageDown)) {
        changePage(1);
      } else if (screen === "detail") {
        if (matchesKey(data, Key.shift("tab"))) changeTab(-1);
        else if (keybindings.matches(data, "tui.input.tab") || matchesKey(data, "tab"))
          changeTab(1);
        else if (keybindings.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
        else if (keybindings.matches(data, "tui.select.down"))
          scroll = Math.min(maxScroll, scroll + 1);
        else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - visibleDetailRows);
        else if (matchesKey(data, Key.pageDown))
          scroll = Math.min(maxScroll, scroll + visibleDetailRows);
      } else selector?.handleInput(data);
      requestRender();
    },
    dispose() {
      disposed = true;
      generation++;
      clearSearchTimer();
    },
  };
}
