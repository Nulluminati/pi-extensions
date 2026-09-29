import type { ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderAuthHeaders, resolveProviderApiKey } from "../../lib/provider-auth.ts";

const ENV_VAR = "TEST_PROVIDER_API_KEY";
const PROVIDER = "testprovider";

function makeCtx(getApiKeyForProvider: (...args: unknown[]) => unknown): ExtensionContext {
  return {
    modelRegistry: { getApiKeyForProvider: vi.fn(getApiKeyForProvider) },
  } as unknown as ExtensionContext;
}

describe("resolveProviderApiKey", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the registry key when the provider is registered", async () => {
    vi.stubEnv(ENV_VAR, "env-key");
    const ctx = makeCtx(() => Promise.resolve("registry-key"));

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      "registry-key",
    );
  });

  it("falls back to the environment variable when the registry has no key", async () => {
    vi.stubEnv(ENV_VAR, "env-key");
    const ctx = makeCtx(() => Promise.resolve(undefined));

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      "env-key",
    );
  });

  it("falls back to the environment variable when the provider is not registered", async () => {
    vi.stubEnv(ENV_VAR, "env-key");
    const ctx = makeCtx(() => {
      throw new Error("Provider not registered yet");
    });

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      "env-key",
    );
  });

  it("returns undefined when neither source has a key", async () => {
    vi.stubEnv(ENV_VAR, "");
    const ctx = makeCtx(() => Promise.resolve(undefined));

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      undefined,
    );
  });

  it("trims whitespace around the environment value", async () => {
    vi.stubEnv(ENV_VAR, "  secret-key  ");
    const ctx = makeCtx(() => Promise.resolve(undefined));

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      "secret-key",
    );
  });

  it("treats a whitespace-only environment value as missing", async () => {
    vi.stubEnv(ENV_VAR, "   ");
    const ctx = makeCtx(() => Promise.resolve(undefined));

    await expect(resolveProviderApiKey(ctx, { provider: PROVIDER, envVar: ENV_VAR })).resolves.toBe(
      undefined,
    );
  });
});

describe("createProviderAuthHeaders", () => {
  it("sends a Bearer authorization header and JSON accept header", () => {
    expect(createProviderAuthHeaders("k-123")).toEqual({
      Authorization: "Bearer k-123",
      Accept: "application/json",
    });
  });
});
