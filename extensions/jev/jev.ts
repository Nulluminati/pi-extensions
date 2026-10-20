import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeJev } from "./src/judge.ts";
import { JEV_OUTPUT, JEV_PARAMETERS } from "./src/schema.ts";

// --- Extension ---

export default async function jevExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "jev",
    label: "Jev judgment",
    description:
      "Ask Jev for typed judgments about supplied evidence. Batch independent yes/no probabilities (bool), closed-set choices, and rubric scores. Returns answers, uncertainty, model identity, and reported usage. Sends supplied state and questions to the selected provider; never runs actions or reads files.",
    promptSnippet: "Ask Jev for batched typed judgments about supplied evidence",
    promptGuidelines: [
      "Use jev for semantic classification, evidence checks, relevance ranking, or bounded choices over supplied state. Use code for exact matches, calculations, and tests.",
      "Batch independent questions over the same state. Questions cannot see one another's answers. Include all relevant evidence and a no-match option when appropriate.",
      "Use bool for probability of yes, not intensity. Use score for degree on ordered levels; the score ranges from zero to the last level index. Choice confidence measures distribution concentration, not factual correctness.",
      "Jev judgments are advisory, not proof, test results, or permission. Keep uncertainty visible. Do not repeat an unchanged judgment to seek a preferred answer.",
      "Only supplied state and questions reach the classifier. Exclude secrets and private material that must not leave the machine. The tool does not fetch evidence or read session history.",
    ],
    parameters: JEV_PARAMETERS,
    outputSchema: JEV_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => executeJev(params, signal, ctx),
  });
}
