import { vi } from "vitest";

/**
 * Unit tests use the real `@earendil-works/pi-tui` exports except
 * `isKittyProtocolActive`. The real function reports process-wide terminal
 * state set by the TUI at startup; tests control it with
 * `vi.mocked(isKittyProtocolActive)`.
 */
vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-tui")>()),
  isKittyProtocolActive: vi.fn(() => false),
}));
