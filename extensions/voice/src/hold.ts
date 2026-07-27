import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  HOLD_REPEAT_GAP_MS,
  HOLD_REPEAT_INITIAL_GAP_MS,
  HOLD_REPEAT_MIN_EVENTS,
  HOLD_TO_VOICE_MS,
} from "./constants.ts";

export function addHoldToVoice<T extends HoldToVoiceEditor>(
  editor: T,
  onHold: () => void,
  deps: HoldToVoiceDeps = {
    isSupported: isKittyProtocolActive,
    isSpace: (data) => data === " " || matchesKey(data, Key.space),
    isRelease: isKeyRelease,
    isRepeat: isKeyRepeat,
  },
): T {
  const originalHandleInput = editor.handleInput.bind(editor);
  const originalDispose = editor.dispose?.bind(editor);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatGapTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatStartedAt = 0;
  let repeatLastAt = 0;
  let repeatCount = 0;
  let repeatActive = false;
  let triggered = false;

  const clearHoldTimer = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const clearRepeatGapTimer = (): void => {
    if (repeatGapTimer) clearTimeout(repeatGapTimer);
    repeatGapTimer = null;
  };
  const resetRepeat = (restoreSpace: boolean): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    repeatStartedAt = 0;
    repeatLastAt = 0;
    repeatCount = 0;
    repeatActive = false;
    if (restoreSpace) originalHandleInput(" ");
  };
  const scheduleRepeatReset = (delay: number, restoreSpace: boolean): void => {
    clearRepeatGapTimer();
    repeatGapTimer = setTimeout(() => resetRepeat(restoreSpace), delay);
  };
  const scheduleTriggeredReset = (): void => {
    clearRepeatGapTimer();
    repeatGapTimer = setTimeout(() => {
      triggered = false;
      repeatGapTimer = null;
    }, HOLD_REPEAT_GAP_MS);
  };
  const startHoldTimer = (elapsed: number): void => {
    clearHoldTimer();
    holdTimer = setTimeout(
      () => {
        holdTimer = null;
        clearRepeatGapTimer();
        repeatStartedAt = 0;
        repeatLastAt = 0;
        repeatCount = 0;
        repeatActive = false;
        triggered = true;
        if (!deps.isSupported()) scheduleTriggeredReset();
        onHold();
      },
      Math.max(0, HOLD_TO_VOICE_MS - elapsed),
    );
  };

  editor.wantsKeyRelease = true;
  editor.handleInput = (data: string): void => {
    const supported = deps.isSupported();
    const space = deps.isSpace(data);

    if (!supported) {
      if (!space) {
        resetRepeat(repeatActive);
        originalHandleInput(data);
        return;
      }

      if (triggered) {
        scheduleTriggeredReset();
        return;
      }

      const now = Date.now();
      if (repeatCount === 0) {
        originalHandleInput(" ");
        repeatStartedAt = now;
        repeatLastAt = now;
        repeatCount = 1;
        scheduleRepeatReset(HOLD_REPEAT_INITIAL_GAP_MS, false);
        return;
      }

      const maximumGap = repeatCount === 1 ? HOLD_REPEAT_INITIAL_GAP_MS : HOLD_REPEAT_GAP_MS;
      if (now - repeatLastAt > maximumGap) {
        resetRepeat(repeatActive);
        originalHandleInput(" ");
        repeatStartedAt = now;
        repeatLastAt = now;
        repeatCount = 1;
        scheduleRepeatReset(HOLD_REPEAT_INITIAL_GAP_MS, false);
        return;
      }

      repeatLastAt = now;
      repeatCount++;
      if (!repeatActive) {
        originalHandleInput(" ");
        if (repeatCount >= HOLD_REPEAT_MIN_EVENTS) {
          repeatActive = true;
          for (let i = 0; i < repeatCount; i++) originalHandleInput("\x7f");
          startHoldTimer(now - repeatStartedAt);
        }
      }
      scheduleRepeatReset(HOLD_REPEAT_GAP_MS, repeatActive);
      return;
    }

    if (!space) {
      originalHandleInput(data);
      return;
    }
    if (deps.isRelease(data)) {
      clearHoldTimer();
      if (!triggered) originalHandleInput(" ");
      triggered = false;
      return;
    }
    if (deps.isRepeat(data)) return;
    if (triggered) triggered = false;
    if (holdTimer) return;
    startHoldTimer(0);
  };
  editor.dispose = (): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    originalDispose?.();
  };
  return editor;
}

interface HoldToVoiceEditor {
  handleInput(data: string): void;
  wantsKeyRelease?: boolean;
  dispose?: () => void;
}

interface HoldToVoiceDeps {
  isSupported: () => boolean;
  isSpace: (data: string) => boolean;
  isRelease: (data: string) => boolean;
  isRepeat: (data: string) => boolean;
}
