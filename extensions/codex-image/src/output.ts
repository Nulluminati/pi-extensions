/**
 * Image input/output helpers for the codex-image extension.
 *
 * `loadInputImages` turns local image files into `data:` URIs for the model,
 * validating byte signatures so mislabeled files are rejected. `saveImage`
 * persists a returned PNG into the project's extension state directory and
 * keeps that directory out of `git status` via the local exclude file.
 */

import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { excludeFromGit } from "../../../lib/git.ts";
import { projectStateDir, projectStateRelative } from "../../../lib/paths.ts";

// --- Constants ---

/** Maximum number of images accepted per request. */
export const MAX_INPUT_IMAGES = 5;

/** Maximum accepted size for a single input image file. */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const IMAGES_DIR_NAME = "images";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const SLUG_PATTERN = /[^a-z0-9]+/g;
const MAX_SLUG_LENGTH = 40;
const NAME_ATTEMPTS = 5;

// --- Errors ---

function fail(message: string): never {
  throw new Error(`codex-image: ${message}`);
}

// --- Signatures ---

/** Image MIME type when the buffer starts with a known signature, else undefined. */
function detectImageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, RIFF_SIGNATURE.length).equals(RIFF_SIGNATURE) &&
    bytes.subarray(8, 12).equals(WEBP_SIGNATURE)
  ) {
    return "image/webp";
  }
  return undefined;
}

// --- Input ---

export async function loadInputImages(paths: string[], cwd: string): Promise<string[]> {
  if (paths.length > MAX_INPUT_IMAGES) {
    fail(`at most ${MAX_INPUT_IMAGES} images can be sent (got ${paths.length})`);
  }

  const uris: string[] = [];
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    let stats: Stats;
    try {
      stats = await stat(absolute);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") fail(`"${path}" does not exist`);
      throw error;
    }
    if (stats.isDirectory()) fail(`"${path}" is a directory`);
    if (stats.size === 0) fail(`"${path}" is empty`);
    if (stats.size > MAX_INPUT_BYTES) {
      fail(`"${path}" is too large (${stats.size} bytes; limit is ${MAX_INPUT_BYTES} bytes)`);
    }

    const bytes = await readFile(absolute);
    const mime = detectImageMime(bytes);
    if (mime === undefined)
      fail(`"${path}" is not a supported image (PNG, JPEG, or WebP required)`);
    uris.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  return uris;
}

// --- Output ---

/** Decode a base64 payload and require a PNG byte signature. */
function decodePng(base64: string): Buffer {
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
    fail("image payload is not valid base64");
  }
  const png = Buffer.from(base64, "base64");
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("image payload is not a PNG file");
  }
  return png;
}

/** Reduce a prompt to a safe lowercase file-name stem. */
function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(SLUG_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? "image" : slug;
}

export async function saveImage(base64: string, cwd: string, prompt: string): Promise<string> {
  const png = decodePng(base64);
  const imagesDir = projectStateDir(cwd, IMAGES_DIR_NAME);
  await mkdir(imagesDir, { recursive: true });

  // Keep generated images out of `git status`; best-effort outside repos.
  try {
    await excludeFromGit(cwd, `${projectStateRelative(IMAGES_DIR_NAME)}/`);
  } catch {
    // Git hygiene must never fail the save itself.
  }

  // Exclusive create plus a random suffix: a collision only re-rolls the
  // suffix, so an existing image is never overwritten.
  const stem = slugify(prompt);
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const target = join(imagesDir, `${stem}-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
    try {
      await writeFile(target, png, { flag: "wx" });
      return target;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  fail(`could not create a unique image file in ${imagesDir}`);
}
