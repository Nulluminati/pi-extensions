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
  SPACE_REPEAT_WINDOW_MS,
} from "./constants.ts";

/** Herdr's child protocol can report Kitty support without upstream key releases. */
export function supportsKeyReleaseReporting(): boolean {
  return process.env.HERDR_ENV !== "1" && isKittyProtocolActive();
}

export function addHoldToVoice<T extends HoldToVoiceEditor>(
  editor: T,
  onHold: () => void,
  deps: HoldToVoiceDeps = {},
): T & { purgeHoldSpaces?: () => void } {
  const {
    isSupported = supportsKeyReleaseReporting,
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
  // Legacy mode (no key-release reporting): the first Space of a burst types
  // immediately so normal typing never lags. A repeat arriving within
  // SPACE_REPEAT_WINDOW_MS is a hold candidate: it is buffered instead of
  // typed, and enough buffered repeats arm the hold trigger, which then
  // removes the burst's typed Space before opening the overlay.
  let insertedSpaces = 0;
  let pendingSpaces = 0;
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
  /** Commit buffered repeat Spaces in order, as real typing. */
  const commitPendingSpaces = (): void => {
    for (let i = 0; i < pendingSpaces; i++) originalHandleInput(" ");
    pendingSpaces = 0;
  };
  /** Drop all hold tracking without touching editor text or inserting anything. */
  const resetHoldTracking = (): void => {
    clearHoldTimer();
    clearRepeatGapTimer();
    insertedSpaces = 0;
    pendingSpaces = 0;
    repeatStartedAt = 0;
    triggered = false;
  };
  /** Remove the typed Space of an unresolved hold burst; a no-op otherwise. */
  const purgeHoldSpaces = (): void => {
    const text = (editor as { getText?: () => string }).getText?.();
    // A moved cursor means the burst Space may no longer sit behind it.
    if (typeof text === "string" && !text.endsWith(" ")) {
      insertedSpaces = 0;
      pendingSpaces = 0;
      return;
    }
    for (; insertedSpaces > 0; insertedSpaces--) originalHandleInput("\x7f");
    pendingSpaces = 0;
  };
  const wrapped = editor as T & { purgeHoldSpaces?: () => void };
  wrapped.purgeHoldSpaces = purgeHoldSpaces;
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
        pendingSpaces = 0;
        repeatStartedAt = 0;
        if (!isSupported()) scheduleTriggeredReset();
        // Only fire when the key is genuinely still held and holds are armed.
        // The key-down check covers releases the editor itself never saw.
        if (isKeyDown() && canArm()) {
          // The burst's first Space was typed immediately, so a trigger takes
          // it back rather than leaving text behind.
          for (; insertedSpaces > 0; insertedSpaces--) originalHandleInput("\x7f");
          insertedSpaces = 0;
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
    // Repeat-based detection must not treat optional releases as more presses.
    if (!supported && isRelease(data)) return;

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

      // A stale burst (no repeat within the window) is plain typing again.
      if (
        (insertedSpaces > 0 || pendingSpaces > 0) &&
        Date.now() - repeatStartedAt > SPACE_REPEAT_WINDOW_MS
      )
        resetHoldTracking();

      if (insertedSpaces === 0 && pendingSpaces === 0) {
        // First Space of a burst: type it immediately so normal typing never
        // waits. A following repeat classifies the burst as a hold candidate.
        insertedSpaces = 1;
        repeatStartedAt = Date.now();
        originalHandleInput(" ");
        return;
      }

      // A repeat within the window is a hold candidate: buffer it instead of
      // typing it, and arm the hold once the burst is long enough.
      pendingSpaces++;
      if (insertedSpaces + pendingSpaces >= HOLD_REPEAT_MIN_EVENTS)
        startHoldTimer(Date.now() - repeatStartedAt);
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
    originalDispose?.();
  };
  return wrapped;
}

interface HoldToVoiceEditor {
  handleInput(data: string): void;
  wantsKeyRelease?: boolean;
  getText?: () => string;
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
