/**
 * The `jobs` tool: list / status / tail / cancel over the registry, plus the
 * focusable overlay panel opened by the user-facing /jobs command.
 */

import { isArrowDown, isArrowUp } from "../../../lib/arrow-keys.ts";
import { PANEL_OVERLAY_OPTIONS } from "../../../lib/overlay-options.ts";
import { renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import {
  elapseMs,
  fmtDuration,
  formatJobLine,
  JOB_STATUS_DISPLAY,
  tailLines,
  truncate,
} from "./format.ts";
import { getJob, type JobRegistry, listJobs } from "./registry.ts";
import { cancelJob, KILL_GRACE_MS } from "./runner.ts";
import type { Job, JobEvents } from "./types.ts";

export interface JobsToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  terminate?: boolean;
  isError?: boolean;
  structuredContent?: {
    jobs: Array<
      Pick<
        Job,
        | "id"
        | "kind"
        | "label"
        | "command"
        | "status"
        | "startedAt"
        | "endedAt"
        | "exitCode"
        | "spoolPath"
      >
    >;
    output?: string;
    error?: string;
  };
}

/** Slice of the TUI the panel needs: re-render on input, and terminal rows
 * for height budgeting. Must mirror the overlay maxHeight enforced in pi-tui
 * (compositeOverlays slices rendered lines to maxHeight) — render what fits
 * ourselves, or the slice drops the bottom border and key hints. */
interface PanelTui {
  requestRender(): void;
  terminal?: { rows?: number };
}

/** OverlayOptions passed to ui.custom in openJobsPanel: 80% of terminal height. */
const MAX_HEIGHT_FRACTION = 0.8;
/** Frame rows outside the body: top border + bottom border. */
const FRAME_BORDER_ROWS = 2;
/** Frame padding rows: 1 above the body + 1 below. */
const FRAME_PADDING_ROWS = 2;

interface PanelUi {
  // Loosely mirrors ExtensionUIContext.custom; any-params keep the factory
  // type compatible in both directions.
  custom?(
    factory: (tui: any, theme: any, keybindings: any, done: (result?: unknown) => void) => unknown,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): unknown;
}

/**
 * Open the interactive jobs panel. User-facing only — invoked by the /jobs
 * command, never from a tool: an agent opening a focusable modal steals the
 * user's keyboard.
 */
export function openJobsPanel(ui: PanelUi, registry: JobRegistry): void {
  if (!ui.custom) return;
  ui.custom(
    (tui: unknown, theme: any, keybindings: any, done: (result?: unknown) => void) =>
      new JobPanel(registry, theme, done, keybindings, tui as PanelTui | null),
    { overlay: true, overlayOptions: PANEL_OVERLAY_OPTIONS },
  );
}

interface JobsActionOptions {
  registry: JobRegistry;
  action: string;
  jobId?: number | undefined;
  lines?: number | undefined;
  events: JobEvents;
}

export async function executeJobsAction(options: JobsActionOptions): Promise<JobsToolResult> {
  const result = await runJobsAction(options);
  const error = typeof result.details?.error === "string" ? result.details.error : undefined;
  const job = options.jobId === undefined ? undefined : getJob(options.registry, options.jobId);
  const jobs = error
    ? []
    : options.action === "list"
      ? listJobs(options.registry)
      : job
        ? [job]
        : [];
  return {
    ...result,
    ...(error ? { isError: true } : {}),
    structuredContent: {
      jobs: jobs.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        command: entry.command,
        status: entry.status,
        startedAt: entry.startedAt,
        ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
        ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
        ...(entry.spoolPath !== undefined ? { spoolPath: entry.spoolPath } : {}),
      })),
      ...(options.action === "tail" && !error
        ? { output: job?.buffer.length ? result.content.map((block) => block.text).join("\n") : "" }
        : {}),
      ...(error ? { error } : {}),
    },
  };
}

