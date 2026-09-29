import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexCredentials } from "../../extensions/codex-image/src/auth.ts";
import {
  getCodexResponseModel,
  parseTopLevelModel,
} from "../../extensions/codex-image/src/config.ts";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => "/home/tester-default") };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// State and helpers
// ---------------------------------------------------------------------------

let codexHome: string;

function authPath(): string {
  return join(codexHome, "auth.json");
}

function configPath(): string {
  return join(codexHome, "config.toml");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function expSeconds(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

function chatGptTokens(accessExpSeconds: number): Record<string, string> {
  return {
    id_token: makeJwt({ email: "user@example.com" }),
    access_token: makeJwt({ sub: "user-1", exp: expSeconds(accessExpSeconds) }),
    refresh_token: "refresh-token-1",
    account_id: "acct-123",
  };
}

function apiAuthFile(tokens: Record<string, string>): Record<string, unknown> {
  return { OPENAI_API_KEY: null, tokens };
}

function refreshedAccessToken(hoursValid: number): string {
  return makeJwt({ sub: "user-1", exp: expSeconds(hoursValid * 3600) });
}

function refreshResponse(overrides: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify({ access_token: refreshedAccessToken(1), ...overrides }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function writeAuthFile(body: unknown): Promise<void> {
  await writeFile(authPath(), JSON.stringify(body, null, 2), "utf8");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the promise to reject");
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  codexHome = await mkdtemp(join(tmpdir(), "codex-image-auth-"));
  vi.stubEnv("CODEX_HOME", codexHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(codexHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getCodexCredentials
// ---------------------------------------------------------------------------

describe("getCodexCredentials", () => {
  it("rejects when auth.json is missing", async () => {
    const message = await rejectionMessage(getCodexCredentials(signal()));
    expect(message).toMatch(/not signed in/);
    expect(message).toContain(authPath());
  });

  it("rejects when auth.json is not valid JSON", async () => {
    await writeFile(authPath(), "{ not json", "utf8");
    const message = await rejectionMessage(getCodexCredentials(signal()));
    expect(message).toMatch(/not valid JSON/);
  });

  it("rejects when auth.json is not a JSON object", async () => {
    await writeFile(authPath(), "[1, 2]", "utf8");
    const message = await rejectionMessage(getCodexCredentials(signal()));
    expect(message).toMatch(/not a JSON object/);
  });

  it("rejects API-key auth without ChatGPT tokens and does not leak the key", async () => {
    await writeAuthFile({ OPENAI_API_KEY: "sk-secret-key", tokens: null });
    const message = await rejectionMessage(getCodexCredentials(signal()));
    expect(message).toMatch(/API key/);
    expect(message).toMatch(/ChatGPT/);
    expect(message).not.toContain("sk-secret-key");
  });

  it("rejects when tokens are incomplete and does not leak values", async () => {
    await writeAuthFile(apiAuthFile({ access_token: "opaque-access-value" }));
    const message = await rejectionMessage(getCodexCredentials(signal()));
    expect(message).toMatch(/tokens\.access_token|tokens\.refresh_token|tokens\.account_id/);
    expect(message).not.toContain("opaque-access-value");
  });

  it("returns unexpired credentials without refreshing", async () => {
    const tokens = chatGptTokens(3600);
    await writeAuthFile(apiAuthFile(tokens));
    const before = await readFile(authPath(), "utf8");

    const credentials = await getCodexCredentials(signal());

    expect(credentials).toEqual({ accessToken: tokens.access_token, accountId: "acct-123" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readFile(authPath(), "utf8")).toBe(before);
  });

  it("treats a token expiring within the 60s margin as expired", async () => {
    const tokens = chatGptTokens(30);
    await writeAuthFile(apiAuthFile(tokens));
    const freshToken = refreshedAccessToken(1);
    mockFetch.mockResolvedValueOnce(
      refreshResponse({ access_token: freshToken, refresh_token: "refresh-token-2" }),
    );

    const credentials = await getCodexCredentials(signal());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(credentials.accessToken).toBe(freshToken);
  });

  it("treats a token just outside the 60s margin as valid", async () => {
    await writeAuthFile(apiAuthFile(chatGptTokens(61)));
    const before = await readFile(authPath(), "utf8");

    const credentials = await getCodexCredentials(signal());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readFile(authPath(), "utf8")).toBe(before);
    expect(credentials.accountId).toBe("acct-123");
  });

  it("refreshes an expired token, preserving unrelated JSON", async () => {
    await writeAuthFile({
      ...apiAuthFile(chatGptTokens(-3600)),
      custom_note: "hello",
      nested: { keep: true },
    });
    const freshToken = refreshedAccessToken(1);
    mockFetch.mockResolvedValueOnce(
      refreshResponse({
        access_token: freshToken,
        id_token: "new-id-token",
        refresh_token: "refresh-token-2",
        expires_in: 3600,
      }),
    );

    const credentials = await getCodexCredentials(signal());

    expect(credentials).toEqual({ accessToken: freshToken, accountId: "acct-123" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(body.get("refresh_token")).toBe("refresh-token-1");

    const saved = JSON.parse(await readFile(authPath(), "utf8"));
    expect(saved.tokens.access_token).toBe(freshToken);
    expect(saved.tokens.refresh_token).toBe("refresh-token-2");
    expect(saved.tokens.id_token).toBe("new-id-token");
    expect(saved.tokens.account_id).toBe("acct-123");
    expect(saved.custom_note).toBe("hello");
    expect(saved.nested).toEqual({ keep: true });
    expect(Number.isNaN(Date.parse(saved.last_refresh))).toBe(false);
  });

  it("keeps the previous refresh token when the response omits one", async () => {
    await writeAuthFile(apiAuthFile(chatGptTokens(-3600)));
    mockFetch.mockResolvedValueOnce(refreshResponse({}));

    await getCodexCredentials(signal());

    const saved = JSON.parse(await readFile(authPath(), "utf8"));
    expect(saved.tokens.refresh_token).toBe("refresh-token-1");
  });

  it("rejects an HTTP error from the token endpoint and leaves auth.json untouched", async () => {
    await writeAuthFile(apiAuthFile(chatGptTokens(-3600)));
    mockFetch.mockResolvedValueOnce(refreshResponse({}, 400));
    const before = await readFile(authPath(), "utf8");

    const message = await rejectionMessage(getCodexCredentials(signal()));

    expect(message).toMatch(/HTTP 400/);
    expect(await readFile(authPath(), "utf8")).toBe(before);
  });

  it("rejects a response without access_token and leaves auth.json untouched", async () => {
    await writeAuthFile(apiAuthFile(chatGptTokens(-3600)));
    const tokens = chatGptTokens(-3600);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ nope: true }), { status: 200 }));
    const before = await readFile(authPath(), "utf8");

    const message = await rejectionMessage(getCodexCredentials(signal()));

    expect(message).toMatch(/access_token/);
    expect(message).not.toContain(tokens.refresh_token);
    expect(await readFile(authPath(), "utf8")).toBe(before);
  });

  it("rejects on a network failure without leaking tokens", async () => {
    const tokens = chatGptTokens(-3600);
    await writeAuthFile(apiAuthFile(tokens));
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    const message = await rejectionMessage(getCodexCredentials(signal()));

    expect(message).toMatch(/Refreshing the Codex access token failed/);
    expect(message).toContain("fetch failed");
    expect(message).not.toContain(tokens.access_token);
    expect(message).not.toContain(tokens.refresh_token);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(getCodexCredentials(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes so the second call reuses the fresh token", async () => {
    await writeAuthFile(apiAuthFile(chatGptTokens(-3600)));
    const freshToken = refreshedAccessToken(1);
    mockFetch.mockResolvedValueOnce(
      refreshResponse({ access_token: freshToken, refresh_token: "refresh-token-2" }),
    );

    const [first, second] = await Promise.all([
      getCodexCredentials(signal()),
      getCodexCredentials(signal()),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe(freshToken);
    expect(second.accessToken).toBe(freshToken);
    const saved = JSON.parse(await readFile(authPath(), "utf8"));
    expect(saved.tokens.access_token).toBe(freshToken);
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", async () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.mocked(homedir).mockImplementation(() => codexHome);
    const codexDir = join(codexHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "auth.json"),
      JSON.stringify(apiAuthFile(chatGptTokens(3600))),
      "utf8",
    );

    const credentials = await getCodexCredentials(signal());

    expect(credentials.accountId).toBe("acct-123");
  });
});

// ---------------------------------------------------------------------------
// getCodexResponseModel
// ---------------------------------------------------------------------------

describe("getCodexResponseModel", () => {
  it("returns the default when config.toml is missing", async () => {
    expect(await getCodexResponseModel()).toBe("gpt-5.5");
  });

  it("returns the top-level model", async () => {
    await writeFile(configPath(), 'approval_policy = "never"\nmodel = "gpt-5.1-codex"\n', "utf8");
    expect(await getCodexResponseModel()).toBe("gpt-5.1-codex");
  });

  it("ignores model keys inside model_provider tables", async () => {
    await writeFile(
      configPath(),
      'model = "top-level-model"\n\n[model_providers.openai]\nmodel = "table-model"\n',
      "utf8",
    );
    expect(await getCodexResponseModel()).toBe("top-level-model");
  });

  it("ignores model keys that appear after any table header", async () => {
    await writeFile(configPath(), '[profiles.work]\nmodel = "table-model"\n', "utf8");
    expect(await getCodexResponseModel()).toBe("gpt-5.5");
  });

  it("ignores unrelated config content", async () => {
    await writeFile(
      configPath(),
      'preferred_auth_method = "chatgpt"\n\n[model_providers.custom]\nbase_url = "https://example.com"\n',
      "utf8",
    );
    expect(await getCodexResponseModel()).toBe("gpt-5.5");
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", async () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.mocked(homedir).mockImplementation(() => codexHome);
    const codexDir = join(codexHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), 'model = "gpt-5.1-codex"\n', "utf8");

    expect(await getCodexResponseModel()).toBe("gpt-5.1-codex");
  });
});

// ---------------------------------------------------------------------------
// parseTopLevelModel
// ---------------------------------------------------------------------------

describe("parseTopLevelModel", () => {
  it.each([
    ['model = "gpt-5.2"', "gpt-5.2"],
    ['  model = "gpt-5.2"  # fast', "gpt-5.2"],
    ['model="no-spaces"', "no-spaces"],
    ['model = ""', undefined],
    ['# model = "gpt-4o"', undefined],
    ['foo = "bar"', undefined],
    ['[tools]\nmodel = "x"', undefined],
  ])("parses %j to %j", (content, expected) => {
    expect(parseTopLevelModel(content)).toBe(expected);
  });

  it("handles CRLF line endings", () => {
    expect(parseTopLevelModel('model = "a"\r\nother = 1\r\n')).toBe("a");
  });
});
