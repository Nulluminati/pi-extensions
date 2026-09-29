/**
 * Raw byte matchers for arrow keys.
 *
 * Terminals send arrow keys in two encodings: CSI sequences (`\u001b[A`) and
 * application-cursor keys (`\u001bOA`). These predicates are the fallback
 * path for dialogs that must stay navigable when no keybinding manager is
 * available or the manager has no binding registered; the manager resolves
 * kitty-protocol CSI sequences and user rebindings that raw byte checks miss.
 */

export function isArrowUp(data: string): boolean {
  return data === "\u001b[A" || data === "\u001bOA";
}

export function isArrowDown(data: string): boolean {
  return data === "\u001b[B" || data === "\u001bOB";
}

export function isArrowRight(data: string): boolean {
  return data === "\u001b[C" || data === "\u001bOC";
}

export function isArrowLeft(data: string): boolean {
  return data === "\u001b[D" || data === "\u001bOD";
}
