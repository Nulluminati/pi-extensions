import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadInputImages,
  MAX_INPUT_BYTES,
  MAX_INPUT_IMAGES,
  saveImage,
} from "../../extensions/codex-image/src/output.ts";
import { cleanGitEnv } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";

// --- Test fixtures ---

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00, 0x00, 0x00, 0x0d])]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
]);
const GIF_BYTES = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0x01, 0x00, 0x01, 0x00]),
]);

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function expectShortError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message.length).toBeLessThan(300);
  expect(message).not.toContain("base64,");
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

// --- loadInputImages ---

describe("loadInputImages", () => {
  it("maps png, jpeg, and webp files to data URIs by byte signature", async () => {
    const dir = await tempDir("codex-image-load-");
    const png = join(dir, "photo.png");
    const jpeg = join(dir, "snapshot.jpg");
    const webpDir = join(dir, "nested");
    await mkdir(webpDir);
    const webp = join(webpDir, "pic.webp");
    await writeFile(png, PNG_BYTES);
    await writeFile(jpeg, JPEG_BYTES);
    await writeFile(webp, WEBP_BYTES);

    const uris = await loadInputImages(["photo.png", jpeg, "nested/pic.webp"], dir);

    expect(uris).toEqual([
      `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`,
      `data:image/webp;base64,${WEBP_BYTES.toString("base64")}`,
    ]);
  });

  it("rejects more than the maximum number of images", async () => {
    const dir = await tempDir("codex-image-count-");
    const paths: string[] = [];
    for (let index = 0; index < MAX_INPUT_IMAGES + 1; index++) {
      const path = join(dir, `image-${index}.png`);
      await writeFile(path, PNG_BYTES);
      paths.push(path);
    }

    await expect(loadInputImages(paths, dir)).rejects.toThrow(/at most/i);
  });

  it("rejects a missing file", async () => {
    const dir = await tempDir("codex-image-missing-");

    await expect(loadInputImages([join(dir, "nope.png")], dir)).rejects.toThrow(/does not exist/);
  });

  it("rejects a directory", async () => {
    const dir = await tempDir("codex-image-dir-");
    const sub = join(dir, "sub");
    await mkdir(sub);

    await expect(loadInputImages([sub], dir)).rejects.toThrow(/directory/);
  });

  it("rejects an empty file", async () => {
    const dir = await tempDir("codex-image-empty-");
    const path = join(dir, "empty.png");
    await writeFile(path, Buffer.alloc(0));

    await expect(loadInputImages([path], dir)).rejects.toThrow(/empty/i);
  });

  it("rejects a file above the per-file size limit", async () => {
    const dir = await tempDir("codex-image-size-");
    const path = join(dir, "huge.png");
    await writeFile(path, Buffer.alloc(MAX_INPUT_BYTES + 1));

    await expect(loadInputImages([path], dir)).rejects.toThrow(/too large/i);
  });

  it("rejects files whose bytes are not png, jpeg, or webp, regardless of extension", async () => {
    const dir = await tempDir("codex-image-mime-");
    const gif = join(dir, "photo.png");
    const text = join(dir, "notes.txt");
    await writeFile(gif, GIF_BYTES);
    await writeFile(text, Buffer.from("just text", "utf8"));

    await expect(loadInputImages([gif], dir)).rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(loadInputImages([text], dir)).rejects.toThrow(/PNG, JPEG, or WebP/);
  });

  it("keeps error messages short so file contents never leak", async () => {
    const dir = await tempDir("codex-image-leak-");
    const oversized = join(dir, "big.png");
    const unsupported = join(dir, "odd.png");
    await writeFile(oversized, Buffer.alloc(MAX_INPUT_BYTES + 1));
    await writeFile(unsupported, GIF_BYTES);

    const errors: unknown[] = [];
    for (const path of [oversized, unsupported]) {
      try {
        await loadInputImages([path], dir);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(2);
    for (const error of errors) expectShortError(error);
  });
});

// --- saveImage ---

describe("saveImage", () => {
  it("writes the png under the project images state dir and returns its absolute path", async () => {
    const dir = await tempDir("codex-image-save-");
    const imagesDir = join(dir, projectStateRelative("images"));

    const result = await saveImage(PNG_BYTES.toString("base64"), dir, "a red square");

    expect(isAbsolute(result)).toBe(true);
    expect(basename(result)).toMatch(/\.png$/);
    expect(result.startsWith(imagesDir)).toBe(true);
    await expect(readFile(result)).resolves.toEqual(PNG_BYTES);
  });

  it("derives a filesystem-safe slug from the prompt", async () => {
    const dir = await tempDir("codex-image-slug-");

    const result = await saveImage(
      PNG_BYTES.toString("base64"),
      dir,
      "Hello, World!! A *very* odd prompt",
    );

    const stem = basename(result, extname(result));
    expect(stem.startsWith("hello-world-a-very-odd-prompt-")).toBe(true);
    expect(stem).toMatch(/^[a-z0-9-]+$/);
  });

  it("falls back to a generic stem when the prompt has no usable characters", async () => {
    const dir = await tempDir("codex-image-fallback-");

    const result = await saveImage(PNG_BYTES.toString("base64"), dir, "!!!");

    expect(basename(result, extname(result))).toMatch(/^image-[0-9a-f-]+$/);
  });

  it("rejects payloads that are not valid base64", async () => {
    const dir = await tempDir("codex-image-b64-");

    await expect(saveImage("not base64!!", dir, "prompt")).rejects.toThrow(/base64/);
    await expect(saveImage("", dir, "prompt")).rejects.toThrow(/base64/);
  });

  it("rejects payloads whose bytes are not png", async () => {
    const dir = await tempDir("codex-image-pngsig-");

    await expect(saveImage(JPEG_BYTES.toString("base64"), dir, "prompt")).rejects.toThrow(/PNG/);
  });

  it("never overwrites an existing image with the same slug", async () => {
    const dir = await tempDir("codex-image-collide-");

    const first = await saveImage(PNG_BYTES.toString("base64"), dir, "same prompt");
    const second = await saveImage(PNG_BYTES.toString("base64"), dir, "same prompt");

    expect(second).not.toBe(first);
    await expect(readFile(first)).resolves.toEqual(PNG_BYTES);
    await expect(readFile(second)).resolves.toEqual(PNG_BYTES);
  });

  it("excludes the images directory from git status", async () => {
    const dir = await tempDir("codex-image-git-");
    execFileSync("git", ["init", "-q"], { cwd: dir, env: cleanGitEnv() });

    await saveImage(PNG_BYTES.toString("base64"), dir, "tracked? no");

    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(`${projectStateRelative("images")}/`);
  });
});