async function runJobsAction(options: JobsActionOptions): Promise<JobsToolResult> {
  const { registry, action, events } = options;

  if (action === "list") {
    const jobs = listJobs(registry);
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: "No background jobs or monitors registered." }] };
    }
    return {
      content: [{ type: "text", text: jobs.map(formatJobLine).join("\n") }],
      details: { count: jobs.length },
    };
  }

  const jobId = options.jobId;
  const job: Job | undefined =
    typeof jobId === "number" && Number.isFinite(jobId) ? getJob(registry, jobId) : undefined;

  if (action === "status") {
    if (!job) return errorResult("unknown_job", `No job #${options.jobId}.`);
    return {
      content: [
        {
          type: "text",
          text: `${formatJobLine(job)}\ncommand: ${job.command}\nstarted: ${new Date(job.startedAt).toISOString()}`,
        },
      ],
    };
  }

  if (action === "tail") {
    if (!job) return errorResult("unknown_job", `No job #${options.jobId}.`);
    if (job.buffer.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No output captured for job #${job.id} "${job.label}" yet.`,
          },
        ],
      };
    }
    const lines = Number(options.lines) || 40;
    return { content: [{ type: "text", text: truncate(tailLines(job.buffer, lines)) }] };
  }

  if (action === "cancel") {
    if (!job) return errorResult("unknown_job", `No job #${options.jobId}.`);
    if (job.status !== "running" && job.status !== "cancelling") {
      return {
        content: [
          {
            type: "text",
            text: `Job #${job.id} is already ${job.status} (only running jobs can be cancelled).`,
          },
        ],
      };
    }
    const was = job.status;
    await cancelJob(registry, job);
    // cancelJob mutated job.status across the await; the cast re-widens past
    // the narrowing from the guard above.
    const status = job.status as Job["status"];
    const outcome =
      status === "kill_failed"
        ? `could not be killed within ${KILL_GRACE_MS / 1000}s of SIGKILL (reported as kill_failed — it may still be running as an orphan)`
        : `cancelled (was ${was})`;
    events.onChange();
    return {
      content: [{ type: "text", text: `Job #${job.id} "${job.label}" ${outcome}.` }],
      details: { jobId: job.id, status },
    };
  }

  return errorResult(
    "unknown_action",
    `Unknown action "${action}". Use list, status, tail, or cancel.`,
  );
}

function errorResult(code: string, text: string): JobsToolResult {
  return { content: [{ type: "text", text }], details: { error: code }, terminate: true };
}

// --- Panel -------------------------------------------------------------------

const RAW_NAV = {
  up: (d: string) => d === "k" || isArrowUp(d),
  down: (d: string) => d === "j" || isArrowDown(d),
  confirm: (d: string) => d === "\r" || d === "\n",
  cancel: (d: string) => d === "\u001b" || d === "\u0003" || d === "q",
};

/**
 * pi-tui keybinding ids for the select action family. The keybinding manager
 * resolves every byte variant of a key — kitty-protocol CSI sequences,
 * application-cursor codes, and user rebindings — which raw-byte checks miss
 * (e.g. Esc arriving as \u001b[27u instead of \u001b).
 */
const SELECT_KEYBINDING = {
  up: "tui.select.up",
  down: "tui.select.down",
  confirm: "tui.select.confirm",
  cancel: "tui.select.cancel",
} as const;

