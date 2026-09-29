/**
 * Codex ChatGPT sign-in credentials.
 *
 * The Codex CLI stores OAuth tokens in `auth.json` under its home directory
 * (`CODEX_HOME` when set, otherwise `~/.codex`). Only ChatGPT token auth is
 * accepted; files holding a bare OpenAI API key are rejected. A stored access
 * token is a JWT whose `exp` is checked with a 60s safety margin. When it is
 * expired (or unreadable), it is exchanged at the OpenAI OAuth token endpoint
 * and the refreshed tokens are written back atomically. The read-modify-write
 * runs under an advisory file lock so two Pi sessions refreshing at the same
 * time cannot clobber each other, and the winner's fresh token is re-read
 * before a second network refresh happens.
 *
 * Error messages name the auth file and required fields but never echo token
 * material.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";

// --- Constants ---

/** A token within this window of expiry is already treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;
const REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// --- Types ---

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

interface ParsedAuth {
  /** The whole parsed auth.json object, preserved on write-back. */
  doc: Record<string, unknown>;
  /** The `tokens` object inside `doc`, preserved on write-back. */
  tokens: Record<string, unknown>;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

// --- Paths ---

/** Codex CLI home: `CODEX_HOME` when set, otherwise `~/.codex`. */
export function codexHomeDir(): string {
  const configured = process.env.CODEX_HOME;
  return configured ? configured : join(homedir(), ".codex");
}

function authFilePath(): string {
  return join(codexHomeDir(), "auth.json");
}

// --- Type guards ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// --- JWT helpers ---

/**
 * Decode a JWT payload without verifying the signature. The token is read
 * from the user's own auth file and only the public `exp` claim is needed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `exp` is missing or unreadable, or lies within the 60s margin, so
 * the caller always receives a token with headroom to actually use it.
 */
function isAccessTokenExpired(accessToken: string): boolean {
  const payload = decodeJwtPayload(accessToken);
  if (payload === undefined) return true;
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return true;
  return Date.now() >= exp * 1000 - EXPIRY_MARGIN_MS;
}

// --- Auth file parsing ---

function parseAuthFile(doc: unknown, path: string): ParsedAuth {
  if (!isRecord(doc)) {
    throw new Error(`Codex auth file ${path} is not a JSON object.`);
  }
  const tokensValue = doc.tokens;
  if (!isRecord(tokensValue)) {
    if (isNonEmptyString(doc.OPENAI_API_KEY)) {
      throw new Error(
        `Codex auth at ${path} holds an OpenAI API key, but ChatGPT sign-in tokens are required. Run \`codex login\` to sign in with ChatGPT.`,
      );
    }
    throw new Error(
      `Codex auth file ${path} has no ChatGPT tokens. Run \`codex login\` to sign in with ChatGPT.`,
    );
  }
  const accessToken = tokensValue.access_token;
  const refreshToken = tokensValue.refresh_token;
  const accountId = tokensValue.account_id;
  if (
    !isNonEmptyString(accessToken) ||
    !isNonEmptyString(refreshToken) ||
    !isNonEmptyString(accountId)
  ) {
    throw new Error(
      `Codex auth file ${path} is missing tokens.access_token, tokens.refresh_token, or tokens.account_id. Run \`codex login\` again.`,
    );
  }
  return { doc, tokens: tokensValue, accessToken, refreshToken, accountId };
}

async function readAuthFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Codex is not signed in: ${path} does not exist. Run \`codex login\` to sign in with ChatGPT.`,
      );
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Codex auth file ${path} is not valid JSON.`);
  }
}

// --- Token refresh ---

async function refreshAccessToken(
  refreshToken: string,
  signal: AbortSignal,
): Promise<RefreshedTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: REFRESH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  let response: Response;
  try {
    response = await fetch(REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `Refreshing the Codex access token failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Refreshing the Codex access token failed: the OAuth token endpoint returned HTTP ${response.status}. Run \`codex login\` again.`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Refreshing the Codex access token failed: the token endpoint returned a non-JSON body.",
    );
  }
  if (!isRecord(payload) || !isNonEmptyString(payload.access_token)) {
    throw new Error(
      "Refreshing the Codex access token failed: the token endpoint response has no access_token.",
    );
  }
  const refreshed: RefreshedTokens = { accessToken: payload.access_token };
  if (isNonEmptyString(payload.refresh_token)) refreshed.refreshToken = payload.refresh_token;
  if (isNonEmptyString(payload.id_token)) refreshed.idToken = payload.id_token;
  return refreshed;
}

// --- Credentials ---

/**
 * Return current Codex ChatGPT credentials, refreshing the access token when
 * it is expired or close to expiry. Rejects when Codex is not signed in,
 * uses API-key auth, or the refresh fails.
 */
export async function getCodexCredentials(signal: AbortSignal): Promise<CodexCredentials> {
  signal.throwIfAborted();
  const path = authFilePath();
  const current = parseAuthFile(await readAuthFile(path), path);
  if (!isAccessTokenExpired(current.accessToken)) {
    return { accessToken: current.accessToken, accountId: current.accountId };
  }
  // Re-read once the lock is held: a concurrent session may have refreshed
  // while we waited, and every writer must read-modify-write the same file.
  return withFileLock(`${path}.lock`, async () => {
    const locked = parseAuthFile(await readAuthFile(path), path);
    if (!isAccessTokenExpired(locked.accessToken)) {
      return { accessToken: locked.accessToken, accountId: locked.accountId };
    }
    const refreshed = await refreshAccessToken(locked.refreshToken, signal);
    const nextTokens: Record<string, unknown> = {
      ...locked.tokens,
      access_token: refreshed.accessToken,
    };
    if (refreshed.refreshToken !== undefined) nextTokens.refresh_token = refreshed.refreshToken;
    if (refreshed.idToken !== undefined) nextTokens.id_token = refreshed.idToken;
    const nextDoc: Record<string, unknown> = {
      ...locked.doc,
      tokens: nextTokens,
      last_refresh: new Date().toISOString(),
    };
    await writeJsonAtomic(path, nextDoc, { mode: 0o600 });
    return { accessToken: refreshed.accessToken, accountId: locked.accountId };
  });
}
