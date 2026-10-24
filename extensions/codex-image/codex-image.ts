// biome-ignore assist/source/organizeImports: Runtime imports precede Pi types in extension entrypoints.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodexCredentials } from "./src/auth.ts";
import { getCodexResponseModel } from "./src/config.ts";
import { generateHostedImage } from "./src/hosted.ts";
import { loadInputImages, MAX_INPUT_IMAGES, saveImage } from "./src/output.ts";

// --- Constants ---

const CODEX_PROVIDER = "openai-codex";
const FALLBACK_RESPONSE_MODEL = "gpt-6.1-sol";
const UNSUPPORTED_CODEX_MODEL = "model is not supported when using Codex with a ChatGPT account";

// --- Extension ---

export default async function codexImageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Create a PNG image from a prompt, or edit up to five local images using Codex image generation. Save the result in the current project's image directory.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Describe the image or the changes to make." }),
      inputImages: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Local PNG, JPEG, or WebP image paths to edit or use as references (up to five).",
          maxItems: MAX_INPUT_IMAGES,
        }),
      ),
      size: Type.Optional(
        Type.String({ description: "Image dimensions, for example 1024x1024. Defaults to auto." }),
      ),
      quality: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ]),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("Image prompt must not be empty.");
      if (params.inputImages && params.inputImages.length > MAX_INPUT_IMAGES) {
        throw new Error(`Use no more than ${MAX_INPUT_IMAGES} input images.`);
      }

      const requestSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const inputImages = params.inputImages?.length
        ? await loadInputImages(params.inputImages, ctx.cwd)
        : undefined;
      const credentials = await getCodexCredentials(requestSignal);
      // Prefer Pi's current Codex model: Pi already uses it with this account,
      // and Codex can reject the config.toml model for ChatGPT accounts.
      const piModel = ctx.model?.provider === CODEX_PROVIDER ? ctx.model.id : undefined;
      const responseModels = [
        ...new Set([
          ...(piModel ? [piModel] : []),
          await getCodexResponseModel(),
          FALLBACK_RESPONSE_MODEL,
        ]),
      ];
      const request = {
        prompt,
        ...(inputImages ? { inputImages } : {}),
        ...(params.size ? { size: params.size } : {}),
        ...(params.quality ? { quality: params.quality } : {}),
      };
      const onPartial = (partial: string) => {
        onUpdate?.({
          content: [{ type: "image", data: partial, mimeType: "image/png" }],
          details: undefined,
        });
      };
      let image: string | undefined;
      for (const [index, responseModel] of responseModels.entries()) {
        try {
          image = await generateHostedImage(
            { ...request, responseModel },
            credentials,
            requestSignal,
            onPartial,
          );
          break;
        } catch (error) {
          if (
            index === responseModels.length - 1 ||
            !(error instanceof Error) ||
            !error.message.includes(UNSUPPORTED_CODEX_MODEL)
          ) {
            throw error;
          }
        }
      }
      if (image === undefined) throw new Error("Codex returned no image.");
      const path = await saveImage(image, ctx.cwd, prompt);
      return {
        content: [
          { type: "text" as const, text: `Image saved to ${path}` },
          { type: "image" as const, data: image, mimeType: "image/png" },
        ],
        details: { path },
      };
    },
  });
}
