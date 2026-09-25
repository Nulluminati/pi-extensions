/**
 * Worktree provisioning: materialize the bundled guidance skill per project.
 *
 * The skill ships with the extension (assets/provision-skill/SKILL.md) and is
 * written into the project's skill directory on demand. Its frontmatter
 * carries a `provision-skill-version` stamp: a missing destination is
 * created, a lower (or absent) version is overwritten with the bundle, and
 * an equal version is left untouched so user-side state never fights the
 * bundle. Deleting the destination resets to the bundled default.
 */

// --- Imports ---
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionSkillPath } from "./types.ts";

// --- Constants ---

/** The bundled guidance skill, resolved relative to this module. */
const BUNDLED_SKILL_PATH = fileURLToPath(
  new URL("../../assets/provision-skill/SKILL.md", import.meta.url),
);

/** Frontmatter line carrying the bundle's guidance revision. */
const VERSION_LINE = /^\s*provision-skill-version:\s*(\d+)\s*$/m;

/** Frontmatter block: between the opening `---` and the closing `---`. */
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;

// --- Types ---

export interface MaterializeProvisionSkillResult {
  path: string;
  wrote: boolean;
  reason: "created" | "upgraded" | "unchanged";
}

// --- Helpers ---

function readBundledSkill(): string {
  return readFileSync(BUNDLED_SKILL_PATH, "utf8");
}

/** The frontmatter block of a skill file, or "" when the file has none. */
function frontmatterOf(text: string): string {
  return FRONTMATTER_BLOCK.exec(text)?.[1] ?? "";
}

/** `provision-skill-version` from a file's frontmatter, or null when absent. */
function skillVersion(text: string): number | null {
  const match = VERSION_LINE.exec(frontmatterOf(text));
  return match ? Number(match[1]) : null;
}

// --- Extension ---

/**
 * Write the bundled skill into the project's skill directory when its
 * version differs from the destination (or the destination is missing).
 */
export async function materializeProvisionSkill(
  cwd: string,
): Promise<MaterializeProvisionSkillResult> {
  const bundled = readBundledSkill();
  const path = provisionSkillPath(cwd);
  await mkdir(dirname(path), { recursive: true });

  let destination: string | null = null;
  try {
    destination = await readFile(path, "utf8");
  } catch {
    destination = null;
  }

  const bundledVersion = skillVersion(bundled);
  const destinationVersion = destination === null ? null : skillVersion(destination);
  if (destination !== null && destinationVersion === bundledVersion) {
    return { path, wrote: false, reason: "unchanged" };
  }

  // Atomic write: tmp file in the destination dir, then rename over.
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, bundled);
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }

  return {
    path,
    wrote: true,
    reason: destination === null ? "created" : "upgraded",
  };
}

/** The bundled skill's frontmatter `description`, for trigger assertions. */
export function provisionSkillDescription(): string {
  const description = /^description:\s*(.+)$/m.exec(frontmatterOf(readBundledSkill()))?.[1]?.trim();
  if (!description) {
    throw new Error(`bundled provision skill has no description: ${BUNDLED_SKILL_PATH}`);
  }
  return description;
}
