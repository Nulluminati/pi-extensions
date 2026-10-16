import type { ClassifierContext } from "pi";
import { Type } from "typebox";

// --- Constants ---

export const MAX_REQUEST_BYTES = 65_536;
const nonBlank = Type.String({ minLength: 1, pattern: "\\S" });
const probability = Type.Number({ minimum: 0, maximum: 1 });

const questionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: nonBlank,
      criteria: Type.Object({ true: nonBlank, false: nonBlank }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: nonBlank,
      criteria: Type.Record(Type.String(), nonBlank, { minProperties: 2, maxProperties: 255 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: nonBlank,
      criteria: Type.Array(nonBlank, { minItems: 2, maxItems: 10 }),
    },
    { additionalProperties: false },
  ),
]);

export const JEV_PARAMETERS = Type.Object(
  {
    state: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "JSON object containing the evidence to judge. Wrap plain text as { text: ... }. Only supplied state and questions reach the classifier; exclude secrets.",
    }),
    questions: Type.Record(Type.String(), questionSchema, {
      minProperties: 1,
      maxProperties: 64,
      description:
        "1–64 independent questions keyed by unique, nonblank IDs. Use bool for probability of yes, choice for one option, or score for ordered rubric levels. Questions cannot see other answers.",
    }),
    model: Type.Optional(
      Type.String({
        pattern: "^[^/\\s]+/\\S+$",
        description:
          "Pi classifier provider/model-id. Defaults to typesafe/jev-latest. Example: openrouter/typesafe/jev-1.13. Uses Pi credentials; never falls back to another model.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const JEV_OUTPUT = Type.Union([
  Type.Object({
    status: Type.Literal("ok"),
    provider: Type.String(),
    model: Type.String(),
    fullResultPath: Type.Optional(Type.String()),
    answers: Type.Record(
      Type.String(),
      Type.Union([
        Type.Object({ type: Type.Literal("bool"), probability }),
        Type.Object({
          type: Type.Literal("choice"),
          choice: Type.String(),
          probabilities: Type.Record(Type.String(), probability),
          confidence: probability,
        }),
        Type.Object({
          type: Type.Literal("score"),
          score: Type.Number({ minimum: 0 }),
          confidence: probability,
        }),
      ]),
    ),
    usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    status: Type.Literal("error"),
    error: Type.String(),
    fullResultPath: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
]);

export interface JevParameters {
  state: ClassifierContext["state"];
  questions: ClassifierContext["questions"];
  model?: string;
}
