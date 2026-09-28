/**
 * Worker Blocker Extension
 *
 * Worker-side half of the blocker-reporting channel between delegated
 * worker sessions and their parent. Gives the worker's model a
 * `report_blocker` tool to declare "I cannot proceed" with one short
 * reason. The sanitized reason is appended as an `agents_blocker` marker
 * to the worker's own event spool — the file the parent session already
 * tails — so the parent wakes once (ids and status words only) and reads
 * the reason back through the workers tool (action=status). Nothing here
 * routes through messenger: the pull-only output boundary stays intact,
 * and reporting a blocker never stops the worker; the parent decides.
 *
 * Registers nothing outside worker sessions (no `PI_WORKER=1`, or the
 * runner's `PI_WORKER_STREAM` spool path missing): the main session's
 * model never sees the tool.
 */

// --- Imports ---
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "pi";
import { isNodeError } from "../../lib/errors.ts";
import {
  BLOCKER_MARKER_TYPE,
  BLOCKER_REASON_MAX_CHARS,
  sanitizeBlockerReason,
  WORKER_STREAM_ENV_VAR,
} from "../../lib/worker-blocker.ts";

// --- Constants ---

const REPORT_BLOCKER_TOOL = "report_blocker";

// --- Extension ---

export default async function workerBlockerExtension(pi: ExtensionAPI) {
  if (process.env.PI_WORKER !== "1") return;
  const spoolPath = process.env[WORKER_STREAM_ENV_VAR]?.trim();
  if (!spoolPath) return;

  pi.registerTool({
    name: REPORT_BLOCKER_TOOL,
    label: "Report Blocker",
    description:
      "Report that you cannot proceed with your task. Sends a short, one-line reason to the parent session, which decides what to do next (adjust the task, or cancel this worker to free its slot). Use it early instead of burning the whole time budget on an impossible environment; keep working if you find a way around the blocker.",
    promptGuidelines: [
      "Call report_blocker as soon as you determine the task cannot proceed (missing files, no credentials, impossible environment). State the concrete obstacle in one line.",
      "After reporting, continue if any useful progress is still possible; reporting a blocker does not stop your session.",
    ],
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: `One-line reason you cannot proceed, at most ${BLOCKER_REASON_MAX_CHARS} characters. Name the concrete obstacle (what is missing, what failed, what you tried).`,
        },
      },
      required: ["reason"],
    },
    async execute(_toolCallId, params) {
      const { reason, truncated } = sanitizeBlockerReason(params.reason);
      if (!reason) {
        return {
          content: [
            {
              type: "text",
              text: "No blocker reported: the reason was empty after sanitizing. State concretely what blocks the task.",
            },
          ],
          details: { reported: false, truncated: false },
        };
      }

      // Same transport the parent tails for live activity: one appended
      // marker line on the worker's own spool (atomic O_APPEND writes).
      const marker = `${JSON.stringify({ type: BLOCKER_MARKER_TYPE, at: Date.now(), reason })}\n`;
      try {
        await mkdir(dirname(spoolPath), { recursive: true }).catch((error) => {
          // The parent channel's directory is created on demand; only ENOENT
          // can be ignored, because the append below reports the failure with
          // more context. Every other failure (EACCES…) surfaces here.
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        });
        await appendFile(spoolPath, marker, "utf8");
      } catch (err) {
        throw new Error(
          `report_blocker could not reach the parent channel: ${(err as Error).message}`,
        );
      }

      const notes = [
        "Blocker reported to the parent session; it will read the reason via its workers tool and decide next steps.",
        truncated ? `The reason was truncated to ${BLOCKER_REASON_MAX_CHARS} characters.` : "",
        "Reporting does not stop this session: continue if you can make progress another way.",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        content: [{ type: "text", text: notes }],
        details: { reported: true, truncated },
      };
    },
  });
}
