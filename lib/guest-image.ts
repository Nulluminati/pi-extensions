/**
 * Optional custom Gondolin guest image resolver.
 *
 * The image (alpine + git, built from extensions/gondolin/guest-image.json)
 * lives at `~/.cache/pi-gondolin/guest` with a manifest.json marking a
 * complete build. It is optional: an undefined result means callers fall back
 * to the SDK's default registry image (alpine-base, no git).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./paths.ts";

// --- Constants ---
const GUEST_DIR = "guest";
const MANIFEST_FILE = "manifest.json";

/**
 * Host path of the custom guest image, or undefined when none is built.
 * The image is optional — absent image means the SDK's default registry
 * image (alpine-base, no git).
 */
export function resolveGuestImagePath(): string | undefined {
  const guestDir = join(cacheDir("gondolin"), GUEST_DIR);
  if (!existsSync(join(guestDir, MANIFEST_FILE))) return undefined;
  return guestDir;
}
