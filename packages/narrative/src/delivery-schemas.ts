import type { JsonSchemaContract, StructuredValidator } from "@narralume/llm";
import { z } from "zod";

const EntitySchema = z.object({
  type: z.enum([
    "character",
    "location",
    "organization",
    "item",
    "rule",
    "concept",
  ]),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(20),
  description: z.string().min(1).max(20_000),
});

export const StyleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  rules: z.array(z.string().min(1).max(2_000)).min(2).max(20),
  negativeRules: z.array(z.string().min(1).max(2_000)).max(20),
  examples: z.array(z.string().min(1).max(1_000)).max(6),
});

export type StyleProfileDraft = z.infer<typeof StyleSchema>;

/** 贴样文提炼风格档案的结构化契约（与导入分析中的 style 子契约同构）。 */
export const STYLE_PROFILE_CONTRACT: JsonSchemaContract = {
  name: "style_profile",
  description:
    "An actionable style profile draft distilled from a writing sample.",
  strict: true,
  schema: styleContract(),
};

const SkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  instructions: z.string().min(1).max(20_000),
  scopes: z
    .array(z.enum(["all", "chapter", "cocreate", "edit", "review"]))
    .min(1)
    .max(5),
  priority: z.number().int().min(0).max(100),
});

const EvidenceParagraphsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(5)
  .refine((ordinals) => new Set(ordinals).size === ordinals.length, {
    message: "段号不得重复",
  });

const RelationshipSchema = z.object({
  fromName: z.string().min(1).max(200),
  toName: z.string().min(1).max(200),
  relation: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  evidenceParagraphs: EvidenceParagraphsSchema,
});

const TimelineSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(2_000),
  sequence: z.number().int().nonnegative(),
  participantNames: z.array(z.string().min(1).max(200)).max(20),
  evidenceParagraphs: EvidenceParagraphsSchema,
});

const ForeshadowSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(2_000),
  evidenceParagraphs: EvidenceParagraphsSchema,
});

const CharacterArcSchema = z.object({
  characterName: z.string().min(1).max(200),
  startState: z.string().min(1).max(2_000),
  turningPoint: z.string().min(1).max(2_000),
  direction: z.string().min(1).max(2_000),
  evidenceParagraphs: EvidenceParagraphsSchema,
});

const SceneAnalysisSchema = z.object({
  title: z.string().min(1).max(300),
  goal: z.string().min(1).max(2_000),
  conflict: z.string().min(1).max(2_000),
  outcome: z.string().min(1).max(2_000),
  evidenceParagraphs: EvidenceParagraphsSchema,
});

export const ImportAnalysisSchema = z.object({
  title: z.string().min(1).max(300),
  synopsis: z.string().min(1).max(30_000),
  themes: z.array(z.string().min(1).max(200)).max(20),
  audience: z.string().min(1).max(2_000),
  tone: z.string().min(1).max(2_000),
  boundaries: z.array(z.string().min(1).max(2_000)).max(20),
  entities: z.array(EntitySchema).max(80),
  style: StyleSchema,
  skills: z.array(SkillSchema).max(12),
  relationships: z.array(RelationshipSchema).max(80),
  timeline: z.array(TimelineSchema).max(200),
  foreshadows: z.array(ForeshadowSchema).max(80),
  characterArcs: z.array(CharacterArcSchema).max(80),
  scenes: z.array(SceneAnalysisSchema).max(300),
});

export type ImportAnalysis = z.infer<typeof ImportAnalysisSchema>;

export const IMPORT_ANALYSIS_CONTRACT: JsonSchemaContract = {
  name: "import_analysis",
  description:
    "Reviewable story, entity, style, and writing skill candidates extracted from imported fiction.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "synopsis",
      "themes",
      "audience",
      "tone",
      "boundaries",
      "entities",
      "style",
      "skills",
      "relationships",
      "timeline",
      "foreshadows",
      "characterArcs",
      "scenes",
    ],
    properties: {
      title: { type: "string", minLength: 1 },
      synopsis: { type: "string", minLength: 1 },
      themes: { type: "array", maxItems: 20, items: { type: "string" } },
      audience: { type: "string", minLength: 1 },
      tone: { type: "string", minLength: 1 },
      boundaries: {
        type: "array",
        maxItems: 20,
        items: { type: "string" },
      },
      entities: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "name", "aliases", "description"],
          properties: {
            type: {
              type: "string",
              enum: [
                "character",
                "location",
                "organization",
                "item",
                "rule",
                "concept",
              ],
            },
            name: { type: "string", minLength: 1 },
            aliases: {
              type: "array",
              maxItems: 20,
              items: { type: "string" },
            },
            description: { type: "string", minLength: 1 },
          },
        },
      },
      style: styleContract(),
      skills: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "description",
            "instructions",
            "scopes",
            "priority",
          ],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            instructions: { type: "string", minLength: 1 },
            scopes: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "string",
                enum: ["all", "chapter", "cocreate", "edit", "review"],
              },
            },
            priority: { type: "integer", minimum: 0, maximum: 100 },
          },
        },
      },
      relationships: {
        type: "array",
        maxItems: 80,
        items: evidenceObject({
          fromName: { type: "string", minLength: 1 },
          toName: { type: "string", minLength: 1 },
          relation: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
        }),
      },
      timeline: {
        type: "array",
        maxItems: 200,
        items: evidenceObject({
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          sequence: { type: "integer", minimum: 0 },
          participantNames: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
          },
        }),
      },
      foreshadows: {
        type: "array",
        maxItems: 80,
        items: evidenceObject({
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
        }),
      },
      characterArcs: {
        type: "array",
        maxItems: 80,
        items: evidenceObject({
          characterName: { type: "string", minLength: 1 },
          startState: { type: "string", minLength: 1 },
          turningPoint: { type: "string", minLength: 1 },
          direction: { type: "string", minLength: 1 },
        }),
      },
      scenes: {
        type: "array",
        maxItems: 300,
        items: evidenceObject({
          title: { type: "string", minLength: 1 },
          goal: { type: "string", minLength: 1 },
          conflict: { type: "string", minLength: 1 },
          outcome: { type: "string", minLength: 1 },
        }),
      },
    },
  },
};

export function deliveryValidator<T>(
  schema: z.ZodType<T>,
  semantic?: (value: T) => readonly string[],
): StructuredValidator<T> {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return {
        success: false,
        issues: result.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      };
    }
    const issues = semantic?.(result.data) ?? [];
    return issues.length > 0
      ? { success: false, issues }
      : { success: true, data: result.data };
  };
}

function styleContract(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "rules", "negativeRules", "examples"],
    properties: {
      name: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      rules: {
        type: "array",
        minItems: 2,
        maxItems: 20,
        items: { type: "string" },
      },
      negativeRules: {
        type: "array",
        maxItems: 20,
        items: { type: "string" },
      },
      examples: {
        type: "array",
        maxItems: 6,
        items: { type: "string" },
      },
    },
  };
}

function evidenceObject(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...Object.keys(properties), "evidenceParagraphs"],
    properties: {
      ...properties,
      evidenceParagraphs: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        items: { type: "integer", minimum: 1 },
      },
    },
  };
}
