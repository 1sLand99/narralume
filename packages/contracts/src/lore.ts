import { z } from "zod";

export const LOREBOOK_LIMITS = {
  nameChars: 300,
  descriptionChars: 20_000,
  titleChars: 300,
  contentChars: 100_000,
  keyChars: 500,
  keysPerEntry: 64,
  entriesPerBook: 2_000,
  booksPerBinding: 200,
  scanTurnsMin: 0,
  scanTurnsMax: 200,
  priorityMin: -1_000_000,
  priorityMax: 1_000_000,
  activationCandidates: 10_000,
  activationBudgetChars: 1_000_000,
} as const;

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const VersionSchema = z.number().int().nonnegative();
const LorebookNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LOREBOOK_LIMITS.nameChars);
const LorebookDescriptionSchema = z
  .string()
  .trim()
  .max(LOREBOOK_LIMITS.descriptionChars)
  .nullable();
const ScanTurnsSchema = z
  .number()
  .int()
  .min(LOREBOOK_LIMITS.scanTurnsMin)
  .max(LOREBOOK_LIMITS.scanTurnsMax);
const LoreEntryTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(LOREBOOK_LIMITS.titleChars);
const LoreEntryContentSchema = z
  .string()
  .min(1)
  .max(LOREBOOK_LIMITS.contentChars)
  .refine((content) => content.trim().length > 0, "Lore content is required");
const LoreKeySchema = z.string().trim().min(1).max(LOREBOOK_LIMITS.keyChars);
const LoreKeysSchema = z
  .array(LoreKeySchema)
  .max(LOREBOOK_LIMITS.keysPerEntry)
  .superRefine((keys, context) => {
    const normalized = new Set<string>();
    for (const [index, key] of keys.entries()) {
      const comparable = key.normalize("NFKC").toLowerCase();
      if (normalized.has(comparable)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Lore entry keys must be unique after normalization",
        });
      }
      normalized.add(comparable);
    }
  });
const PrioritySchema = z
  .number()
  .int()
  .min(LOREBOOK_LIMITS.priorityMin)
  .max(LOREBOOK_LIMITS.priorityMax);

export const LorebookSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    name: LorebookNameSchema,
    description: LorebookDescriptionSchema,
    enabledGlobally: z.boolean(),
    scanTurns: ScanTurnsSchema,
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    version: VersionSchema,
  })
  .strict();

export const LoreEntrySchema = z
  .object({
    id: IdSchema,
    lorebookId: IdSchema,
    title: LoreEntryTitleSchema,
    content: LoreEntryContentSchema,
    keys: LoreKeysSchema,
    constant: z.boolean(),
    priority: PrioritySchema,
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    version: VersionSchema,
  })
  .strict()
  .superRefine(requireTriggerKeys);

export const LorebookDetailSchema = z
  .object({
    lorebook: LorebookSchema,
    entries: z.array(LoreEntrySchema).max(LOREBOOK_LIMITS.entriesPerBook),
  })
  .strict();

export const CreateLorebookRequestSchema = z
  .object({
    name: LorebookNameSchema,
    description: LorebookDescriptionSchema.default(null),
    enabledGlobally: z.boolean().default(false),
    scanTurns: ScanTurnsSchema.default(24),
    enabled: z.boolean().default(true),
  })
  .strict();

export const UpdateLorebookRequestSchema = z
  .object({
    name: LorebookNameSchema,
    description: LorebookDescriptionSchema,
    enabledGlobally: z.boolean(),
    scanTurns: ScanTurnsSchema,
    enabled: z.boolean(),
    expectedVersion: VersionSchema,
  })
  .strict();

