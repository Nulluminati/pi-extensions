// --- Constants ---

export const NEURALWATT_API_BASE_URL = "https://api.neuralwatt.com/v1";

export const NEURALWATT_MODELS_ENDPOINT = `${NEURALWATT_API_BASE_URL}/models`;

export const NEURALWATT_QUOTA_ENDPOINT = `${NEURALWATT_API_BASE_URL}/quota`;

export const FETCH_TIMEOUT_MS = 15_000;

// Client attribution headers Neuralwatt's gateway expects (same convention as
// OpenRouter: Referer/X-Title identify the calling app). Sent on every provider
// request and on the catalog fetch.
export const NEURALWATT_CLIENT_HEADERS: Record<string, string> = {
  Referer: "https://pi.dev",
  "X-Title": "pi-extensions/neuralwatt",
};
