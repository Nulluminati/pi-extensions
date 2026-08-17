import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  HOLD_REPEAT_GAP_MS,
  HOLD_REPEAT_MIN_EVENTS,
  HOLD_TO_VOICE_MS,
  SPACE_COMMIT_DELAY_MS,
} from "./constants.ts";

export function addHoldToVoice<T extends HoldToVoiceEditor>(
  editor: T,
  onHold: () => void,
  deps: HoldToVoiceDeps = {},
): T {
  const {
    isSupported = isKittyProtocolActive,
    isSpace = (data: string) => data === " " || matchesKey(data, Key.space),
    isRelease = isKeyRelease,
    isRepeat = isKeyRepeat,
    isSuppressed = () => false,
    isKeyDown = () => true,
    canArm = () => true,
  } = deps;
  const originalHandleInput = editor.handleInput.bind(editor);
  const originalDispose = editor.dispose?.bind(editor);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatGapTimer: ReturnType<typeof setTimeout> | null = null;
  // Legacy mode (no key-release reporting): Space events are buffered instead
  // of typed immediately, so a hold never puts text into the editor and a
  // trigger never needs to delete text. A lone Space is committed after
  // SPACE_COMMIT_DELAY_MS; a repeat arriving within that window marks a hold.
  let pendingSpaces = 0;
  let pendingSpaceTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatStartedAt = 0;
  let triggered = false;
  let wasSuppressed = false;

  const clearHoldTimer = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const clearRepeatGapTimer = (): void => {
    if (repeatGapTimer) clearTimeout(repeatGapTimer);
    repeatGapTimer = null;
  };
  const clearPendingSpaceTimer = (): void => {
    if (pendingSpaceTimer) clearTimeout(pendingSpaceTimer);
    pendingSpaceTimer = null;
  };
  /** Commit buffered Spaces in order, as real typing. */
  const commitPendingSpaces = (): void => {
    clearPendingSpaceTimer();
    for (let i = 0; i < pendingSpaces; i++) originalHandleInput(" ");
    pendingSpaces = 0;
  };
  /** Drop all hold tracking without touching editor text or inserting anything. */
  const resetHoldTracking = (): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    clearPendingSpaceTimer();
    pendingSpaces = 0;
    repeatStartedAt = 0;
    triggered = false;
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
        clearPendingSpaceTimer();
        pendingSpaces = 0;
        repeatStartedAt = 0;
        if (!isSupported()) scheduleTriggeredReset();
        // Only fire when the key is genuinely still held and holds are armed.
        // The key-down check covers releases the editor itself never saw.
        if (isKeyDown() && canArm()) {
          triggered = true;
          onHold();
        } else {
          triggered = false;
        }
      },
      Math.max(0, HOLD_TO_VOICE_MS - elapsed),
    );
  };

  editor.wantsKeyRelease = true;
  editor.handleInput = (data: string): void => {
    const supported = isSupported();
    const space = isSpace(data);

    // A hold already opened the overlay from this key press. The overlay steals
    // focus, so this editor never sees the Space release; the extension re-enables
    // holds once the key is released. Until then, swallow Space and pass other
    // input through untouched.
    if (isSuppressed()) {
      wasSuppressed = true;
      if (!space) originalHandleInput(data);
      return;
    }
    if (wasSuppressed) {
      wasSuppressed = false;
      resetHoldTracking();
    }

    if (!supported) {
      if (!space) {
        // Typing resumes: the buffered Spaces were real typing, so commit them
        // in order before the character, then drop hold tracking.
        commitPendingSpaces();
        resetHoldTracking();
        originalHandleInput(data);
        return;
      }

      if (triggered) {
        scheduleTriggeredReset();
        return;
      }

      // Post-close cooldown: plain Space passthrough, no hold detection.
      if (!canArm()) {
        originalHandleInput(" ");
        return;
      }

      // A hold is already armed and waiting for the deadline; later repeats
      // are part of the same hold and must not start a new burst (whose commit
      // timer would cancel the pending hold).
      if (holdTimer) return;

      if (pendingSpaceTimer === null) {
        // First event of a burst: buffer it instead of inserting, so a hold
        // never puts text into the editor.
        pendingSpaces = 1;
        repeatStartedAt = Date.now();
        pendingSpaceTimer = setTimeout(() => {
          pendingSpaceTimer = null;
          commitPendingSpaces();
          resetHoldTracking();
        }, SPACE_COMMIT_DELAY_MS);
        return;
      }

      // A repeat arrived before the buffered Space committed: this is a hold
      // candidate. Never commit the buffered events; count them instead.
      pendingSpaces++;
      clearPendingSpaceTimer();
      if (pendingSpaces >= HOLD_REPEAT_MIN_EVENTS) {
        startHoldTimer(Date.now() - repeatStartedAt);
      }
      return;
    }

    if (isRelease(data)) {
      if (space) {
        clearHoldTimer();
        if (!triggered) originalHandleInput(" ");
        triggered = false;
      }
      return;
    }
    if (!space) {
      // Any other key cancels an armed hold while typing.
      clearHoldTimer();
      originalHandleInput(data);
      return;
    }
    if (isRepeat(data)) return;
    if (triggered) triggered = false;
    if (!canArm()) return; // cooldown: the release will insert the Space normally
    if (holdTimer) return;
    startHoldTimer(0);
  };
  editor.dispose = (): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    clearPendingSpaceTimer();
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
  isSupported?: () => boolean;
  isSpace?: (data: string) => boolean;
  isRelease?: (data: string) => boolean;
  isRepeat?: (data: string) => boolean;
  /** While true, ignore Space so a single hold can't reopen the overlay. */
  isSuppressed?: () => boolean;
  /** Whether the Space key is physically down, from the terminal-level listener. */
  isKeyDown?: () => boolean;
  /** Whether a new hold may be armed right now (false during the post-close cooldown). */
  canArm?: () => boolean;
}
