import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecapState } from "./types.ts";

// --- State management (WeakMap for per-instance) ---

const stateMap = new WeakMap<ExtensionAPI, RecapState>();

export function getState(pi: ExtensionAPI): RecapState {
  const existing = stateMap.get(pi);
  if (existing) return existing;
  const fresh: RecapState = {
    idleTimer: undefined,
    activeController: undefined,
    activeReason: undefined,
    agentActive: false,
    focusDraftAfterAgent: false,
    focusListener: undefined,
    focusEnabled: false,
    focusedOutAt: undefined,
    pendingRecap: undefined,
    lastDraftedLeafId: undefined,
    autoDismissTimer: undefined,
    resumeTimer: undefined,
    backgroundFailureNotified: false,
  };
  stateMap.set(pi, fresh);
  return fresh;
}

export function resetState(state: RecapState) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  if (state.activeController) {
    state.activeController.abort();
    state.activeController = undefined;
    state.activeReason = undefined;
  }
  if (state.autoDismissTimer) {
    clearTimeout(state.autoDismissTimer);
    state.autoDismissTimer = undefined;
  }
  if (state.resumeTimer) {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = undefined;
  }
  state.agentActive = false;
  state.focusDraftAfterAgent = false;
  state.focusedOutAt = undefined;
  state.pendingRecap = undefined;
  state.lastDraftedLeafId = undefined;
  state.backgroundFailureNotified = false;
}
