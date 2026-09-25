import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  materializeProvisionSkill,
  provisionSkillDescription,
} from "../../extensions/agents/src/provision/skill.ts";
import { provisionSkillPath } from "../../extensions/agents/src/provision/types.ts";

// --- Constants ---

const BUNDLED_SKILL = fileURLToPath(
  new URL("../../extensions/agents/assets/provision-skill/SKILL.md", import.meta.url),
);
const STALE_SKILL = [
  "---",
  "name: provision",
  "description: stale guidance",
  "metadata:",
  "  provision-skill-version: 0",
  "---",
  "",
  "outdated body",
  "",
].join("\n");

// --- Tests ---

describe("provision-skill-extension", () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "provision-skill-"));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it("materializeProvisionSkill creates the skill on a fresh project", async () => {
    const result = await materializeProvisionSkill(project);

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe("created");
    expect(result.path).toBe(provisionSkillPath(project));

    const text = await readFile(provisionSkillPath(project), "utf8");
    const frontmatter = frontmatterOf(text);
    expect(frontmatter).toMatch(/^name: provision$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
    expect(frontmatter).toMatch(/provision-skill-version:\s*1\b/);
  });

  it("materializeProvisionSkill leaves an equal-version copy untouched", async () => {
    await materializeProvisionSkill(project);
    const path = provisionSkillPath(project);
    const first = await stat(path);

    await sleep(20);
    const result = await materializeProvisionSkill(project);
    const second = await stat(path);

    expect(result).toEqual({ path, wrote: false, reason: "unchanged" });
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it("materializeProvisionSkill upgrades a lower-version copy to the bundled content", async () => {
    const path = provisionSkillPath(project);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, STALE_SKILL);

    const result = await materializeProvisionSkill(project);

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe("upgraded");
    expect(await readFile(path, "utf8")).toBe(await readFile(BUNDLED_SKILL, "utf8"));
  });

  it("provisionSkillDescription matches the bundled file's frontmatter", async () => {
    const bundled = await readFile(BUNDLED_SKILL, "utf8");
    const expected = /^description:\s*(.+)$/m.exec(bundled)?.[1]?.trim();

    expect(expected).toBeTruthy();
    expect(provisionSkillDescription()).toBe(expected);
  });

  it("routes on both triggers: delegate provision-config pointers and worker blockers", () => {
    const description = provisionSkillDescription();
    expect(description).toContain("provision config");
    expect(description).toContain("blocker");
  });

  it("keeps the description within the Agent Skills 1024-char limit", () => {
    expect(provisionSkillDescription().length).toBeLessThanOrEqual(1024);
  });

  it("bundled body keeps all five ecosystem examples", async () => {
    const text = await readFile(BUNDLED_SKILL, "utf8");
    for (const heading of [
      "npm",
      "python (uv)",
      "rust (cargo)",
      "elixir (mix)",
      "monorepo script",
    ]) {
      expect(text, `missing example heading: ${heading}`).toMatch(
        new RegExp(`^### ${escapeRegExp(heading)}$`, "m"),
      );
    }
  });

  it("bundled mechanism-order section names carry, share, and provision", async () => {
    const text = await readFile(BUNDLED_SKILL, "utf8");
    const section = /^## Mechanism[^\n]*\n[\s\S]*?(?=^## )/m.exec(text)?.[0];

    expect(section).toBeTruthy();
    for (const primitive of ["carry", "share", "provision"]) {
      expect(section).toContain(primitive);
    }
  });

  it("bundled skill stays under the 150-line cap", async () => {
    const text = await readFile(BUNDLED_SKILL, "utf8");
    expect(text.split("\n").length).toBeLessThan(150);
  });
});

// --- Helpers ---

function frontmatterOf(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) throw new Error("bundled skill has no frontmatter block");
  return match[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