/** Focusable overlay listing jobs; enter pages the selected job's output. */
export class JobPanel {
  private selected = 0;
  private paging = false;
  private _focused = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly theme: any,
    private readonly done: (result?: unknown) => void,
    private readonly keybindings?: {
      matches?: (data: string, keybinding: string) => boolean;
    },
    private readonly tui?: PanelTui | null,
  ) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  private matches(data: string, action: keyof typeof RAW_NAV): boolean {
    const manager = this.keybindings;
    if (manager?.matches) {
      // Method-call syntax keeps the manager as the receiver; extracting the
      // function unbound throws inside the real manager (it reads its own
      // internal key maps via `this`) and silently disables protocol keys.
      if (manager.matches(data, SELECT_KEYBINDING[action])) return true;
    }
    return RAW_NAV[action](data);
  }

  private currentJob(): Job | undefined {
    const jobs = listJobs(this.registry);
    return jobs[Math.min(this.selected, jobs.length - 1)];
  }

  render(width: number): string[] {
    const bodyBudget = this.bodyRowsForBudget();
    const titleOptions = bodyBudget === undefined ? {} : { fixedBodyRows: bodyBudget };
    if (this.paging) {
      return renderModalFrame(this.theme, width, this.pagingBody(bodyBudget), {
        title: `Job output — ${this.currentJob()?.id ?? ""}`,
        ...titleOptions,
      });
    }
    return renderModalFrame(this.theme, width, this.listBody(bodyBudget), {
      title: "Background Jobs",
      ...titleOptions,
    });
  }

  /**
   * Job list with a sliding window that keeps the selected row visible. The
   * frame's fixedBodyRows alone would clip from the bottom and could hide the
   * selection.
   */
  private listBody(bodyBudget: number | undefined): string[] {
    const jobs = listJobs(this.registry);
    const jobLines =
      jobs.length === 0
        ? ["No background jobs or monitors registered."]
        : jobs.map((job, index) => {
            const line = this.themedJobLine(job);
            return index === this.selected
              ? `${this.theme.fg("accent", "›")} ${line}`
              : `  ${line}`;
          });
    const hints = formatStyledKeyHints(this.theme, [
      ["↑↓/jk", "navigate"],
      ["enter", "page output"],
      ["esc", "back / close"],
      ["q", "close"],
    ]);
    if (bodyBudget === undefined || jobLines.length + 2 <= bodyBudget) {
      return [...jobLines, "", hints];
    }
    const windowSize = Math.max(1, bodyBudget - 2); // blank + hints must stay visible
    // Keep the selected row in view: it anchors the window 1/3 from the top
    // when scrolling down, 1/3 from the bottom when scrolling up.
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(windowSize / 3), jobLines.length - windowSize),
    );
    const window = jobLines.slice(start, start + windowSize);
    const above = start > 0 ? this.theme.fg("dim", `↑ ${start} more`) : "";
    const below =
      start + windowSize < jobLines.length
        ? this.theme.fg("dim", `↓ ${jobLines.length - start - windowSize} more`)
        : "";
    if (above) window[0] = above;
    if (below) window[window.length - 1] = below;
    return [...window, "", hints];
  }

  /** Paged output view: hints stay visible; the output slice scrolls. */
  private pagingBody(bodyBudget: number | undefined): string[] {
    const job = this.currentJob();
    const hints = formatStyledKeyHints(this.theme, [
      ["esc", "back"],
      ["q", "close"],
    ]);
    if (!job) return ["No job selected.", "", hints];
    const header = this.themedJobLine(job);
    const outputLines = tailLines(truncate(job.buffer, 4_000), 60).split("\n");
    if (bodyBudget === undefined || outputLines.length + 3 <= bodyBudget) {
      return [header, "", ...outputLines, "", hints];
    }
    const windowSize = Math.max(1, bodyBudget - 3); // header + blank + blank + hints
    const tail = outputLines.slice(-windowSize);
    const hidden = outputLines.length - tail.length;
    return [
      header,
      "",
      this.theme.fg("dim", `↑ ${hidden} more line${hidden === 1 ? "" : "s"}`),
      ...tail.slice(1),
      "",
      hints,
    ];
  }

  /**
   * Body rows that fit the overlay's maxHeight (80% of terminal rows), with
   * the frame's 2 border lines and 2 padding rows subtracted. undefined when
   * the terminal size is unknown.
   */
  private bodyRowsForBudget(): number | undefined {
    const rows = this.tui?.terminal?.rows;
    if (typeof rows !== "number" || !Number.isFinite(rows)) return undefined;
    const budget = Math.max(5, Math.floor(rows * MAX_HEIGHT_FRACTION));
    return Math.max(1, budget - (FRAME_BORDER_ROWS + FRAME_PADDING_ROWS));
  }

  /** formatJobLine (format.ts) with theme colors; the model-facing list stays plain. */
  private themedJobLine(job: Job): string {
    const { color, mark } = JOB_STATUS_DISPLAY[job.status];
    const exit = job.exitCode != null ? ` exit ${job.exitCode}` : "";
    const status = this.theme.fg(color, `[${job.status}${exit}]`);
    return `#${job.id} ${this.theme.fg(color, mark)} ${status} ${job.kind} "${job.label}" (${fmtDuration(elapseMs(job))})`;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const count = listJobs(this.registry).length;
    // q is an explicit, always-available quit: it closes the panel from any view.
    if (data === "q") {
      this.done(undefined);
      return;
    }
    if (this.matches(data, "cancel")) {
      // Esc backs out of the output view first; from the list it closes the
      // panel — the conventional two-level modal dismissal.
      if (this.paging) {
        this.paging = false;
        this.requestRender();
      } else {
        this.done(undefined);
      }
      return;
    }
    if (this.paging) {
      // Any other key leaves the output view.
      this.paging = false;
      this.requestRender();
      return;
    }
    if (this.matches(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.requestRender();
      return;
    }
    if (this.matches(data, "down")) {
      this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
      this.requestRender();
      return;
    }
    if (this.matches(data, "confirm") && count > 0) {
      this.paging = true;
      this.requestRender();
    }
  }

  /** Without this, cursor moves and view changes never appear on screen. */
  private requestRender(): void {
    this.tui?.requestRender();
  }
}
