import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMP_DIR_PREFIX, TEMP_FILE_NAME } from "./constants.ts";

// --- Truncation ---

async function spillToTempFile(content: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const tempFile = join(tempDir, TEMP_FILE_NAME);
  await writeFile(tempFile, content, "utf8");
  return tempFile;
}

export async function truncateWithSpill(
  text: string,
  maxChars: number,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const truncated = text.slice(0, maxChars);
  let fullOutputPath: string | undefined;
  try {
    fullOutputPath = await spillToTempFile(text);
  } catch {
    // If spill fails, still truncate but don't report path
  }

  const note = `\n\n[Response truncated at ${maxChars} characters. Full content was ${text.length} characters.]`;
  if (fullOutputPath) {
    return {
      text: `${truncated}${note}\n\nFull content saved to: ${fullOutputPath}`,
      truncated: true,
      fullOutputPath,
    };
  }

  return { text: truncated + note, truncated: true };
}
