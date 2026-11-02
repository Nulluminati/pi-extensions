import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_REVIEW_EVENT,
  type CommandReviewRequest,
  requestCommandReview,
} from "../../lib/command-review.ts";

function ctxWith(signal?: AbortSignal): ExtensionContext {
  return { cwd: "/workspace", ...(signal ? { signal } : {}) } as unknown as ExtensionContext;
}

describe("requestCommandReview", () => {
  it("returns the reviewer's reply when a reviewer claims the request", async () => {
    const emit = vi.fn((event: string, data: unknown) => {
      expect(event).toBe(COMMAND_REVIEW_EVENT);
      const request = data as CommandReviewRequest;
      expect(request).toMatchObject({
        command: "npm test",
        cwd: "/workspace",
        source: "mission reconcile",
      });
      request.claim();
      request.respond({ approved: false, reason: "Blocked by reviewer." });
    });
    await expect(
      requestCommandReview(
        { emit },
        { ctx: ctxWith(), command: "npm test", cwd: "/workspace", source: "mission reconcile" },
      ),
    ).resolves.toEqual({ approved: false, reason: "Blocked by reviewer." });
  });

  it("waits for a reviewer that answers later", async () => {
    let pending: CommandReviewRequest | undefined;
    const emit = vi.fn((_event: string, data: unknown) => {
      pending = data as CommandReviewRequest;
      pending.claim();
    });
    const result = requestCommandReview(
      { emit },
      { ctx: ctxWith(), command: "npm test", cwd: "/workspace", source: "s" },
    );
    pending?.respond({ approved: true });
    await expect(result).resolves.toEqual({ approved: true });
  });

  it("keeps only the first reply", async () => {
    const emit = vi.fn((_event: string, data: unknown) => {
      const request = data as CommandReviewRequest;
      request.claim();
      request.respond({ approved: false, reason: "first" });
      request.respond({ approved: true });
    });
    await expect(
      requestCommandReview(
        { emit },
        { ctx: ctxWith(), command: "npm test", cwd: "/workspace", source: "s" },
      ),
    ).resolves.toEqual({ approved: false, reason: "first" });
  });

  it("refuses hard-deny commands when no reviewer is listening", async () => {
    const result = await requestCommandReview(
      { emit: vi.fn() },
      { ctx: ctxWith(), command: "git reset --hard", cwd: "/workspace", source: "s" },
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/hard deny/i);
  });

  it.each(["rm -rf $HOME/", "rm -rf ~/", "rm -rf //", "rm -rf */"])(
    "refuses %s when no reviewer is listening",
    async (command) => {
      const result = await requestCommandReview(
        { emit: vi.fn() },
        { ctx: ctxWith(), command, cwd: "/workspace", source: "mission reconcile" },
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/hard deny/i);
    },
  );

  it("allows other commands when no reviewer is listening", async () => {
    await expect(
      requestCommandReview(
        { emit: vi.fn() },
        { ctx: ctxWith(), command: "npm test", cwd: "/workspace", source: "s" },
      ),
    ).resolves.toEqual({ approved: true });
  });

  it("refuses when the reviewer throws", async () => {
    const emit = vi.fn(() => {
      throw new Error("listener failed");
    });
    const result = await requestCommandReview(
      { emit },
      { ctx: ctxWith(), command: "npm test", cwd: "/workspace", source: "s" },
    );
    expect(result.approved).toBe(false);
  });

  it("refuses when the context is cancelled before or during review", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const emit = vi.fn();
    expect(
      await requestCommandReview(
        { emit },
        { ctx: ctxWith(aborted.signal), command: "npm test", cwd: "/workspace", source: "s" },
      ),
    ).toMatchObject({ approved: false });
    expect(emit).not.toHaveBeenCalled();

    const later = new AbortController();
    const result = requestCommandReview(
      {
        emit: (_event: string, data: unknown) => (data as CommandReviewRequest).claim(),
      },
      { ctx: ctxWith(later.signal), command: "npm test", cwd: "/workspace", source: "s" },
    );
    later.abort();
    expect(await result).toMatchObject({ approved: false });
  });
});
