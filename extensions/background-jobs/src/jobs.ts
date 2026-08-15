/**
 * The `jobs` tool: list / status / tail / cancel / view over the registry.
 * `view` opens a focusable overlay panel; everything else is text output for
 * the model.
 */

import { renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatJobLine, tailLines, truncate } from "./format.ts";
import { getJob, type JobRegistry, listJobs, renderJobList } from "./registry.ts";
import { cancelJob, KILL_GRACE_MS } from "./runner.ts";
import type { Job, JobEvents } from "./types.ts";

export interface JobsToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface PanelUi {
  // Loosely mirrors ExtensionUIContext.custom; any-params keep the factory
  // type compatible in both directions.
  custom?(
    factory: (tui: any, theme: any, keybindings: any, done: (result?: unknown) => void) => unknown,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): unknown;
}

export async function executeJobsAction(options: {
  registry: JobRegistry;
  action: string;
  jobId?: number | undefined;
  lines?: number | undefined;
  mode: string;
  ui: PanelUi;
  events: JobEvents;
}): Promise<JobsToolResult> {
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

  const job: Job | undefined = Number.isFinite(options.jobId as number)
    ? getJob(registry, options.jobId as number)
    : undefined;

  if (action === "status") {
    if (!job) return errorResult(`No job #${options.jobId}.`);
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
    if (!job) return errorResult(`No job #${options.jobId}.`);
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
    if (!job) return errorResult(`No job #${options.jobId}.`);
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

  if (action === "view") {
    if (options.mode !== "tui" || !options.ui.custom) {
      return errorResult(
        "Interactive view is only available in TUI mode. Use action=list and action=tail instead.",
      );
    }
    options.ui.custom(
      (tui: unknown, theme: any, keybindings: any, done: (result?: unknown) => void) =>
        new JobPanel(registry, theme, done, keybindings, tui as { requestRender(): void } | null),
      { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center" } },
    );
    return {
      content: [
        {
          type: "text",
          text: "Opened the background jobs panel. Use arrows or j/k to move, enter to page a job's output, q or Esc to close.",
        },
      ],
    };
  }

  return errorResult(`Unknown action "${action}". Use list, status, tail, cancel, or view.`);
}

function errorResult(text: string): JobsToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// --- Panel -------------------------------------------------------------------

const RAW_NAV = {
  up: (d: string) => d === "k" || d === "\u001b[A" || d === "\u001bOA",
  down: (d: string) => d === "j" || d === "\u001b[B" || d === "\u001bOB",
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
    private readonly tui?: { requestRender(): void } | null,
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
    if (this.paging) {
      const job = this.currentJob();
      const body = job
        ? [formatJobLine(job), "", ...tailLines(truncate(job.buffer, 4_000), 60).split("\n")]
        : ["No job selected."];
      return renderModalFrame(this.theme, width, body, { title: `Job output — ${job?.id ?? ""}` });
    }
    const lines = renderJobList(this.registry);
    const body =
      lines.length === 0
        ? ["No background jobs or monitors registered."]
        : lines.map((line, index) => (index === this.selected ? `> ${line}` : `  ${line}`));
    return renderModalFrame(this.theme, width, body, {
      title: "Background Jobs",
    });
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
