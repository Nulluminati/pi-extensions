import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProviderQuota } from "../../lib/provider-quota.ts";

const ENDPOINT = "https://api.example.com/v2/quotas";

function makeModel() {
  return { ok: true, status: 200, statusText: "OK" };
}

describe("fetchProviderQuota", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn((_url: unknown, _init?: RequestInit) => {
      return Promise.resolve({
        ...makeModel(),
        json: () => Promise.resolve({ plan: "pro" }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fetches the endpoint with Bearer auth and JSON accept headers", async () => {
    await fetchProviderQuota<{ plan: string }>({
      endpoint: ENDPOINT,
      apiKey: "k-123",
      timeoutMs: 15_000,
    });

    expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
      ENDPOINT,
      expect.objectContaining({
        headers: { Authorization: "Bearer k-123", Accept: "application/json" },
      }),
    );
  });

  it("returns the parsed JSON body", async () => {
    const body = await fetchProviderQuota<{ plan: string }>({
      endpoint: ENDPOINT,
      apiKey: "k-123",
      timeoutMs: 15_000,
    });

    expect(body).toEqual({ plan: "pro" });
  });

  it("clears the timeout timer once the fetch settles", async () => {
    await fetchProviderQuota({ endpoint: ENDPOINT, apiKey: "k-123", timeoutMs: 15_000 });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws a quota error with status and statusText on a non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });

    await expect(
      fetchProviderQuota({ endpoint: ENDPOINT, apiKey: "k-123", timeoutMs: 15_000 }),
    ).rejects.toThrow("Failed to fetch quota: 503 Service Unavailable");
  });

  it("aborts the inner request when the caller's signal aborts", async () => {
    mockFetch.mockImplementationOnce(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const outer = new AbortController();

    const pending = fetchProviderQuota({
      endpoint: ENDPOINT,
      apiKey: "k-123",
      timeoutMs: 15_000,
      signal: outer.signal,
    });
    const assertion = expect(pending).rejects.toThrow("aborted");
    outer.abort();
    await assertion;
  });

  it("aborts the inner request when the timeout elapses on a hanging fetch", async () => {
    mockFetch.mockImplementationOnce(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    const pending = fetchProviderQuota({ endpoint: ENDPOINT, apiKey: "k-123", timeoutMs: 15_000 });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("when the body stalls after the headers arrive", () => {
    beforeEach(() => {
      mockFetch.mockImplementationOnce((_url: unknown, init?: RequestInit) =>
        Promise.resolve({
          ...makeModel(),
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        }),
      );
    });

    it("aborts the body read when the timeout elapses", async () => {
      const pending = fetchProviderQuota({
        endpoint: ENDPOINT,
        apiKey: "k-123",
        timeoutMs: 15_000,
      });
      const assertion = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(15_000);

      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("aborts the body read when the caller's signal aborts", async () => {
      const outer = new AbortController();

      const pending = fetchProviderQuota({
        endpoint: ENDPOINT,
        apiKey: "k-123",
        timeoutMs: 15_000,
        signal: outer.signal,
      });
      const assertion = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(0);
      outer.abort();

      await assertion;
    });
  });
});
