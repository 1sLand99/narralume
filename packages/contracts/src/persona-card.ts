import { z } from "zod";
import { CharacterCardV3LorebookSchema } from "./lore.js";

/** Product limits apply to decoded card content, not the Base64 request size. */
export const PERSONA_CARD_LIMITS = {
  jsonBytes: 2 * 1024 * 1024,
  pngBytes: 10 * 1024 * 1024,
  aggregateTextChars: 250_000,
  nameChars: 200,
  descriptionChars: 20_000,
  profileTextChars: 30_000,
  exampleDialogueChars: 100_000,
  greetingChars: 30_000,
  greetings: 64,
  creatorNameChars: 200,
  creatorNotesChars: 30_000,
  creatorVersionChars: 200,
  tags: 100,
  tagChars: 100,
  multilingualCreatorNotes: 32,
  sourceEntries: 100,
  sourceEntryChars: 2_000,
  assets: 100,
  assetTypeChars: 100,
  assetNameChars: 200,
  assetExtensionChars: 32,
  assetUriChars: 2 * 1024 * 1024,
  reportItems: 128,
} as const;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const NullableProfileTextSchema = z
  .string()
  .max(PERSONA_CARD_LIMITS.profileTextChars)
  .nullable();
const GreetingSchema = z
  .string()
  .trim()
  .min(1)
  .max(PERSONA_CARD_LIMITS.greetingChars);
const TagSchema = z.string().trim().min(1).max(PERSONA_CARD_LIMITS.tagChars);

export const PersonaCardSourceFormatSchema = z.enum([
  "native",
  "character-card-v2",
  "character-card-v3",
]);