export const CreateLoreEntryRequestSchema = z
  .object({
    title: LoreEntryTitleSchema,
    content: LoreEntryContentSchema,
    keys: LoreKeysSchema.default([]),
    constant: z.boolean().default(false),
    priority: PrioritySchema.default(0),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine(requireTriggerKeys);

export const UpdateLoreEntryRequestSchema = z
  .object({
    title: LoreEntryTitleSchema,
    content: LoreEntryContentSchema,
    keys: LoreKeysSchema,
    constant: z.boolean(),
    priority: PrioritySchema,
    enabled: z.boolean(),
    expectedVersion: VersionSchema,
  })
  .strict()
  .superRefine(requireTriggerKeys);

export const DeleteLorebookRequestSchema = z
  .object({ expectedVersion: VersionSchema })
  .strict();
export const DeleteLoreEntryRequestSchema = z
  .object({ expectedVersion: VersionSchema })
  .strict();

export const ReplaceLorebookBindingsRequestSchema = z
  .object({
    lorebookIds: z
      .array(IdSchema)
      .max(LOREBOOK_LIMITS.booksPerBinding)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Lorebook bindings must be unique",
      ),
    expectedVersion: VersionSchema,
  })
  .strict();

export const LorebookBindingStateSchema = z
  .object({
    targetId: IdSchema,
    lorebookIds: z
      .array(IdSchema)
      .max(LOREBOOK_LIMITS.booksPerBinding)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Lorebook bindings must be unique",
      ),
    version: VersionSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const LoreScopeSchema = z.enum(["project", "persona", "session"]);
export const LoreActivationDecisionStatusSchema = z.enum([
  "activated-constant",
  "activated-key",
  "excluded-disabled",
  "excluded-scope",
  "excluded-no-match",
  "excluded-budget",
]);
export const LoreActivationDecisionSchema = z
  .object({
    entryId: IdSchema,
    scope: LoreScopeSchema,
    status: LoreActivationDecisionStatusSchema,
    matchedKeys: z.array(LoreKeySchema).max(LOREBOOK_LIMITS.keysPerEntry),
  })
  .strict();
export const ActivatedLoreEntrySchema = z
  .object({
    entryId: IdSchema,
    lorebookId: IdSchema,
    scope: LoreScopeSchema,
    title: LoreEntryTitleSchema,
    content: LoreEntryContentSchema,
    priority: PrioritySchema,
    matchedKeys: z.array(LoreKeySchema).max(LOREBOOK_LIMITS.keysPerEntry),
  })
  .strict();
export const LoreActivationCandidateSchema = z
  .object({
    lorebook: LorebookSchema,
    entry: LoreEntrySchema,
    scope: LoreScopeSchema,
    scopeId: IdSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.entry.lorebookId !== candidate.lorebook.id) {
      context.addIssue({
        code: "custom",
        path: ["entry", "lorebookId"],
        message: "Lore activation entry must belong to its Lorebook",
      });
    }
  });
export const ActivateLoreEntriesInputSchema = z
  .object({
    projectId: IdSchema,
    personaId: IdSchema,
    sessionId: IdSchema,
    recentTurns: z
      .array(z.string().max(LOREBOOK_LIMITS.contentChars))
      .max(LOREBOOK_LIMITS.scanTurnsMax),
    authorInput: z.string().max(LOREBOOK_LIMITS.contentChars).nullable(),
    budgetChars: z
      .number()
      .int()
      .min(0)
      .max(LOREBOOK_LIMITS.activationBudgetChars),
    candidates: z
      .array(LoreActivationCandidateSchema)
      .max(LOREBOOK_LIMITS.activationCandidates),
  })
  .strict();
export const LoreActivationResultSchema = z
  .object({
    activated: z
      .array(ActivatedLoreEntrySchema)
      .max(LOREBOOK_LIMITS.activationCandidates),
    decisions: z
      .array(LoreActivationDecisionSchema)
      .max(LOREBOOK_LIMITS.activationCandidates),
    usedChars: z
      .number()
      .int()
      .min(0)
      .max(LOREBOOK_LIMITS.activationBudgetChars),
  })
  .strict();

export const CharacterCardV3LoreEntrySchema = z
  .object({
    keys: z
      .array(z.string().max(LOREBOOK_LIMITS.keyChars))
      .max(LOREBOOK_LIMITS.keysPerEntry),
    content: z.string().max(LOREBOOK_LIMITS.contentChars),
    extensions: JsonObjectSchema,
    enabled: z.boolean(),
    insertion_order: z.number(),
    use_regex: z.boolean(),
    case_sensitive: z.boolean().optional(),
    constant: z.boolean().optional(),
    name: z.string().max(LOREBOOK_LIMITS.titleChars).optional(),
    priority: z.number().optional(),
    id: z.union([z.string().max(300), z.number()]).optional(),
    comment: z.string().max(LOREBOOK_LIMITS.descriptionChars).optional(),
    selective: z.boolean().optional(),
    secondary_keys: z
      .array(z.string().max(LOREBOOK_LIMITS.keyChars))
      .max(LOREBOOK_LIMITS.keysPerEntry)
      .optional(),
    position: z.enum(["before_char", "after_char"]).optional(),
  })
  .strict();

export const CharacterCardV3LorebookSchema = z
  .object({
    name: z.string().max(LOREBOOK_LIMITS.nameChars).optional(),
    description: z.string().max(LOREBOOK_LIMITS.descriptionChars).optional(),
    scan_depth: z.number().nonnegative().optional(),
    token_budget: z.number().nonnegative().optional(),
    recursive_scanning: z.boolean().optional(),
    extensions: JsonObjectSchema,
    entries: z
      .array(CharacterCardV3LoreEntrySchema)
      .max(LOREBOOK_LIMITS.entriesPerBook),
  })
  .strict();

export type LorebookDto = z.infer<typeof LorebookSchema>;
export type LoreEntryDto = z.infer<typeof LoreEntrySchema>;
export type LorebookDetailDto = z.infer<typeof LorebookDetailSchema>;
export type CreateLorebookRequest = z.infer<typeof CreateLorebookRequestSchema>;
export type UpdateLorebookRequest = z.infer<typeof UpdateLorebookRequestSchema>;
export type CreateLoreEntryRequest = z.infer<
  typeof CreateLoreEntryRequestSchema
>;
export type UpdateLoreEntryRequest = z.infer<
  typeof UpdateLoreEntryRequestSchema
>;
export type ReplaceLorebookBindingsRequest = z.infer<
  typeof ReplaceLorebookBindingsRequestSchema
>;
export type LorebookBindingStateDto = z.infer<
  typeof LorebookBindingStateSchema
>;
export type LoreScope = z.infer<typeof LoreScopeSchema>;
export type LoreActivationDecisionStatus = z.infer<
  typeof LoreActivationDecisionStatusSchema
>;
export type LoreActivationDecisionDto = z.infer<
  typeof LoreActivationDecisionSchema
>;
export type ActivatedLoreEntryDto = z.infer<typeof ActivatedLoreEntrySchema>;
export type LoreActivationCandidateDto = z.infer<
  typeof LoreActivationCandidateSchema
>;
export type ActivateLoreEntriesInputDto = z.infer<
  typeof ActivateLoreEntriesInputSchema
>;
export type LoreActivationResultDto = z.infer<
  typeof LoreActivationResultSchema
>;
export type CharacterCardV3LoreEntry = z.infer<
  typeof CharacterCardV3LoreEntrySchema
>;
export type CharacterCardV3Lorebook = z.infer<
  typeof CharacterCardV3LorebookSchema
>;

function requireTriggerKeys(
  entry: { constant: boolean; keys: readonly string[] },
  context: z.RefinementCtx,
): void {
  if (entry.constant || entry.keys.length > 0) return;
  context.addIssue({
    code: "custom",
    path: ["keys"],
    message: "A non-constant Lore entry requires at least one key",
  });
}
