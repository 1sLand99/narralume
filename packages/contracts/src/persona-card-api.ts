import { z } from "zod";

import { PERSONA_CARD_LIMITS } from "./persona-card.js";

const IdSchema = z.string().trim().min(1).max(300);
const FilenameSchema = z.string().trim().min(1).max(260);
const NameOverrideSchema = z.string().trim().min(1).max(200).optional();

export const PersonaCardImportTargetSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("create"),
      kind: z.enum(["character", "narrator"]).default("character"),
      entityId: IdSchema.nullable().default(null),
      nameOverride: NameOverrideSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("replace"),
      personaId: IdSchema,
      expectedVersion: z.number().int().nonnegative(),
      entityId: IdSchema.nullable().optional(),
      nameOverride: NameOverrideSchema,
    })
    .strict(),
]);

const PersonaCardImportRequestBaseSchema = z.object({
  requestId: IdSchema,
  filename: FilenameSchema,
  target: PersonaCardImportTargetSchema,
});

export const ImportPersonaCardJsonRequestSchema =
  PersonaCardImportRequestBaseSchema.extend({
    contentBase64: z
      .string()
      .min(1)
      .max(maxBase64Characters(PERSONA_CARD_LIMITS.jsonBytes)),
  }).strict();

export const ImportPersonaCardPngRequestSchema =
  PersonaCardImportRequestBaseSchema.extend({
    contentBase64: z
      .string()
      .min(1)
      .max(maxBase64Characters(PERSONA_CARD_LIMITS.pngBytes)),
  }).strict();

export type PersonaCardImportTarget = z.infer<
  typeof PersonaCardImportTargetSchema
>;
export type ImportPersonaCardJsonRequest = z.infer<
  typeof ImportPersonaCardJsonRequestSchema
>;
export type ImportPersonaCardPngRequest = z.infer<
  typeof ImportPersonaCardPngRequestSchema
>;

function maxBase64Characters(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}