const PersonaCardProfileObjectSchema = z
  .object({
    personality: NullableProfileTextSchema,
    scenario: NullableProfileTextSchema,
    exampleDialogue: z
      .string()
      .max(PERSONA_CARD_LIMITS.exampleDialogueChars)
      .nullable(),
    greetings: z.array(GreetingSchema).max(PERSONA_CARD_LIMITS.greetings),
    creator: z
      .object({
        name: z.string().max(PERSONA_CARD_LIMITS.creatorNameChars).nullable(),
        notes: z.string().max(PERSONA_CARD_LIMITS.creatorNotesChars).nullable(),
        version: z
          .string()
          .max(PERSONA_CARD_LIMITS.creatorVersionChars)
          .nullable(),
        tags: z.array(TagSchema).max(PERSONA_CARD_LIMITS.tags),
      })
      .strict(),
    source: z
      .object({
        format: PersonaCardSourceFormatSchema,
        importedAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();

export const PersonaCardProfileSchema =
  PersonaCardProfileObjectSchema.superRefine((profile, context) => {
    enforceAggregateTextLimit(
      [
        profile.personality,
        profile.scenario,
        profile.exampleDialogue,
        ...profile.greetings,
        profile.creator.name,
        profile.creator.notes,
        profile.creator.version,
        ...profile.creator.tags,
      ],
      context,
    );
  });

const CardTextSchema = z.string().max(PERSONA_CARD_LIMITS.profileTextChars);
const CardGreetingSchema = z.string().max(PERSONA_CARD_LIMITS.greetingChars);
const CreatorNotesMultilingualSchema = z
  .record(
    z.string().min(1).max(20),
    z.string().max(PERSONA_CARD_LIMITS.creatorNotesChars),
  )
  .refine(
    (notes) =>
      Object.keys(notes).length <= PERSONA_CARD_LIMITS.multilingualCreatorNotes,
    "Too many multilingual creator notes",
  );
const CharacterCardV3AssetSchema = z
  .object({
    type: z.string().min(1).max(PERSONA_CARD_LIMITS.assetTypeChars),
    uri: z.string().min(1).max(PERSONA_CARD_LIMITS.assetUriChars),
    name: z.string().min(1).max(PERSONA_CARD_LIMITS.assetNameChars),
    ext: z.string().min(1).max(PERSONA_CARD_LIMITS.assetExtensionChars),
  })
  .strict();

const CharacterCardV3InputDataSchema = z
  .object({
    name: z.string().trim().min(1).max(PERSONA_CARD_LIMITS.nameChars),
    description: z.string().max(PERSONA_CARD_LIMITS.descriptionChars),
    personality: CardTextSchema,
    scenario: CardTextSchema,
    first_mes: CardGreetingSchema,
    mes_example: z.string().max(PERSONA_CARD_LIMITS.exampleDialogueChars),
    creator_notes: z.string().max(PERSONA_CARD_LIMITS.creatorNotesChars),
    system_prompt: CardTextSchema,
    post_history_instructions: CardTextSchema,
    alternate_greetings: z
      .array(CardGreetingSchema)
      .max(PERSONA_CARD_LIMITS.greetings),
    tags: z.array(TagSchema).max(PERSONA_CARD_LIMITS.tags),
    creator: z.string().max(PERSONA_CARD_LIMITS.creatorNameChars),
    character_version: z.string().max(PERSONA_CARD_LIMITS.creatorVersionChars),
    extensions: JsonObjectSchema,
    group_only_greetings: z
      .array(CardGreetingSchema)
      .max(PERSONA_CARD_LIMITS.greetings),
    character_book: CharacterCardV3LorebookSchema.optional(),
    assets: z
      .array(CharacterCardV3AssetSchema)
      .max(PERSONA_CARD_LIMITS.assets)
      .optional(),
    nickname: z.string().max(PERSONA_CARD_LIMITS.nameChars).optional(),
    creator_notes_multilingual: CreatorNotesMultilingualSchema.optional(),
    source: z
      .array(z.string().min(1).max(PERSONA_CARD_LIMITS.sourceEntryChars))
      .max(PERSONA_CARD_LIMITS.sourceEntries)
      .optional(),
    creation_date: z.number().int().nonnegative().optional(),
    modification_date: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((data, context) => {
    const greetingCount =
      (data.first_mes.trim().length > 0 ? 1 : 0) +
      data.alternate_greetings.length;
    if (greetingCount > PERSONA_CARD_LIMITS.greetings) {
      context.addIssue({
        code: "custom",
        path: ["alternate_greetings"],
        message: `A card can contain at most ${PERSONA_CARD_LIMITS.greetings} greetings`,
      });
    }
    enforceAggregateTextLimit(
      [
        data.name,
        data.description,
        data.personality,
        data.scenario,
        data.first_mes,
        data.mes_example,
        ...data.alternate_greetings,
        data.creator,
        data.creator_notes,
        data.character_version,
        ...data.tags,
        ...(data.character_book
          ? [
              data.character_book.name,
              data.character_book.description,
              ...data.character_book.entries.flatMap((entry) => [
                entry.name,
                entry.comment,
                entry.content,
                ...entry.keys,
                ...(entry.secondary_keys ?? []),
              ]),
            ]
          : []),
      ],
      context,
    );
  });

export const CharacterCardV3InputSchema = z
  .object({
    spec: z.literal("chara_card_v3"),
    spec_version: z.literal("3.0"),
    data: CharacterCardV3InputDataSchema,
  })
  .strict();

const EmptyExtensionsSchema = z.object({}).strict();
const CharacterCardV3ExportDataSchema = z
  .object({
    name: z.string().trim().min(1).max(PERSONA_CARD_LIMITS.nameChars),
    description: z.string().max(PERSONA_CARD_LIMITS.descriptionChars),
    personality: CardTextSchema,
    scenario: CardTextSchema,
    first_mes: CardGreetingSchema,
    mes_example: z.string().max(PERSONA_CARD_LIMITS.exampleDialogueChars),
    creator_notes: z.string().max(PERSONA_CARD_LIMITS.creatorNotesChars),
    system_prompt: z.literal(""),
    post_history_instructions: z.literal(""),
    alternate_greetings: z
      .array(CardGreetingSchema)
      .max(PERSONA_CARD_LIMITS.greetings),
    tags: z.array(TagSchema).max(PERSONA_CARD_LIMITS.tags),
    creator: z.string().max(PERSONA_CARD_LIMITS.creatorNameChars),
    character_version: z.string().max(PERSONA_CARD_LIMITS.creatorVersionChars),
    extensions: EmptyExtensionsSchema,
    group_only_greetings: z.array(z.string()).length(0),
  })
  .strict()
  .superRefine((data, context) => {
    const greetingCount =
      (data.first_mes.trim().length > 0 ? 1 : 0) +
      data.alternate_greetings.length;
    if (greetingCount > PERSONA_CARD_LIMITS.greetings) {
      context.addIssue({
        code: "custom",
        path: ["alternate_greetings"],
        message: `A card can contain at most ${PERSONA_CARD_LIMITS.greetings} greetings`,
      });
    }
    enforceAggregateTextLimit(
      [
        data.name,
        data.description,
        data.personality,
        data.scenario,
        data.first_mes,
        data.mes_example,
        ...data.alternate_greetings,
        data.creator,
        data.creator_notes,
        data.character_version,
        ...data.tags,
      ],
      context,
    );
  });

export const CharacterCardV3ExportSchema = z
  .object({
    spec: z.literal("chara_card_v3"),
    spec_version: z.literal("3.0"),
    data: CharacterCardV3ExportDataSchema,
  })
  .strict();

export const PersonaCardImportDispositionSchema = z.enum([
  "imported",
  "ignored",
  "unsupported",
]);
export const PERSONA_CARD_IMPORT_REASON_CODES = [
  "safe-field",
  "creator-metadata",
  "prompt-override-blocked",
  "extension-not-executed",
  "character-book-imported",
  "asset-deferred",
  "group-greeting-deferred",
  "unknown-field-ignored",
] as const;
export const PersonaCardImportReasonCodeSchema = z.enum(
  PERSONA_CARD_IMPORT_REASON_CODES,
);
export const PersonaCardImportReportItemSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    disposition: PersonaCardImportDispositionSchema,
    reasonCode: PersonaCardImportReasonCodeSchema,
  })
  .strict();
export const PersonaCardImportReportSchema = z
  .object({
    sourceFormat: z.enum(["character-card-v3-json", "character-card-v3-png"]),
    specVersion: z.literal("3.0"),
    items: z
      .array(PersonaCardImportReportItemSchema)
      .max(PERSONA_CARD_LIMITS.reportItems),
  })
  .strict();

export type PersonaCardProfileDto = z.infer<typeof PersonaCardProfileSchema>;
export type CharacterCardV3Input = z.infer<typeof CharacterCardV3InputSchema>;
export type CharacterCardV3Export = z.infer<typeof CharacterCardV3ExportSchema>;
export type PersonaCardImportDisposition = z.infer<
  typeof PersonaCardImportDispositionSchema
>;
export type PersonaCardImportReasonCode = z.infer<
  typeof PersonaCardImportReasonCodeSchema
>;
export type PersonaCardImportReportItem = z.infer<
  typeof PersonaCardImportReportItemSchema
>;
export type PersonaCardImportReport = z.infer<
  typeof PersonaCardImportReportSchema
>;

function enforceAggregateTextLimit(
  values: readonly (string | null | undefined)[],
  context: z.RefinementCtx,
): void {
  const total = values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  if (total <= PERSONA_CARD_LIMITS.aggregateTextChars) return;
  context.addIssue({
    code: "custom",
    message: `Retained card text can contain at most ${PERSONA_CARD_LIMITS.aggregateTextChars} characters`,
  });
}
